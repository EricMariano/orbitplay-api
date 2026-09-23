import { Injectable } from '@nestjs/common';
import { toBuildView } from '../builds/build-view.mapper';
import { BuildsRepository } from '../builds/builds.repository';
import { AppException } from '../../shared/errors/app.exception';
import type { ParticipationRow } from '../../infra/database/schema/participations';
import type { TestRow } from '../../infra/database/schema/tests';
import type { ConsentRecordView, ConsentRequest, TutorialView } from './dto/consent.dto';
import type { ParticipationView } from './dto/participation.dto';
import type { ParticipationResultView } from './dto/session.dto';
import { ParticipationsRepository } from './participations.repository';
import { tutorialForModel } from './tutorial.catalog';

@Injectable()
export class ParticipationsService {
  constructor(
    private readonly repo: ParticipationsRepository,
    private readonly builds: BuildsRepository,
  ) {}

  /**
   * Tela 14 RN-02: reserves the slot server-side, re-validating everything
   * the feed already filtered for, because the test's state may have moved
   * since then.
   *
   * `Idempotency-Key` replay ("repetição devolve a existente") is handled
   * generically by the global `IdempotencyInterceptor` (caches the whole
   * response by key). What's left here is the "no key, second request → 409"
   * half of RN-02, which the partial UNIQUE on
   * `participations_active_test_user_unique` already guarantees — a second
   * concurrent reservation attempt collides on it and rolls back the slot
   * increment with it (see `ParticipationsRepository.reserveParticipation`).
   *
   * Device compatibility isn't checked: this route's request has no body to
   * carry a device profile (that's `StartSessionRequest`, M7-04). Country/
   * archetype eligibility (`test_audience_criteria.countries`/`archetypes`)
   * also isn't checked — the player schema has no such columns yet (same stub
   * pattern `TestsRepository.countEligiblePlayers` already documents for the
   * reach estimate). Only the age bracket is enforced, since `users.birthdate`
   * already exists.
   */
  async join(testId: string, userId: string): Promise<ParticipationView> {
    const test = await this.repo.findTestById(testId);
    if (!test) throw AppException.notFound('Teste não encontrado');

    if (test.status !== 'published') {
      throw AppException.conflict('Teste não está aberto para participação');
    }
    if (test.endsAt && test.endsAt.getTime() <= Date.now()) {
      throw AppException.conflict('Teste expirado');
    }

    await this.assertAgeEligible(testId, userId);

    let row: ParticipationRow;
    try {
      row = await this.repo.reserveParticipation(testId, userId);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw AppException.conflict('Já existe uma participação ativa neste teste');
      }
      throw err;
    }

    return this.toView(row, test);
  }

  /** 403 (Forbidden), not 409: this is a mismatch with who the player is, not with the test's state. */
  private async assertAgeEligible(testId: string, userId: string): Promise<void> {
    const range = await this.repo.findAudienceAgeRange(testId);
    if (!range || (range.ageMin == null && range.ageMax == null)) return;

    const birthdate = await this.repo.findUserBirthdate(userId);
    if (!birthdate) return; // nothing to compare against — don't block on missing data

    const minBirthdate = range.ageMax != null ? dateYearsAgo(range.ageMax + 1) : null;
    const maxBirthdate = range.ageMin != null ? dateYearsAgo(range.ageMin) : null;
    const tooOld = minBirthdate != null && birthdate < minBirthdate;
    const tooYoung = maxBirthdate != null && birthdate > maxBirthdate;
    if (tooOld || tooYoung) {
      throw AppException.forbidden('Fora da faixa etária deste teste');
    }
  }

  async get(id: string, userId: string): Promise<ParticipationView> {
    const row = await this.repo.getByIdForUserOrThrow(id, userId);
    const test = await this.repo.findTestById(row.testId);
    if (!test) throw AppException.notFound();
    return this.toView(row, test);
  }

  /** Tela 16 RN-01: tutorial content follows the test's MODEL, not the game. */
  async tutorial(id: string, userId: string): Promise<TutorialView> {
    const participation = await this.repo.getByIdForUserOrThrow(id, userId);
    const test = await this.repo.findTestById(participation.testId);
    if (!test) throw AppException.notFound();
    return tutorialForModel(test.modelKey);
  }

  /**
   * Tela 16 RN-02 / Tela 17 RN-01: consent is legal proof, recorded
   * server-side with who/what/when/IP — never inferred from client state. A
   * required consent (per the model's tutorial) that comes back `granted:
   * false` is a 422, not a soft warning: recording can never legally start
   * without it.
   */
  async consents(
    id: string,
    userId: string,
    dto: ConsentRequest,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<ConsentRecordView> {
    const participation = await this.repo.getByIdForUserOrThrow(id, userId);
    const test = await this.repo.findTestById(participation.testId);
    if (!test) throw AppException.notFound();

    const tutorial = tutorialForModel(test.modelKey);
    const grantedByKind = new Map(dto.consents.map((c) => [c.kind, c.granted]));
    const missingRequired = tutorial.requiredConsents.filter(
      (kind) => grantedByKind.get(kind) !== true,
    );
    if (missingRequired.length > 0) {
      throw AppException.validation('Consentimento obrigatório recusado', {
        consents: `Obrigatórios não concedidos: ${missingRequired.join(', ')}`,
      });
    }

    const saved = await this.repo.upsertConsent(id, dto.consents, meta);
    return {
      participationId: id,
      consents: dto.consents,
      recordedAt: (saved.acceptedAt ?? new Date()).toISOString(),
      allRequiredGranted: true,
    };
  }

  /**
   * Tela 19 RN-01/02/03: XP/nota/conquistas só existem depois que
   * `session.validate` roda (M7-06) — enquanto isso, leitura pura de
   * `in_review` com valores nulos, nunca um placeholder fabricado.
   */
  async result(id: string, userId: string): Promise<ParticipationResultView> {
    const participation = await this.repo.getByIdForUserOrThrow(id, userId);
    const sessionId = await this.repo.findOpenOrLastSessionId(id);
    const validation = sessionId ? await this.repo.findSessionValidation(sessionId) : null;

    if (!validation || !sessionId) {
      return {
        status: 'in_review',
        xpEarned: null,
        rating: null,
        rewardCents: null,
        rewardStatus: 'pending',
        invalidReason: null,
      };
    }

    if (!validation.valid) {
      return {
        status: 'rejected',
        xpEarned: null,
        rating: null,
        rewardCents: null,
        rewardStatus: 'pending',
        invalidReason: validation.reason,
      };
    }

    const [test, xp] = await Promise.all([
      this.repo.findTestById(participation.testId),
      this.repo.sumXpForSession(sessionId),
    ]);

    return {
      status: 'completed',
      xpEarned: xp,
      rating: null,
      rewardCents: test?.rewardAmountCents ?? null,
      rewardStatus: 'pending',
      invalidReason: null,
    };
  }

  private async toView(row: ParticipationRow, test: TestRow): Promise<ParticipationView> {
    const [buildWithSteps, consent, openSessionId, startedSession, completedSession] =
      await Promise.all([
        this.builds.findLatestBuild(test.id),
        this.repo.findConsent(row.id),
        this.repo.findOpenSessionId(row.id),
        this.repo.findFirstSessionStartedAt(row.id),
        row.status === 'completed'
          ? this.repo.findLastSessionEndedAt(row.id)
          : Promise.resolve(null),
      ]);

    return {
      id: row.id,
      testId: row.testId,
      gameId: test.gameId,
      status: row.status,
      currentSessionId: openSessionId,
      resumePoint: row.resumePoint,
      consentsGranted: consent?.acceptedAt != null,
      build: buildWithSteps ? toBuildView(buildWithSteps) : null,
      startedAt: startedSession ? startedSession.toISOString() : null,
      completedAt: completedSession ? completedSession.toISOString() : null,
    };
  }
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const causeCode = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505' || causeCode === '23505';
}

/** UTC `YYYY-MM-DD` for `years` years before today — matches the `date` column's string mode. */
function dateYearsAgo(years: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate()));
  return d.toISOString().slice(0, 10);
}
