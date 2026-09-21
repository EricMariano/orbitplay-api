import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { toBuildView } from '../builds/build-view.mapper';
import { BuildsRepository } from '../builds/builds.repository';
import { GamesService } from '../games/games.service';
import type { TestModelView } from '../test-models/dto/test-model.dto';
import { TestModelsService } from '../test-models/test-models.service';
import { newId } from '../../infra/database/schema/_helpers';
import type { TestAudienceCriteriaRow, TestRow } from '../../infra/database/schema/tests';
import { buildValidateJobId, JobName } from '../../infra/queue/queue.constants';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import { QUEUE_PORT, type QueuePort } from '../../shared/ports/queue.port';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import {
  BUILD_UPLOAD_TTL_SECONDS,
  MAX_BUILD_BYTES,
  WIZARD_STEP_NUMBER,
  type AudienceRequest,
  type AudienceView,
  type BuildUploadUrlRequest,
  type BuildView,
  type ConfirmBuildRequest,
  type CreateTestRequest,
  type FormQuestionInput,
  type PendingValidationView,
  type SetModelRequest,
  type SetStatusRequest,
  type TestFormView,
  type TestListQuery,
  type TestStatusValue,
  type TestView,
  type BuildUploadUrlResponse,
  type WizardStepValue,
} from './dto/test.dto';
import { buildBuildStorageKey, parseBuildStorageKey } from './storage-key';
import { type FormQuestionWithOptions, TestsRepository } from './tests.repository';

const BUILD_STEP_KEYS = ['checksum', 'malware_scan', 'metadata'] as const;

const STATUS_TRANSITIONS: Partial<Record<TestStatusValue, TestStatusValue[]>> = {
  published: ['paused', 'finished'],
  paused: ['published', 'finished'],
};

const STEP_ORDER: readonly WizardStepValue[] = ['model', 'form', 'build', 'audience', 'review'];

@Injectable()
export class TestsService {
  private readonly logger = new Logger(TestsService.name);

  constructor(
    private readonly repo: TestsRepository,
    private readonly builds: BuildsRepository,
    private readonly games: GamesService,
    private readonly testModels: TestModelsService,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  async create(
    organizationId: string,
    gameId: string,
    dto: CreateTestRequest,
    req: Request,
  ): Promise<TestView> {
    const gameExists = await this.games.existsInOrg(organizationId, gameId);
    if (!gameExists) throw AppException.notFound('Jogo não encontrado');

    const model = this.requireAvailableModel(dto.testModelKey);

    const row = await this.repo.createInOrg(organizationId, {
      gameId,
      name: dto.title ?? null,
      modelKey: model.key,
      status: 'draft',
      currentStep: 'form',
      slotsTotal: 0,
      slotsTaken: 0,
      reportStage: 'none',
    });

    const view = await this.toView(row);
    recordAudit(req, {
      action: 'test.created',
      entity: 'tests',
      entityId: row.id,
      before: null,
      after: view,
    });
    return view;
  }

  async get(organizationId: string, id: string): Promise<TestView> {
    const row = await this.repo.getByIdInOrgOrThrow(organizationId, id);
    return this.toView(row);
  }

  /** GET /games/:id/tests (Tela 05, M3's loose end — see DECISIONS.md §3). */
  async listByGame(
    organizationId: string,
    gameId: string,
    query: TestListQuery,
  ): Promise<{ data: TestView[]; nextCursor: string | null }> {
    const gameExists = await this.games.existsInOrg(organizationId, gameId);
    if (!gameExists) throw AppException.notFound('Jogo não encontrado');

    const page = await this.repo.listByGameInOrg(organizationId, gameId, query);
    const data = await Promise.all(page.data.map((row) => this.toView(row)));
    return { data, nextCursor: page.nextCursor };
  }

  async setModel(
    organizationId: string,
    id: string,
    dto: SetModelRequest,
    req: Request,
  ): Promise<TestView> {
    const model = this.requireAvailableModel(dto.testModelKey);

    const { before, updated } = await this.repo.withRowLock(
      organizationId,
      id,
      async (test, updateTest) => {
        this.assertDraft(test);
        const updated = await updateTest({
          modelKey: model.key,
          currentStep: this.advance(test.currentStep, 'form'),
        });
        return { before: test, updated };
      },
    );

    const view = await this.toView(updated);
    recordAudit(req, {
      action: 'test.model.set',
      entity: 'tests',
      entityId: id,
      before: { modelKey: before.modelKey },
      after: { modelKey: updated.modelKey },
    });
    return view;
  }

  async putForm(
    organizationId: string,
    id: string,
    questions: FormQuestionInput[],
    req: Request,
  ): Promise<TestFormView> {
    const saved = await this.repo.withRowLock(organizationId, id, async (test, updateTest) => {
      this.assertDraft(test);
      const saved = await this.repo.replaceForm(id, questions);
      await updateTest({ currentStep: this.advance(test.currentStep, 'build') });
      return saved;
    });

    recordAudit(req, {
      action: 'test.form.updated',
      entity: 'tests',
      entityId: id,
      before: null,
      after: { questionCount: saved.length },
    });
    return { testId: id, questions: saved.map(toQuestionView) };
  }

  async formPreview(organizationId: string, id: string): Promise<TestFormView> {
    await this.repo.getByIdInOrgOrThrow(organizationId, id);
    const questions = await this.repo.findFormQuestions(id);
    return { testId: id, questions: questions.map(toQuestionView) };
  }

  async createBuildUploadUrl(
    organizationId: string,
    id: string,
    dto: BuildUploadUrlRequest,
  ): Promise<BuildUploadUrlResponse> {
    const test = await this.repo.getByIdInOrgOrThrow(organizationId, id);
    this.assertDraft(test);

    const buildId = newId();
    const storageKey = buildBuildStorageKey(organizationId, id, buildId, dto.fileName);
    const uploadUrl = await this.storage.createUploadUrl(
      storageKey,
      dto.contentType,
      dto.sizeBytes,
      BUILD_UPLOAD_TTL_SECONDS,
    );

    return {
      uploadUrl,
      storageKey,
      expiresAt: new Date(Date.now() + BUILD_UPLOAD_TTL_SECONDS * 1000).toISOString(),
      maxSizeBytes: MAX_BUILD_BYTES,
    };
  }

  /**
   * RN-01 (Tela 08): only confirmed once the object is actually in storage.
   * A previous `failed` build is replaced automatically (RN-05 — failure
   * preserves the rest of the wizard and allows a retry); a `processing`/
   * `validated` one must be removed first via DELETE (explicit swap).
   */
  async confirmBuild(
    organizationId: string,
    id: string,
    dto: ConfirmBuildRequest,
    req: Request,
  ): Promise<BuildView> {
    const parsed = parseBuildStorageKey(dto.storageKey);
    if (!parsed || parsed.organizationId !== organizationId || parsed.testId !== id) {
      throw AppException.validation('storageKey não pertence a este teste', {
        storageKey: 'Chave de storage inválida para este teste',
      });
    }

    const result = await this.repo.withRowLock(organizationId, id, async (test, updateTest) => {
      this.assertDraft(test);

      const existing = await this.builds.findLatestBuild(id);
      if (existing) {
        if (existing.build.status === 'failed') {
          await this.builds.deleteBuild(existing.build.id);
        } else {
          throw AppException.conflict(
            'Já existe uma build para este teste — remova antes de enviar outra',
          );
        }
      }

      const meta = await this.storage.stat(dto.storageKey);
      if (!meta) {
        throw AppException.validation('Objeto ausente no storage', {
          storageKey: 'Upload não encontrado — envie o arquivo antes de confirmar',
        });
      }
      if (meta.sizeBytes < 1 || meta.sizeBytes > MAX_BUILD_BYTES) {
        // Reject without leaving the oversized object behind (SEC-06) —
        // the signed Content-Length should already stop this at upload
        // time, but a rejected object here must never linger either.
        await this.storage.remove(dto.storageKey).catch(() => undefined);
        throw AppException.validation('Tamanho de build inválido', {
          sizeBytes: `Tamanho deve ficar entre 1 e ${MAX_BUILD_BYTES} bytes`,
        });
      }

      const created = await this.builds.createBuildWithSteps(
        {
          id: parsed.buildId,
          organizationId,
          testId: id,
          fileName: parsed.fileName,
          version: dto.version ?? null,
          platform: dto.platform,
          sizeBytes: meta.sizeBytes,
          checksum: dto.checksum ?? null,
          storageKey: dto.storageKey,
          status: 'processing',
        },
        BUILD_STEP_KEYS,
      );

      await updateTest({ currentStep: this.advance(test.currentStep, 'audience') });

      return created;
    });

    // OPS-01: the insert and the enqueue are two separate operations with no
    // shared transaction — if this fails, the row must not linger silently
    // in "processing" forever. Surface it as `failed` right away, which
    // reuses the wizard's existing "a failed build is replaced
    // automatically on retry" rule, so the client's natural retry recovers
    // on its own. `ensureEnqueued`'s deterministic id also makes this
    // safe if a reconciliation sweep or a client retry races it later.
    try {
      await this.queue.ensureEnqueued(JobName.BUILD_VALIDATE, buildValidateJobId(result.build.id), {
        buildId: result.build.id,
      });
    } catch (err) {
      result.build = await this.builds.markBuildFailed(
        result.build.id,
        'Falha ao agendar validação — tente reenviar a build',
      );
      this.logger.error(`failed to enqueue build.validate for ${result.build.id}: ${String(err)}`);
    }

    recordAudit(req, {
      action: 'test.build.confirmed',
      entity: 'tests',
      entityId: id,
      before: null,
      after: { buildId: result.build.id },
    });
    return toBuildView(result);
  }

  async getBuild(organizationId: string, id: string): Promise<BuildView> {
    await this.repo.getByIdInOrgOrThrow(organizationId, id);
    const build = await this.builds.findLatestBuild(id);
    if (!build) throw AppException.notFound('Este teste ainda não tem build enviada');
    return toBuildView(build);
  }

  async deleteBuild(organizationId: string, id: string, req: Request): Promise<void> {
    const test = await this.repo.getByIdInOrgOrThrow(organizationId, id);
    if (test.status === 'published') {
      throw AppException.conflict('Teste já publicado — build não pode ser trocada');
    }
    const existing = await this.builds.findLatestBuild(id);
    if (!existing) throw AppException.notFound('Este teste ainda não tem build enviada');

    await this.builds.deleteBuild(existing.build.id);
    await this.storage.remove(existing.build.storageKey).catch(() => undefined);
    await this.repo.updateByIdInOrg(organizationId, id, { currentStep: 'build' });

    recordAudit(req, {
      action: 'test.build.removed',
      entity: 'tests',
      entityId: id,
      before: { buildId: existing.build.id },
      after: null,
    });
  }

  async setAudience(
    organizationId: string,
    id: string,
    dto: AudienceRequest,
    req: Request,
  ): Promise<TestView> {
    const minBirthdate = dateYearsAgo(dto.ageMax + 1);
    const maxBirthdate = dateYearsAgo(dto.ageMin);
    const eligible = await this.repo.countEligiblePlayers(minBirthdate, maxBirthdate);
    const estimatedReach = Math.min(dto.quantity, eligible);

    const updated = await this.repo.withRowLock(organizationId, id, async (test, updateTest) => {
      this.assertDraft(test);

      await this.repo.upsertAudience(id, {
        countries: dto.locations ?? [],
        archetypes: dto.archetypes ?? [],
        platforms: dto.deviceRequirements ?? [],
        ageMin: dto.ageMin,
        ageMax: dto.ageMax,
        testerCount: dto.quantity,
        keepActive: dto.keepActive ?? false,
        estimatedReach,
      });

      return updateTest({
        durationDays: dto.durationDays,
        currentStep: this.advance(test.currentStep, 'review'),
      });
    });

    const view = await this.toView(updated);
    recordAudit(req, {
      action: 'test.audience.updated',
      entity: 'tests',
      entityId: id,
      before: null,
      after: { estimatedReach },
    });
    return view;
  }

  /**
   * RN-02 (Tela 10): `Idempotency-Key` is mandatory here (unlike other
   * mutations, where it's opt-in) — reloading must never create a second
   * test. Once published, repeating the call just returns the current state,
   * whatever key is sent; the UNIQUE on `publish_idempotency_key` is the
   * last line of defense under concurrency.
   */
  async publish(
    organizationId: string,
    id: string,
    idempotencyKey: string | undefined,
    req: Request,
  ): Promise<TestView> {
    if (!idempotencyKey) {
      throw AppException.validation('Idempotency-Key é obrigatório para publicar', {
        'Idempotency-Key': 'Cabeçalho obrigatório',
      });
    }

    let result: { test: TestRow; justPublished: boolean };
    try {
      result = await this.repo.withRowLock(organizationId, id, async (test, updateTest) => {
        if (test.status === 'published') {
          return { test, justPublished: false };
        }
        if (test.status !== 'draft') {
          throw AppException.conflict('Teste não está em rascunho');
        }

        const pending = await this.pendingValidationsFor(test);
        if (pending.length > 0) {
          throw AppException.validation(
            'Etapas pendentes para publicar',
            Object.fromEntries(pending.map((p) => [p.code, p.message])),
          );
        }

        const now = new Date();
        const durationDays = test.durationDays ?? 0;
        const endsAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

        const updated = await updateTest({
          status: 'published',
          currentStep: 'review',
          publishedAt: now,
          startsAt: now,
          endsAt,
          publishIdempotencyKey: idempotencyKey,
        });

        return { test: updated, justPublished: true };
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const current = await this.repo.getByIdInOrgOrThrow(organizationId, id);
        return this.toView(current);
      }
      throw err;
    }

    const view = await this.toView(result.test);
    if (result.justPublished) {
      recordAudit(req, {
        action: 'test.published',
        entity: 'tests',
        entityId: id,
        before: { status: 'draft' },
        after: { status: result.test.status },
      });
    }
    return view;
  }

  async setStatus(
    organizationId: string,
    id: string,
    dto: SetStatusRequest,
    req: Request,
  ): Promise<TestView> {
    const test = await this.repo.getByIdInOrgOrThrow(organizationId, id);
    const allowed = STATUS_TRANSITIONS[test.status] ?? [];
    if (!allowed.includes(dto.status)) {
      throw AppException.conflict(`Não é possível mudar de "${test.status}" para "${dto.status}"`);
    }

    const updated = await this.repo.updateByIdInOrg(organizationId, id, { status: dto.status });
    const view = await this.toView(updated);
    recordAudit(req, {
      action: 'test.status.changed',
      entity: 'tests',
      entityId: id,
      before: { status: test.status },
      after: { status: updated.status },
    });
    return view;
  }

  private requireAvailableModel(key: string): TestModelView {
    const model = this.testModels.get(key);
    if (!model.available) {
      throw AppException.validation('Modelo de teste indisponível', {
        testModelKey: model.unavailableReason ?? 'Modelo indisponível nesta fase',
      });
    }
    return model;
  }

  private assertDraft(test: TestRow): void {
    if (test.status !== 'draft') {
      throw AppException.conflict('Esta etapa só pode ser editada enquanto o teste é um rascunho');
    }
  }

  /** Wizard progress only ever moves forward on success — data already saved is never re-asked for. */
  private advance(current: WizardStepValue, atLeast: WizardStepValue): WizardStepValue {
    return STEP_ORDER.indexOf(atLeast) > STEP_ORDER.indexOf(current) ? atLeast : current;
  }

  private async pendingValidationsFor(test: TestRow): Promise<PendingValidationView[]> {
    const pending: PendingValidationView[] = [];

    const model = this.testModels.get(test.modelKey);
    if (!model.available) {
      pending.push({
        step: 1,
        code: 'MODEL_UNAVAILABLE',
        message: model.unavailableReason ?? 'Modelo indisponível',
      });
    }

    const questions = await this.repo.findFormQuestions(test.id);
    if (questions.length === 0) {
      pending.push({ step: 2, code: 'FORM_EMPTY', message: 'Formulário sem perguntas' });
    }

    // GAP-03: only models that actually need a playable build gate publish
    // on one — ab_test_images compares static images and is explicitly
    // advertised as not requiring a build (test-models.catalog.ts).
    if (model.requiresBuild) {
      const buildWithSteps = await this.builds.findLatestBuild(test.id);
      if (!buildWithSteps || buildWithSteps.build.status !== 'validated') {
        pending.push({
          step: 3,
          code: 'BUILD_NOT_VALIDATED',
          message: buildWithSteps?.build.failureReason ?? 'Build ainda não validada',
        });
      }
    }

    const audience = await this.repo.findAudience(test.id);
    if (!audience || !audience.estimatedReach || audience.estimatedReach <= 0) {
      pending.push({
        step: 4,
        code: 'AUDIENCE_NOT_CONFIGURED',
        message: 'Público elegível insuficiente ou não configurado',
      });
    }

    return pending;
  }

  private async toView(test: TestRow): Promise<TestView> {
    const [audience, build, pendingValidations] = await Promise.all([
      this.repo.findAudience(test.id),
      this.builds.findLatestBuild(test.id),
      this.pendingValidationsFor(test),
    ]);

    return {
      id: test.id,
      gameId: test.gameId,
      organizationId: test.organizationId,
      title: test.name,
      status: test.status,
      testModelKey: test.modelKey,
      currentStep: WIZARD_STEP_NUMBER[test.currentStep],
      pendingValidations,
      audience: audience ? toAudienceView(audience, test.durationDays) : null,
      build: build ? toBuildView(build) : null,
      spotsTotal: test.slotsTotal,
      spotsTaken: test.slotsTaken,
      rewardCents: test.rewardAmountCents,
      expiresAt: test.endsAt ? test.endsAt.toISOString() : null,
      publishedAt: test.publishedAt ? test.publishedAt.toISOString() : null,
      createdAt: test.createdAt.toISOString(),
      updatedAt: test.updatedAt.toISOString(),
    };
  }
}

function toQuestionView(q: FormQuestionWithOptions) {
  return {
    id: q.id,
    type: q.type,
    prompt: q.label,
    helpText: q.helpText,
    required: q.required,
    position: q.position,
    options: q.options.map((o) => ({ id: o.id, label: o.label, position: o.position })),
    scaleMin: q.scaleMin,
    scaleMax: q.scaleMax,
  };
}

function toAudienceView(row: TestAudienceCriteriaRow, durationDays: number | null): AudienceView {
  return {
    locations: row.countries ?? [],
    archetypes: row.archetypes ?? [],
    ageMin: row.ageMin ?? 18,
    ageMax: row.ageMax ?? 18,
    quantity: row.testerCount ?? 0,
    durationDays: durationDays ?? 0,
    deviceRequirements: (row.platforms ?? []) as AudienceView['deviceRequirements'],
    keepActive: row.keepActive,
    estimatedReach: row.estimatedReach ?? 0,
  };
}

/** UTC `YYYY-MM-DD` for `years` years before today — matches the `date` column's string mode. */
function dateYearsAgo(years: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const causeCode = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505' || causeCode === '23505';
}
