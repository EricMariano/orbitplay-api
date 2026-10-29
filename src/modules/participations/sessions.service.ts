import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { sessionValidateJobId, JobName } from '../../infra/queue/queue.constants';
import { AppException } from '../../shared/errors/app.exception';
import { QUEUE_PORT, type QueuePort } from '../../shared/ports/queue.port';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import { BuildsRepository } from '../builds/builds.repository';
import { GamesService } from '../games/games.service';
import type { ConsentKind } from './dto/consent.dto';
import type {
  DeviceEventRequest,
  FinishSessionRequest,
  FormResponseRequest,
  FormResponseView,
  HeartbeatRequest,
  SessionGameplayView,
  SessionStartedView,
  SessionSummaryView,
  SessionView,
  StartSessionRequest,
} from './dto/session.dto';
import { checkFormAnswers } from './form-answers';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_SECONDS, heartbeatKey } from './heartbeat.store';
import {
  ParticipationsRepository,
  type FormQuestionWithOptions,
} from './participations.repository';
import { tutorialForModel } from './tutorial.catalog';
import type { SessionRow, SessionValidationRow } from '../../infra/database/schema/participations';
import { ReportSnapshotCache } from '../../infra/database/report-snapshot-cache';

const CONSENT_FIELD_BY_KIND: Record<
  ConsentKind,
  'screenRecording' | 'audio' | 'microphone' | 'webcam'
> = {
  screen_recording: 'screenRecording',
  audio: 'audio',
  microphone: 'microphone',
  webcam: 'webcam',
};

const RECORDING_DOWNLOAD_TTL_SECONDS = 900;

@Injectable()
export class SessionsService {
  constructor(
    private readonly repo: ParticipationsRepository,
    private readonly builds: BuildsRepository,
    private readonly games: GamesService,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly reportSnapshots: ReportSnapshotCache,
  ) {}

  /**
   * Tela 16 RN-03: a session only starts once the build is `validated` and
   * every required consent (per the test's model) is on record — both
   * re-checked here, never trusted from client state.
   */
  async start(
    participationId: string,
    userId: string,
    _dto: StartSessionRequest,
  ): Promise<SessionStartedView> {
    const participation = await this.repo.getByIdForUserOrThrow(participationId, userId);
    const test = await this.repo.findTestById(participation.testId);
    if (!test) throw AppException.notFound();

    if (test.status !== 'published' && test.status !== 'paused') {
      throw AppException.conflict('Teste não está aberto para participação');
    }
    if (test.endsAt && test.endsAt.getTime() <= Date.now()) {
      throw AppException.conflict('Teste expirado');
    }

    const build = await this.builds.findLatestBuild(test.id);
    if (!build || build.build.status !== 'validated') {
      throw AppException.conflict('Build não validada');
    }

    const tutorial = tutorialForModel(test.modelKey);
    const consent = await this.repo.findConsent(participationId);
    const missing = tutorial.requiredConsents.filter(
      (kind) => !consent || !consent[CONSENT_FIELD_BY_KIND[kind]],
    );
    if (missing.length > 0) {
      throw AppException.conflict('Consentimento obrigatório ausente');
    }

    const session = await this.repo.startSession(participationId, test.id, test.organizationId);
    await this.touchHeartbeat(session.id);
    // M10: the report's evolution counts sessions by start date.
    await this.reportSnapshots.invalidate(test.id);

    return {
      sessionId: session.id,
      startedAt: session.startedAt.toISOString(),
      maxDurationMs: null,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      recordingRequired: tutorial.requiredConsents.includes('screen_recording'),
    };
  }

  /** RN-04 (Tela 17): every device change is timestamped against the session's own clock (`tMs`), for later cross-referencing with the video. */
  async recordDeviceEvent(
    sessionId: string,
    userId: string,
    dto: DeviceEventRequest,
  ): Promise<void> {
    const session = await this.repo.getSessionForUserOrThrow(sessionId, userId);
    if (isClosed(session)) throw AppException.conflict('Sessão já encerrada');
    await this.repo.insertDeviceEvent(sessionId, dto.kind, dto.tMs, dto.enabled);
  }

  async heartbeat(sessionId: string, userId: string, _dto: HeartbeatRequest): Promise<void> {
    const session = await this.repo.getSessionForUserOrThrow(sessionId, userId);
    if (isClosed(session)) throw AppException.notFound();
    await this.touchHeartbeat(sessionId);
    if (session.status === 'starting') await this.repo.markRecording(sessionId);
  }

  /**
   * RN-03 (Tela 17): `confirmed:true` in the body — required by the DTO
   * itself — guards against an accidental client-side encerrar. Enqueues
   * `session.validate` (M7-06) and hands the participation to `in_review`.
   */
  async finish(
    sessionId: string,
    userId: string,
    dto: FinishSessionRequest,
    idempotencyKey: string | undefined,
  ): Promise<SessionView> {
    const owned = await this.repo.getSessionForUserOrThrow(sessionId, userId);

    const endedAt = new Date();
    const elapsedMs = Math.max(0, endedAt.getTime() - owned.startedAt.getTime());

    const updated = await this.repo.finishSession(sessionId, owned.participationId, {
      status: 'processing',
      endedAt,
      durationMs: Math.min(dto.tMs, elapsedMs),
      finishIdempotencyKey: idempotencyKey ?? null,
    });

    await this.redis.del(heartbeatKey(sessionId));
    await this.queue.ensureEnqueued(JobName.SESSION_VALIDATE, sessionValidateJobId(sessionId), {
      sessionId,
    });
    // M10: duration and "ended without a form" (dropout) just changed.
    await this.reportSnapshots.invalidate(updated.testId);

    return this.toSessionView(updated, null);
  }

  async summary(sessionId: string, userId: string): Promise<SessionSummaryView> {
    const session = await this.repo.getSessionForUserOrThrow(sessionId, userId);
    const test = await this.repo.findTestById(session.testId);
    if (!test) throw AppException.notFound();

    const [game, questions, recording, formResponse, validation] = await Promise.all([
      this.games.getAnyOrg(test.gameId, { includeDeleted: true }),
      this.repo.findFormQuestions(test.id),
      this.repo.findPrimaryRecording(sessionId),
      this.repo.findFormResponse(sessionId),
      this.repo.findSessionValidation(sessionId),
    ]);

    return {
      session: this.toSessionView(session, validation),
      test: {
        id: test.id,
        gameId: test.gameId,
        title: test.name,
        testModelKey: test.modelKey,
        status: test.status,
        rewardCents: test.rewardAmountCents,
        expiresAt: test.endsAt ? test.endsAt.toISOString() : null,
      },
      game,
      recording: recording
        ? {
            status: recording.status,
            url:
              recording.status === 'ready'
                ? await this.storage.createDownloadUrl(
                    recording.storageKey,
                    RECORDING_DOWNLOAD_TTL_SECONDS,
                  )
                : null,
            expiresAt:
              recording.status === 'ready'
                ? new Date(Date.now() + RECORDING_DOWNLOAD_TTL_SECONDS * 1000).toISOString()
                : null,
            durationMs: recording.durationMs,
            thumbnailUrl:
              recording.status === 'ready' && recording.thumbnailKey
                ? await this.storage.createDownloadUrl(
                    recording.thumbnailKey,
                    RECORDING_DOWNLOAD_TTL_SECONDS,
                  )
                : null,
          }
        : null,
      form: { testId: test.id, questions: questions.map(toQuestionView) },
      alreadySubmitted: formResponse !== null,
    };
  }

  /** Tela 17: player-owned session plus the live-overlap configuration. */
  async gameplay(sessionId: string, userId: string): Promise<SessionGameplayView> {
    const session = await this.repo.getSessionForUserOrThrow(sessionId, userId);
    const test = await this.repo.findTestById(session.testId);
    if (!test) throw AppException.notFound();
    const [game, validation] = await Promise.all([
      this.games.getAnyOrg(test.gameId, { includeDeleted: true }),
      this.repo.findSessionValidation(sessionId),
    ]);
    const tutorial = tutorialForModel(test.modelKey);

    return {
      session: this.toSessionView(session, validation),
      test: {
        id: test.id,
        gameId: test.gameId,
        title: test.name,
        testModelKey: test.modelKey,
        status: test.status,
        rewardCents: test.rewardAmountCents,
        expiresAt: test.endsAt ? test.endsAt.toISOString() : null,
      },
      game,
      heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
      recordingRequired: tutorial.requiredConsents.includes('screen_recording'),
    };
  }

  /**
   * RN-01 (Tela 18): unanswered required questions — and answers that don't
   * fit their question (`checkFormAnswers`) — block the submit with
   * `422 fieldErrors` keyed by `questionId`. RN-03: a duplicate submit
   * without `Idempotency-Key` bounces on `form_responses_session_unique`
   * (409) instead of silently overwriting the first answer.
   */
  async submitFormResponse(
    sessionId: string,
    userId: string,
    dto: FormResponseRequest,
    idempotencyKey: string | undefined,
  ): Promise<FormResponseView> {
    const session = await this.repo.getSessionForUserOrThrow(sessionId, userId);
    const questions = await this.repo.findFormQuestions(session.testId);

    const { answers, fieldErrors } = checkFormAnswers(questions, dto.answers);
    if (Object.keys(fieldErrors).length > 0) {
      const onlyMissing = Object.values(fieldErrors).every((m) => m === 'Resposta obrigatória');
      throw AppException.validation(
        onlyMissing ? 'Respostas obrigatórias pendentes' : 'Respostas inválidas',
        fieldErrors,
      );
    }

    let response;
    try {
      response = await this.repo.insertFormResponse(sessionId, idempotencyKey, answers);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw AppException.conflict('Avaliação já enviada para esta sessão');
      }
      throw err;
    }

    // M10: evaluations, ratings and the overview average just changed.
    await this.reportSnapshots.invalidate(session.testId);

    return { id: response.id, sessionId, submittedAt: response.submittedAt.toISOString() };
  }

  private async touchHeartbeat(sessionId: string): Promise<void> {
    await this.redis.set(heartbeatKey(sessionId), '1', 'EX', HEARTBEAT_TIMEOUT_SECONDS);
  }

  /**
   * DB `session_status` tracks recording-pipeline mechanics; the API's
   * coarser status folds `starting`/`recording`/`paused` into `active` and
   * resolves `completed` against `session_validations` (`valid`/`invalid`) —
   * see `dto/session.dto.ts`'s note on why these two enums differ on purpose.
   */
  private toSessionView(session: SessionRow, validation: SessionValidationRow | null): SessionView {
    return {
      id: session.id,
      participationId: session.participationId,
      testId: session.testId,
      status: toSessionStatus(session.status, validation),
      startedAt: session.startedAt.toISOString(),
      endedAt: session.endedAt ? session.endedAt.toISOString() : null,
      durationMs: session.durationMs,
      invalidReason: validation && !validation.valid ? validation.reason : null,
    };
  }
}

/**
 * Anything past `starting`/`recording`/`paused` is closed — `processing` too:
 * a heartbeat landing after `finish` used to re-arm the heartbeat key (and
 * accept device events) on a session that had already ended.
 */
function isClosed(session: { status: string }): boolean {
  return !['starting', 'recording', 'paused'].includes(session.status);
}

function toSessionStatus(
  dbStatus: SessionRow['status'],
  validation: SessionValidationRow | null,
): SessionView['status'] {
  switch (dbStatus) {
    case 'starting':
    case 'recording':
    case 'paused':
      return 'active';
    case 'finishing':
      return 'finishing';
    case 'processing':
      return 'in_review';
    case 'invalidated':
      return 'abandoned';
    case 'completed':
      if (!validation) return 'in_review';
      return validation.valid ? 'valid' : 'invalid';
    default:
      return 'in_review';
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
    scaleMinLabel: q.scaleMinLabel,
    scaleMaxLabel: q.scaleMaxLabel,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const causeCode = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505' || causeCode === '23505';
}
