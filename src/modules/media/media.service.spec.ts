import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import type { SessionRecordingRow, SessionRow } from '../../infra/database/schema/participations';
import { JobName } from '../../infra/queue/queue.constants';
import { AppException } from '../../shared/errors/app.exception';
import type { StoragePort } from '../../shared/ports/storage.port';
import { MediaService } from './media.service';
import type { MediaRepository, PlayerSession } from './media.repository';
import { buildRecordingStorageKey } from './storage-key';

const ORG = '01920000-0000-7000-8000-0000000000a1';
const USER = '01920000-0000-7000-8000-0000000000c4';
const SESSION = '01920000-0000-7000-8000-0000000000aa';
const PARTICIPATION = '01920000-0000-7000-8000-0000000000ab';
const RECORDING = '01920000-0000-7000-8000-0000000000ac';
const OBJECT = '01920000-0000-7000-8000-0000000000ad';

function makeSession(overrides: Partial<PlayerSession> = {}): PlayerSession {
  return {
    id: SESSION,
    participationId: PARTICIPATION,
    testId: '01920000-0000-7000-8000-0000000000ae',
    organizationId: ORG,
    status: 'recording',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    endedAt: null,
    durationMs: null,
    finishIdempotencyKey: null,
    userId: USER,
    ...overrides,
  };
}

function makeRecording(overrides: Partial<SessionRecordingRow> = {}): SessionRecordingRow {
  return {
    id: RECORDING,
    sessionId: SESSION,
    kind: 'screen',
    storageKey: buildRecordingStorageKey(ORG, SESSION, 'screen', OBJECT),
    contentType: 'video/webm',
    sizeBytes: 128,
    durationMs: 1500,
    status: 'processing',
    thumbnailKey: null,
    ...overrides,
  };
}

describe('MediaService', () => {
  let repo: {
    findSessionForPlayer: ReturnType<typeof vi.fn>;
    findSessionInOrg: ReturnType<typeof vi.fn>;
    findConsent: ReturnType<typeof vi.fn>;
    findRecordingById: ReturnType<typeof vi.fn>;
    findRecordingByStorageKey: ReturnType<typeof vi.fn>;
    insertRecording: ReturnType<typeof vi.fn>;
    updateRecording: ReturnType<typeof vi.fn>;
  };
  let storage: {
    [K in keyof StoragePort]: ReturnType<typeof vi.fn>;
  };
  let redis: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
  };
  let queue: { add: ReturnType<typeof vi.fn> };
  let service: MediaService;

  beforeEach(() => {
    repo = {
      findSessionForPlayer: vi.fn(),
      findSessionInOrg: vi.fn(),
      findConsent: vi.fn(),
      findRecordingById: vi.fn(),
      findRecordingByStorageKey: vi.fn(),
      insertRecording: vi.fn(),
      updateRecording: vi.fn(),
    };
    storage = {
      createUploadUrl: vi.fn(),
      createDownloadUrl: vi.fn(),
      createMultipartUpload: vi.fn(),
      createUploadPartUrl: vi.fn(),
      completeMultipartUpload: vi.fn(),
      abortMultipartUpload: vi.fn(),
      copyObject: vi.fn(),
      exists: vi.fn(),
      stat: vi.fn(),
      remove: vi.fn(),
      healthCheck: vi.fn(),
    };
    redis = { set: vi.fn(), get: vi.fn(), del: vi.fn() };
    queue = { add: vi.fn().mockResolvedValue(undefined) };
    service = new MediaService(
      repo as unknown as MediaRepository,
      storage as unknown as StoragePort,
      redis as unknown as Redis,
      queue as unknown as Queue,
    );
  });

  it('refuses upload when the session is not the player’s', async () => {
    repo.findSessionForPlayer.mockResolvedValue(null);
    await expect(
      service.createUploadUrl(USER, SESSION, {
        contentType: 'video/webm',
        sizeBytes: 12,
      }),
    ).rejects.toSatisfy((err: unknown) => err instanceof AppException && err.getStatus() === 404);
  });

  it('refuses upload without recording consent', async () => {
    repo.findSessionForPlayer.mockResolvedValue(makeSession());
    repo.findConsent.mockResolvedValue({
      participationId: PARTICIPATION,
      screenRecording: false,
      audio: false,
      microphone: false,
      webcam: false,
      acceptedAt: null,
      ip: null,
      userAgent: null,
    });
    await expect(
      service.createUploadUrl(USER, SESSION, {
        contentType: 'video/webm',
        sizeBytes: 12,
      }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('starts a multipart upload and returns uploadId', async () => {
    repo.findSessionForPlayer.mockResolvedValue(makeSession());
    repo.findConsent.mockResolvedValue({
      participationId: PARTICIPATION,
      screenRecording: true,
      audio: true,
      microphone: true,
      webcam: true,
      acceptedAt: new Date(),
      ip: null,
      userAgent: null,
    });
    storage.createMultipartUpload.mockResolvedValue('mpu-1');
    storage.createUploadPartUrl.mockResolvedValue('https://minio.local/part');
    redis.set.mockResolvedValue('OK');

    const out = await service.createUploadUrl(USER, SESSION, {
      contentType: 'video/webm',
      sizeBytes: 12,
      kind: 'screen_recording',
    });

    expect(out.uploadId).toBe('mpu-1');
    expect(out.uploadUrl).toBe('https://minio.local/part');
    expect(out.storageKey).toContain(`/sessions/${SESSION}/recordings/screen/`);
    expect(storage.createMultipartUpload).toHaveBeenCalledOnce();
  });

  it('completes the upload, inserts processing, and enqueues both jobs', async () => {
    const key = buildRecordingStorageKey(ORG, SESSION, 'screen', OBJECT);
    repo.findSessionForPlayer.mockResolvedValue(makeSession());
    repo.findConsent.mockResolvedValue({
      participationId: PARTICIPATION,
      screenRecording: true,
      audio: false,
      microphone: false,
      webcam: false,
      acceptedAt: new Date(),
      ip: null,
      userAgent: null,
    });
    repo.findRecordingByStorageKey.mockResolvedValue(null);
    redis.get.mockResolvedValue(
      JSON.stringify({
        storageKey: key,
        sessionId: SESSION,
        userId: USER,
        contentType: 'video/webm',
        kind: 'screen',
        organizationId: ORG,
      }),
    );
    storage.completeMultipartUpload.mockResolvedValue(undefined);
    storage.stat.mockResolvedValue({ contentType: 'video/webm', sizeBytes: 128 });
    const row = makeRecording({ storageKey: key });
    repo.insertRecording.mockResolvedValue(row);

    const out = await service.completeUpload(USER, SESSION, {
      storageKey: key,
      durationMs: 1500,
      uploadId: 'mpu-1',
      parts: [{ partNumber: 1, etag: 'abc' }],
    });

    expect(out.status).toBe('processing');
    expect(out.sessionId).toBe(SESSION);
    expect(queue.add).toHaveBeenCalledWith(JobName.MEDIA_TRANSCODE, { recordingId: RECORDING });
    expect(queue.add).toHaveBeenCalledWith(JobName.MEDIA_EXTRACT_AUDIO, {
      recordingId: RECORDING,
    });
  });

  it('returns url null while processing (Tela 12 RN-03)', async () => {
    repo.findSessionInOrg.mockResolvedValue(makeSession() as SessionRow);
    repo.findRecordingById.mockResolvedValue(makeRecording({ status: 'processing' }));

    const out = await service.playbackUrl(ORG, SESSION, RECORDING);
    expect(out.status).toBe('processing');
    expect(out.url).toBeNull();
    expect(out.thumbnailUrl).toBeNull();
  });

  it('returns a signed url when ready', async () => {
    repo.findSessionInOrg.mockResolvedValue(makeSession() as SessionRow);
    repo.findRecordingById.mockResolvedValue(makeRecording({ status: 'ready' }));
    storage.createDownloadUrl.mockResolvedValue('https://minio.local/play');

    const out = await service.playbackUrl(ORG, SESSION, RECORDING);
    expect(out.status).toBe('ready');
    expect(out.url).toBe('https://minio.local/play');
    expect(out.expiresAt).toBeTruthy();
  });

  it('hides a recording from another org with 404', async () => {
    repo.findSessionInOrg.mockResolvedValue(null);
    await expect(service.playbackUrl(ORG, SESSION, RECORDING)).rejects.toSatisfy(
      (err: unknown) => err instanceof AppException && err.getStatus() === 404,
    );
  });
});
