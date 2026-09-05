import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { newId } from '../../infra/database/schema/_helpers';
import type {
  SessionConsentRow,
  SessionRecordingRow,
} from '../../infra/database/schema/participations';
import { JobName, MAIN_QUEUE } from '../../infra/queue/queue.constants';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { AppException } from '../../shared/errors/app.exception';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import { createdAtFromUuidV7 } from '../../shared/util/uuid';
import {
  MAX_RECORDING_BYTES,
  RECORDING_UPLOAD_TTL_SECONDS,
  type PlaybackUrlResponse,
  type RecordingCompleteRequest,
  type RecordingUploadUrlRequest,
  type RecordingView,
  type UploadUrlResponse,
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
  constructor(
    private readonly repo: MediaRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @InjectQueue(MAIN_QUEUE) private readonly queue: Queue,
  ) {}

  async createUploadUrl(
    userId: string,
    sessionId: string,
    dto: RecordingUploadUrlRequest,
  ): Promise<UploadUrlResponse> {
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
      throw AppException.validation('Tamanho de gravação inválido', {
        sizeBytes: `Tamanho deve ficar entre 1 e ${MAX_RECORDING_BYTES} bytes`,
      });
    }

    const kind = kindFromStorageKey(dto.storageKey);
    await this.assertConsent(session.participationId, kind);

    const row = await this.repo.insertRecording({
      sessionId,
      kind,
      storageKey: dto.storageKey,
      contentType: meta.contentType ?? null,
      sizeBytes: dto.sizeBytes ?? meta.sizeBytes,
      durationMs: dto.durationMs,
      status: 'processing',
    });

    await Promise.all([
      this.queue.add(JobName.MEDIA_TRANSCODE, { recordingId: row.id }),
      this.queue.add(JobName.MEDIA_EXTRACT_AUDIO, { recordingId: row.id }),
    ]);

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
