import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { newId } from '../../infra/database/schema/_helpers';
import type {
  SessionConsentRow,
  SessionRecordingRow,
} from '../../infra/database/schema/participations';
import {
  JobName,
  mediaExtractAudioJobId,
  mediaTranscodeJobId,
} from '../../infra/queue/queue.constants';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { AppException } from '../../shared/errors/app.exception';
import { QUEUE_PORT, type QueuePort } from '../../shared/ports/queue.port';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import { createdAtFromUuidV7 } from '../../shared/util/uuid';
import {
  MAX_RECORDING_BYTES,
  MAX_RECORDINGS_PER_SESSION,
  RECORDING_UPLOAD_TTL_SECONDS,
  RECORDING_UPLOAD_WINDOW_MS,
  type PlaybackUrlResponse,
  type RecordingCompleteRequest,
  type RecordingUploadUrlRequest,
  type RecordingView,
  type RecordingUploadUrlResponse,
} from './dto/media.dto';
import { MediaRepository, type PlayerSession } from './media.repository';
import { toDbRecordingKind, type RecordingKindApi, type RecordingKindDb } from './recording-kind';
import { buildRecordingStorageKey, parseRecordingStorageKey } from './storage-key';

interface UploadSession {
  storageKey: string;
  sessionId: string;
  userId: string;
  contentType: string;
  kind: RecordingKindDb;
  organizationId: string;
}

const UPLOAD_SESSION_PREFIX = 'recording-upload:';
/** Per session: sorted set of uploads started but not completed yet (score = expiry, ms). */
const PENDING_UPLOADS_PREFIX = 'recording-upload-pending:';

/**
 * A session stops accepting NEW recordings (an upload already started can
 * still send parts and complete) once it ended this long ago, whatever its
 * status — the same window `session.validate` waits for a required recording.
 */
export const NEW_RECORDING_MAX_AGE_AFTER_END_MS = RECORDING_UPLOAD_WINDOW_MS;

/**
 * `completed`/`invalidated` sessions stop accepting new recordings sooner:
 * only within this window after `endedAt`. Not zero because `session.validate`
 * runs right after `finish` — a recording whose upload starts once the player
 * clicks "Encerrar" (the recorder stops then) would otherwise always find the
 * session already validated and be refused.
 */
export const NEW_RECORDING_GRACE_AFTER_VALIDATION_MS = 15 * 60 * 1000;

/**
 * Media / recordings. The API never proxies bytes — it signs URLs, confirms
 * the object exists, and enqueues `media.transcode` + `media.extract-audio`.
 * Retention/expurgo is BACKEND-SPEC pending #6: no TTL is applied yet.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly repo: MediaRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(QUEUE_PORT) private readonly queue: QueuePort,
  ) {}

  /**
   * Ensures both processing jobs exist for a recording, using deterministic
   * ids so this is safe to call repeatedly — the first successful insert,
   * a client retry that finds the recording already `processing`, and the
   * reconciliation sweep can all call this without ever double-enqueueing
   * (OPS-01).
   */
  private async ensureRecordingJobsEnqueued(recordingId: string): Promise<void> {
    await this.queue.ensureEnqueued(JobName.MEDIA_TRANSCODE, mediaTranscodeJobId(recordingId), {
      recordingId,
    });
    await this.queue.ensureEnqueued(
      JobName.MEDIA_EXTRACT_AUDIO,
      mediaExtractAudioJobId(recordingId),
      { recordingId },
    );
  }

  async createUploadUrl(
    userId: string,
    sessionId: string,
    dto: RecordingUploadUrlRequest,
  ): Promise<RecordingUploadUrlResponse> {
    const session = await this.requirePlayerSession(sessionId, userId);
    const apiKind: RecordingKindApi = dto.kind ?? 'screen_recording';
    const kind = toDbRecordingKind(apiKind);
    await this.assertConsent(session.participationId, kind);

    const partNumber = dto.partNumber ?? 1;
    let storageKey: string;
    let uploadId: string;

    if (dto.uploadId) {
      const pending = await this.loadUploadSession(dto.uploadId);
      if (!pending || pending.sessionId !== sessionId || pending.userId !== userId) {
        throw AppException.validation('Upload expirado ou inválido', {
          uploadId: 'Inicie o envio novamente',
        });
      }
      storageKey = pending.storageKey;
      uploadId = dto.uploadId;
      await this.renewUpload(uploadId, sessionId, storageKey);
    } else {
      assertAcceptsNewRecording(session);
      const objectId = newId();
      storageKey = buildRecordingStorageKey(session.organizationId, sessionId, kind, objectId);
      await this.reservePendingUpload(sessionId, storageKey);
      try {
        uploadId = await this.storage.createMultipartUpload(storageKey, dto.contentType);
        await this.saveUploadSession(uploadId, {
          storageKey,
          sessionId,
          userId,
          contentType: dto.contentType,
          kind,
          organizationId: session.organizationId,
        });
      } catch (err) {
        await this.releasePendingUpload(sessionId, storageKey);
        throw err;
      }
    }

    const uploadUrl = await this.storage.createUploadPartUrl(
      storageKey,
      uploadId,
      partNumber,
      RECORDING_UPLOAD_TTL_SECONDS,
    );

    return {
      uploadUrl,
      storageKey,
      expiresAt: new Date(Date.now() + RECORDING_UPLOAD_TTL_SECONDS * 1000).toISOString(),
      maxSizeBytes: MAX_RECORDING_BYTES,
      uploadId,
    };
  }

  async completeUpload(
    userId: string,
    sessionId: string,
    dto: RecordingCompleteRequest,
  ): Promise<RecordingView> {
    const session = await this.requirePlayerSession(sessionId, userId);

    if (!storageKeyBelongsToSession(dto.storageKey, session.organizationId, sessionId)) {
      throw AppException.validation('storageKey não pertence a esta sessão', {
        storageKey: 'Chave de storage inválida para esta sessão',
      });
    }

    const already = await this.findExistingRecording(sessionId, dto.storageKey);
    if (already) return already;

    // Consent first, before the bytes become an object: if it was withdrawn
    // while uploading, completing anyway left a recording in the bucket with
    // no row in the database — kept without consent, out of reach of any
    // database-driven purge. Discard what was sent instead.
    const kind = kindFromStorageKey(dto.storageKey);
    try {
      await this.assertConsent(session.participationId, kind);
    } catch (err) {
      await (
        dto.uploadId
          ? this.storage.abortMultipartUpload(dto.storageKey, dto.uploadId)
          : this.storage.remove(dto.storageKey)
      ).catch(() => undefined);
      await this.releasePendingUpload(sessionId, dto.storageKey);
      throw err;
    }

    if (dto.uploadId && dto.parts) {
      const pending = await this.loadUploadSession(dto.uploadId);
      if (!pending || pending.storageKey !== dto.storageKey) {
        // A concurrent complete of this same upload may have just finished
        // (it drops the upload session once its row exists).
        const winner = await this.findExistingRecording(sessionId, dto.storageKey);
        if (winner) return winner;
        throw AppException.validation('Partes do envio incompletas ou expiradas', {
          uploadId: 'uploadId não corresponde a este storageKey',
        });
      }
      try {
        await this.storage.completeMultipartUpload(dto.storageKey, dto.uploadId, dto.parts);
      } catch {
        // A concurrent complete of this same upload already closed it: its
        // row is the answer, and there is nothing left to abort.
        const winner = await this.findExistingRecording(sessionId, dto.storageKey);
        if (winner) return winner;
        // A failed completion leaves the already-uploaded parts orphaned
        // server-side unless explicitly aborted (SEC-06) — the bucket's
        // AbortIncompleteMultipartUpload lifecycle rule is the backstop for
        // uploads that never even reach this call, but a completion we know
        // failed shouldn't have to wait on that.
        await this.storage
          .abortMultipartUpload(dto.storageKey, dto.uploadId)
          .catch(() => undefined);
        await this.releasePendingUpload(sessionId, dto.storageKey);
        throw AppException.validation('Partes do envio incompletas', {
          parts: 'ETags ou partNumber inválidos',
        });
      }
    }

    const meta = await this.storage.stat(dto.storageKey);
    if (!meta) {
      throw AppException.validation('Objeto ausente no storage', {
        storageKey: 'Upload não encontrado — envie o arquivo antes de confirmar',
      });
    }
    if (meta.sizeBytes < 1 || meta.sizeBytes > MAX_RECORDING_BYTES) {
      // Reject without leaving the oversized object behind (SEC-06).
      await this.storage.remove(dto.storageKey).catch(() => undefined);
      await this.releasePendingUpload(sessionId, dto.storageKey);
      throw AppException.validation('Tamanho de gravação inválido', {
        sizeBytes: `Tamanho deve ficar entre 1 e ${MAX_RECORDING_BYTES} bytes`,
      });
    }

    let inserted: SessionRecordingRow | null;
    try {
      inserted = await this.repo.insertRecordingWithinCap(
        {
          sessionId,
          kind,
          storageKey: dto.storageKey,
          contentType: meta.contentType ?? null,
          // Trust the object store, never the client-supplied size.
          sizeBytes: meta.sizeBytes,
          durationMs: dto.durationMs,
          status: 'processing',
        },
        MAX_RECORDINGS_PER_SESSION,
      );
    } catch (err) {
      // Two concurrent completes of the same upload: the unique on
      // `storage_key` lets one row through — the other answers with it, like
      // a retry would (the deterministic job ids keep its enqueue from
      // doubling the winner's).
      if (!isStorageKeyConflict(err)) throw err;
      const winner = await this.findExistingRecording(sessionId, dto.storageKey);
      if (!winner) throw err;
      return winner;
    }
    if (!inserted) {
      // Over the cap (normally stopped at upload-url already): don't keep an
      // object no row points at.
      await this.storage.remove(dto.storageKey).catch(() => undefined);
      await this.releasePendingUpload(sessionId, dto.storageKey);
      throw tooManyRecordings();
    }
    let row = inserted;
    // Only now that the row exists: dropping it before left a failed insert
    // with no upload session for the client's retry to finish.
    if (dto.uploadId) await this.redis.del(uploadSessionKey(dto.uploadId));
    await this.releasePendingUpload(sessionId, dto.storageKey);

    // OPS-01: the insert and the enqueue are two separate operations with no
    // shared transaction — if this fails, don't leave the row silently
    // stuck in "processing" forever. Surface it as `failed` right away
    // (the same status the transcode worker already uses when its source
    // object goes missing), so it's visible immediately instead of only
    // once the reconciliation sweep's grace period elapses.
    try {
      await this.ensureRecordingJobsEnqueued(row.id);
    } catch (err) {
      const failed = await this.repo.updateRecording(row.id, { status: 'failed' });
      if (failed) row = failed;
      this.logger.error(`failed to enqueue jobs for recording ${row.id}: ${String(err)}`);
    }

    return toRecordingView(row);
  }

  async playbackUrl(
    organizationId: string,
    sessionId: string,
    recordingId: string,
  ): Promise<PlaybackUrlResponse> {
    const session = await this.repo.findSessionInOrg(sessionId, organizationId);
    if (!session) throw AppException.notFound();

    const recording = await this.repo.findRecordingById(recordingId);
    if (!recording || recording.sessionId !== sessionId) throw AppException.notFound();

    if (recording.status !== 'ready') {
      return {
        status: recording.status,
        url: null,
        expiresAt: null,
        durationMs: recording.durationMs,
        thumbnailUrl: null,
      };
    }

    const expiresAt = new Date(Date.now() + RECORDING_UPLOAD_TTL_SECONDS * 1000).toISOString();
    const [url, thumbnailUrl] = await Promise.all([
      this.storage.createDownloadUrl(recording.storageKey, RECORDING_UPLOAD_TTL_SECONDS),
      recording.thumbnailKey
        ? this.storage.createDownloadUrl(recording.thumbnailKey, RECORDING_UPLOAD_TTL_SECONDS)
        : Promise.resolve(null),
    ]);

    return {
      status: 'ready',
      url,
      expiresAt,
      durationMs: recording.durationMs,
      thumbnailUrl,
    };
  }

  /**
   * The row an earlier (or concurrent) complete of this upload already
   * created, as the view a retry gets — `null` when there is none yet.
   *
   * OPS-01: a retry must not just hand back the row and hope — if the
   * original request's enqueue never landed (crash, Redis blip), this is the
   * client's only chance to get it re-ensured before the reconciliation sweep
   * eventually notices. Best-effort: a failure here just means the row is
   * still `processing` for the sweep to pick up later, same as if this retry
   * never happened. The ids are deterministic, so a job already queued by the
   * winning request is never queued twice.
   */
  private async findExistingRecording(
    sessionId: string,
    storageKey: string,
  ): Promise<RecordingView | null> {
    const existing = await this.repo.findRecordingByStorageKey(storageKey);
    if (!existing || existing.sessionId !== sessionId) return null;
    if (existing.status === 'processing') {
      await this.ensureRecordingJobsEnqueued(existing.id).catch((err: unknown) => {
        this.logger.warn(`retry re-enqueue failed for recording ${existing.id}: ${String(err)}`);
      });
    }
    return toRecordingView(existing);
  }

  /**
   * Counts a new upload against the session's cap before its multipart
   * upload exists: stored rows + uploads started and not completed yet (an
   * abandoned one keeps its parts in the bucket until the stale-upload expiry,
   * so it must count too — until its upload session would have expired).
   * Add-then-count in one MULTI: concurrent starts each see the others.
   */
  private async reservePendingUpload(sessionId: string, storageKey: string): Promise<void> {
    const key = pendingUploadsKey(sessionId);
    const now = Date.now();
    const ttlMs = RECORDING_UPLOAD_TTL_SECONDS * 1000;
    const replies = await this.redis
      .multi()
      .zremrangebyscore(key, '-inf', now)
      .zadd(key, now + ttlMs, storageKey)
      .pexpire(key, ttlMs)
      .zcard(key)
      .exec();
    const zcard = replies?.[3];
    if (!zcard || zcard[0]) throw zcard?.[0] ?? new Error('Redis MULTI aborted');
    const pending = Number(zcard[1]);

    const stored = await this.repo.countRecordingsForSession(sessionId);
    if (stored + pending > MAX_RECORDINGS_PER_SESSION) {
      await this.releasePendingUpload(sessionId, storageKey);
      throw tooManyRecordings();
    }
  }

  /**
   * Every part request keeps its upload alive: the client sends parts while
   * it is still recording, so an upload can outlive one TTL — the upload
   * session and its place in the pending set were written once and expired
   * mid-recording ("Upload expirado ou inválido" after 1 h). Renewed together.
   */
  private async renewUpload(
    uploadId: string,
    sessionId: string,
    storageKey: string,
  ): Promise<void> {
    const pendingKey = pendingUploadsKey(sessionId);
    const ttlMs = RECORDING_UPLOAD_TTL_SECONDS * 1000;
    const replies = await this.redis
      .multi()
      .pexpire(uploadSessionKey(uploadId), ttlMs)
      .zadd(pendingKey, Date.now() + ttlMs, storageKey)
      .pexpire(pendingKey, ttlMs)
      .exec();
    const failed = replies?.find(([err]) => err)?.[0];
    if (!replies || failed) throw failed ?? new Error('Redis MULTI aborted');
  }

  /** Best-effort: an entry left behind only expires with its score. */
  private async releasePendingUpload(sessionId: string, storageKey: string): Promise<void> {
    await this.redis.zrem(pendingUploadsKey(sessionId), storageKey).catch((err: unknown) => {
      this.logger.warn(`pending upload release failed for ${storageKey}: ${String(err)}`);
    });
  }

  private async requirePlayerSession(sessionId: string, userId: string) {
    const session = await this.repo.findSessionForPlayer(sessionId, userId);
    if (!session) throw AppException.notFound();
    return session;
  }

  private async assertConsent(participationId: string, kind: RecordingKindDb): Promise<void> {
    const consent = await this.repo.findConsent(participationId);
    if (!consent || !consentGranted(consent, kind)) {
      throw AppException.validation('Consentimento de gravação ausente', {
        kind: 'A gravação só começa após o consentimento (Tela 17 RN-01)',
      });
    }
  }

  private async saveUploadSession(uploadId: string, payload: UploadSession): Promise<void> {
    await this.redis.set(
      uploadSessionKey(uploadId),
      JSON.stringify(payload),
      'EX',
      RECORDING_UPLOAD_TTL_SECONDS,
    );
  }

  private async loadUploadSession(uploadId: string): Promise<UploadSession | null> {
    const raw = await this.redis.get(uploadSessionKey(uploadId));
    if (!raw) return null;
    return JSON.parse(raw) as UploadSession;
  }
}

function consentGranted(consent: SessionConsentRow, kind: RecordingKindDb): boolean {
  if (kind === 'screen') return consent.screenRecording;
  if (kind === 'webcam') return consent.webcam;
  return consent.microphone;
}

function uploadSessionKey(uploadId: string): string {
  return `${UPLOAD_SESSION_PREFIX}${uploadId}`;
}

function pendingUploadsKey(sessionId: string): string {
  return `${PENDING_UPLOADS_PREFIX}${sessionId}`;
}

function tooManyRecordings(): AppException {
  return AppException.conflict(
    `Limite de ${MAX_RECORDINGS_PER_SESSION} gravações por sessão atingido`,
  );
}

/**
 * Storage abuse guard for a NEW recording (an upload already started is left
 * to finish): the session must not be long over. `processing` — finish ran,
 * validation pending — and a session validated moments ago are the normal
 * "upload right after finish" case and keep working.
 */
function assertAcceptsNewRecording(session: PlayerSession, now: number = Date.now()): void {
  const endedAgoMs = session.endedAt ? now - session.endedAt.getTime() : null;
  const validated = session.status === 'completed' || session.status === 'invalidated';
  const refused = validated
    ? endedAgoMs === null || endedAgoMs > NEW_RECORDING_GRACE_AFTER_VALIDATION_MS
    : endedAgoMs !== null && endedAgoMs > NEW_RECORDING_MAX_AGE_AFTER_END_MS;
  if (refused) throw AppException.conflict('Sessão encerrada não aceita novas gravações');
}

/** 23505 on `session_recordings_storage_key_unique` (Drizzle wraps the PostgresError in `.cause`). */
function isStorageKeyConflict(err: unknown): boolean {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    const pg = candidate as { code?: string; constraint_name?: string } | null | undefined;
    if (pg?.code === '23505' && pg.constraint_name === 'session_recordings_storage_key_unique') {
      return true;
    }
  }
  return false;
}

function storageKeyBelongsToSession(
  storageKey: string,
  organizationId: string,
  sessionId: string,
): boolean {
  const parsed = parseRecordingStorageKey(storageKey);
  if (!parsed) return false;
  return parsed.organizationId === organizationId && parsed.sessionId === sessionId;
}

function kindFromStorageKey(storageKey: string): RecordingKindDb {
  const parsed = parseRecordingStorageKey(storageKey);
  if (!parsed) {
    throw AppException.validation('storageKey inválida', {
      storageKey: 'Chave de storage inválida para esta sessão',
    });
  }
  return parsed.kind;
}

function toRecordingView(row: SessionRecordingRow): RecordingView {
  return {
    id: row.id,
    sessionId: row.sessionId,
    status: row.status,
    durationMs: row.durationMs,
    createdAt: createdAtFromUuidV7(row.id).toISOString(),
  };
}
