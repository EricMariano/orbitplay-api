import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { newId } from '../../infra/database/schema/_helpers';
import type {
  SessionConsentRow,
  SessionRecordingRow,
} from '../../infra/database/schema/participations';
import { JobName, mediaExtractAudioJobId, mediaTranscodeJobId } from '../../infra/queue/queue.constants';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { AppException } from '../../shared/errors/app.exception';
import { QUEUE_PORT, type QueuePort } from '../../shared/ports/queue.port';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import { createdAtFromUuidV7 } from '../../shared/util/uuid';
import {
  MAX_RECORDING_BYTES,
  RECORDING_UPLOAD_TTL_SECONDS,
  type PlaybackUrlResponse,
  type RecordingCompleteRequest,
  type RecordingUploadUrlRequest,
  type RecordingView,
  type RecordingUploadUrlResponse,
} from './dto/media.dto';
import { MediaRepository } from './media.repository';
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
    } else {
      const objectId = newId();
      storageKey = buildRecordingStorageKey(session.organizationId, sessionId, kind, objectId);
      uploadId = await this.storage.createMultipartUpload(storageKey, dto.contentType);
      await this.saveUploadSession(uploadId, {
        storageKey,
        sessionId,
        userId,
        contentType: dto.contentType,
        kind,
        organizationId: session.organizationId,
      });
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

    const already = await this.repo.findRecordingByStorageKey(dto.storageKey);
    if (already && already.sessionId === sessionId) {
      // OPS-01: a retry must not just hand back the row and hope — if the
      // original request's enqueue never landed (crash, Redis blip), this
      // is the client's only chance to get it re-ensured before the
      // reconciliation sweep eventually notices. Best-effort: a failure
      // here just means the row is still `processing` for the sweep to
      // pick up later, same as if this retry never happened.
      if (already.status === 'processing') {
        await this.ensureRecordingJobsEnqueued(already.id).catch((err: unknown) => {
          this.logger.warn(`retry re-enqueue failed for recording ${already.id}: ${String(err)}`);
        });
      }
      return toRecordingView(already);
    }

    if (dto.uploadId && dto.parts) {
      const pending = await this.loadUploadSession(dto.uploadId);
      if (!pending || pending.storageKey !== dto.storageKey) {
        throw AppException.validation('Partes do envio incompletas ou expiradas', {
          uploadId: 'uploadId não corresponde a este storageKey',
        });
      }
      try {
        await this.storage.completeMultipartUpload(dto.storageKey, dto.uploadId, dto.parts);
      } catch {
        // A failed completion leaves the already-uploaded parts orphaned
        // server-side unless explicitly aborted (SEC-06) — the bucket's
        // AbortIncompleteMultipartUpload lifecycle rule is the backstop for
        // uploads that never even reach this call, but a completion we know
        // failed shouldn't have to wait on that.
        await this.storage
          .abortMultipartUpload(dto.storageKey, dto.uploadId)
          .catch(() => undefined);
        throw AppException.validation('Partes do envio incompletas', {
          parts: 'ETags ou partNumber inválidos',
        });
      }
      await this.redis.del(uploadSessionKey(dto.uploadId));
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
      throw AppException.validation('Tamanho de gravação inválido', {
        sizeBytes: `Tamanho deve ficar entre 1 e ${MAX_RECORDING_BYTES} bytes`,
      });
    }

    const kind = kindFromStorageKey(dto.storageKey);
    await this.assertConsent(session.participationId, kind);

    let row = await this.repo.insertRecording({
      sessionId,
      kind,
      storageKey: dto.storageKey,
      contentType: meta.contentType ?? null,
      sizeBytes: dto.sizeBytes ?? meta.sizeBytes,
      durationMs: dto.durationMs,
      status: 'processing',
    });

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
