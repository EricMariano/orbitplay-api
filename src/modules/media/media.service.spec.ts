import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';
import type { SessionRecordingRow, SessionRow } from '../../infra/database/schema/participations';
import {
  JobName,
  mediaExtractAudioJobId,
  mediaTranscodeJobId,
} from '../../infra/queue/queue.constants';
import { AppException } from '../../shared/errors/app.exception';
import type { QueuePort } from '../../shared/ports/queue.port';
import type { StoragePort } from '../../shared/ports/storage.port';
import { MAX_RECORDING_BYTES, MAX_RECORDINGS_PER_SESSION } from './dto/media.dto';
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
    insertRecordingWithinCap: ReturnType<typeof vi.fn>;
    countRecordingsForSession: ReturnType<typeof vi.fn>;
    updateRecording: ReturnType<typeof vi.fn>;
  };
  let storage: {
    [K in keyof StoragePort]: ReturnType<typeof vi.fn>;
  };
  let redis: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    del: ReturnType<typeof vi.fn>;
    zrem: ReturnType<typeof vi.fn>;
    multi: ReturnType<typeof vi.fn>;
  };
  /** What the pending-uploads ZCARD answers inside `reservePendingUpload`'s MULTI. */
  let pendingUploads: number;
  /** The MULTI chain (every command recorded). */
  let tx: Record<
    'zremrangebyscore' | 'zadd' | 'pexpire' | 'zcard' | 'exec',
    ReturnType<typeof vi.fn>
  >;
  let queue: { ensureEnqueued: ReturnType<typeof vi.fn>; healthCheck: ReturnType<typeof vi.fn> };
  let service: MediaService;

  beforeEach(() => {
    repo = {
      findSessionForPlayer: vi.fn(),
      findSessionInOrg: vi.fn(),
      findConsent: vi.fn(),
      findRecordingById: vi.fn(),
      findRecordingByStorageKey: vi.fn(),
      insertRecordingWithinCap: vi.fn(),
      countRecordingsForSession: vi.fn().mockResolvedValue(0),
      updateRecording: vi.fn(),
    };
    storage = {
      createUploadUrl: vi.fn(),
      createDownloadUrl: vi.fn(),
      createMultipartUpload: vi.fn(),
      createUploadPartUrl: vi.fn(),
      completeMultipartUpload: vi.fn(),
      abortMultipartUpload: vi.fn().mockResolvedValue(undefined),
      copyObject: vi.fn(),
      putObject: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn(),
      stat: vi.fn(),
      getObjectStream: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn(),
    };
    pendingUploads = 1;
    tx = {
      zremrangebyscore: vi.fn(() => tx),
      zadd: vi.fn(() => tx),
      pexpire: vi.fn(() => tx),
      zcard: vi.fn(() => tx),
      exec: vi.fn(() =>
        Promise.resolve([
          [null, 0],
          [null, 1],
          [null, 1],
          [null, pendingUploads],
        ]),
      ),
    };
    redis = {
      set: vi.fn(),
      get: vi.fn(),
      del: vi.fn(),
      zrem: vi.fn().mockResolvedValue(1),
      multi: vi.fn(() => tx),
    };
    queue = {
      ensureEnqueued: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn(),
    };
    service = new MediaService(
      repo as unknown as MediaRepository,
      storage as unknown as StoragePort,
      redis as unknown as Redis,
      queue as unknown as QueuePort,
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
    repo.insertRecordingWithinCap.mockResolvedValue(row);

    const out = await service.completeUpload(USER, SESSION, {
      storageKey: key,
      durationMs: 1500,
      uploadId: 'mpu-1',
      parts: [{ partNumber: 1, etag: 'abc' }],
    });

    expect(out.status).toBe('processing');
    expect(out.sessionId).toBe(SESSION);
    expect(queue.ensureEnqueued).toHaveBeenCalledWith(
      JobName.MEDIA_TRANSCODE,
      mediaTranscodeJobId(RECORDING),
      { recordingId: RECORDING },
    );
    expect(queue.ensureEnqueued).toHaveBeenCalledWith(
      JobName.MEDIA_EXTRACT_AUDIO,
      mediaExtractAudioJobId(RECORDING),
      { recordingId: RECORDING },
    );
  });

  it('marks the recording failed instead of leaving it stuck in "processing" when enqueueing fails (OPS-01)', async () => {
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
    storage.stat.mockResolvedValue({ contentType: 'video/webm', sizeBytes: 128 });
    const row = makeRecording({ storageKey: key, status: 'processing' });
    repo.insertRecordingWithinCap.mockResolvedValue(row);
    queue.ensureEnqueued.mockRejectedValue(new Error('redis unreachable'));
    repo.updateRecording.mockResolvedValue(makeRecording({ storageKey: key, status: 'failed' }));

    const out = await service.completeUpload(USER, SESSION, { storageKey: key, durationMs: 1500 });

    expect(repo.updateRecording).toHaveBeenCalledWith(RECORDING, { status: 'failed' });
    expect(out.status).toBe('failed');
  });

  it('re-attempts enqueueing on retry when the existing recording is still "processing" (OPS-01)', async () => {
    const key = buildRecordingStorageKey(ORG, SESSION, 'screen', OBJECT);
    repo.findSessionForPlayer.mockResolvedValue(makeSession());
    repo.findRecordingByStorageKey.mockResolvedValue(
      makeRecording({ storageKey: key, status: 'processing' }),
    );

    const out = await service.completeUpload(USER, SESSION, { storageKey: key, durationMs: 1500 });

    expect(out.status).toBe('processing');
    expect(queue.ensureEnqueued).toHaveBeenCalledWith(
      JobName.MEDIA_TRANSCODE,
      mediaTranscodeJobId(RECORDING),
      { recordingId: RECORDING },
    );
    expect(queue.ensureEnqueued).toHaveBeenCalledWith(
      JobName.MEDIA_EXTRACT_AUDIO,
      mediaExtractAudioJobId(RECORDING),
      { recordingId: RECORDING },
    );
    expect(repo.insertRecordingWithinCap).not.toHaveBeenCalled();
  });

  it('discards the upload when consent was withdrawn before completing it', async () => {
    const key = buildRecordingStorageKey(ORG, SESSION, 'screen', OBJECT);
    repo.findSessionForPlayer.mockResolvedValue(makeSession());
    repo.findConsent.mockResolvedValue({
      participationId: PARTICIPATION,
      screenRecording: false,
      audio: false,
      microphone: false,
      webcam: false,
      acceptedAt: new Date(),
      ip: null,
      userAgent: null,
    });
    repo.findRecordingByStorageKey.mockResolvedValue(null);
    storage.abortMultipartUpload.mockResolvedValue(undefined);

    await expect(
      service.completeUpload(USER, SESSION, {
        storageKey: key,
        durationMs: 1000,
        uploadId: 'mpu-1',
        parts: [{ partNumber: 1, etag: 'e1' }],
      }),
    ).rejects.toBeInstanceOf(AppException);
    expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(key, 'mpu-1');
    expect(repo.insertRecordingWithinCap).not.toHaveBeenCalled();
  });

  it('deletes the oversized object from storage before rejecting it (SEC-06)', async () => {
    const key = buildRecordingStorageKey(ORG, SESSION, 'screen', OBJECT);
    repo.findSessionForPlayer.mockResolvedValue(makeSession());
    repo.findRecordingByStorageKey.mockResolvedValue(null);
    storage.stat.mockResolvedValue({
      contentType: 'video/webm',
      sizeBytes: MAX_RECORDING_BYTES + 1,
    });

    await expect(
      service.completeUpload(USER, SESSION, { storageKey: key, durationMs: 1500 }),
    ).rejects.toMatchObject({ status: 422 });

    expect(storage.remove).toHaveBeenCalledWith(key);
    expect(repo.insertRecordingWithinCap).not.toHaveBeenCalled();
  });

  it('aborts the multipart upload when completing it fails (SEC-06)', async () => {
    const key = buildRecordingStorageKey(ORG, SESSION, 'screen', OBJECT);
    repo.findSessionForPlayer.mockResolvedValue(makeSession());
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
    storage.completeMultipartUpload.mockRejectedValue(new Error('bad etag'));

    await expect(
      service.completeUpload(USER, SESSION, {
        storageKey: key,
        durationMs: 1500,
        uploadId: 'mpu-1',
        parts: [{ partNumber: 1, etag: 'abc' }],
      }),
    ).rejects.toMatchObject({ status: 422 });

    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(key, 'mpu-1');
  });

  describe('storage abuse guards on upload-url', () => {
    const FULL_CONSENT = {
      participationId: PARTICIPATION,
      screenRecording: true,
      audio: true,
      microphone: true,
      webcam: true,
      acceptedAt: new Date(),
      ip: null,
      userAgent: null,
    };
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    const newUpload = () =>
      service.createUploadUrl(USER, SESSION, { contentType: 'video/webm', sizeBytes: 12 });

    beforeEach(() => {
      repo.findConsent.mockResolvedValue(FULL_CONSENT);
      storage.createMultipartUpload.mockResolvedValue('mpu-1');
      storage.createUploadPartUrl.mockResolvedValue('https://minio.local/part');
      redis.set.mockResolvedValue('OK');
    });

    it(`refuses a new upload once the session holds ${MAX_RECORDINGS_PER_SESSION} recordings`, async () => {
      repo.findSessionForPlayer.mockResolvedValue(makeSession());
      repo.countRecordingsForSession.mockResolvedValue(MAX_RECORDINGS_PER_SESSION);

      await expect(newUpload()).rejects.toMatchObject({ status: 409 });
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      // The reservation it just made is handed back.
      expect(redis.zrem).toHaveBeenCalledWith(
        `recording-upload-pending:${SESSION}`,
        expect.stringContaining(`/sessions/${SESSION}/recordings/screen/`),
      );
    });

    it('counts uploads started and not completed yet against the cap', async () => {
      repo.findSessionForPlayer.mockResolvedValue(makeSession());
      repo.countRecordingsForSession.mockResolvedValue(3);
      pendingUploads = MAX_RECORDINGS_PER_SESSION - 2; // 3 + 8 = 11, this one included

      await expect(newUpload()).rejects.toMatchObject({ status: 409 });
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('takes the last free place', async () => {
      repo.findSessionForPlayer.mockResolvedValue(makeSession());
      repo.countRecordingsForSession.mockResolvedValue(MAX_RECORDINGS_PER_SESSION - 1);
      pendingUploads = 1;

      await expect(newUpload()).resolves.toMatchObject({ uploadId: 'mpu-1' });
    });

    it('hands the reservation back when the multipart upload cannot be created', async () => {
      repo.findSessionForPlayer.mockResolvedValue(makeSession());
      storage.createMultipartUpload.mockRejectedValue(new Error('minio down'));

      await expect(newUpload()).rejects.toThrow('minio down');
      expect(redis.zrem).toHaveBeenCalledOnce();
    });

    it('keeps accepting new uploads while the session is processing (just finished)', async () => {
      repo.findSessionForPlayer.mockResolvedValue(
        makeSession({ status: 'processing', endedAt: minutesAgo(60) }),
      );
      await expect(newUpload()).resolves.toMatchObject({ uploadId: 'mpu-1' });
    });

    it('accepts a new upload for a session validated moments after finish', async () => {
      repo.findSessionForPlayer.mockResolvedValue(
        makeSession({ status: 'completed', endedAt: minutesAgo(1) }),
      );
      await expect(newUpload()).resolves.toMatchObject({ uploadId: 'mpu-1' });
    });

    it.each(['completed', 'invalidated'] as const)(
      'refuses a new upload for a %s session past the post-validation grace',
      async (status) => {
        repo.findSessionForPlayer.mockResolvedValue(
          makeSession({ status, endedAt: minutesAgo(16) }),
        );
        await expect(newUpload()).rejects.toMatchObject({ status: 409 });
        expect(storage.createMultipartUpload).not.toHaveBeenCalled();
      },
    );

    it('refuses a new upload for a session that ended more than 2 hours ago', async () => {
      repo.findSessionForPlayer.mockResolvedValue(
        makeSession({ status: 'processing', endedAt: minutesAgo(121) }),
      );
      await expect(newUpload()).rejects.toMatchObject({ status: 409 });
    });

    it('still signs further parts of an upload started before the session closed', async () => {
      repo.findSessionForPlayer.mockResolvedValue(
        makeSession({ status: 'completed', endedAt: minutesAgo(30) }),
      );
      const key = buildRecordingStorageKey(ORG, SESSION, 'screen', OBJECT);
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

      const out = await service.createUploadUrl(USER, SESSION, {
        contentType: 'video/webm',
        sizeBytes: 8 * 1024 * 1024,
        partNumber: 2,
        uploadId: 'mpu-1',
      });

      expect(out).toMatchObject({ uploadId: 'mpu-1', storageKey: key });
      expect(storage.createUploadPartUrl).toHaveBeenCalledWith(key, 'mpu-1', 2, expect.any(Number));
      // A continuing upload is never counted against the cap again.
      expect(tx.zcard).not.toHaveBeenCalled();
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('renews the upload session and its pending place on every part request', async () => {
      repo.findSessionForPlayer.mockResolvedValue(makeSession());
      const key = buildRecordingStorageKey(ORG, SESSION, 'screen', OBJECT);
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
      const before = Date.now();

      await service.createUploadUrl(USER, SESSION, {
        contentType: 'video/webm',
        sizeBytes: 8 * 1024 * 1024,
        partNumber: 400,
        uploadId: 'mpu-1',
      });

      const ttlMs = 3600 * 1000;
      expect(tx.pexpire).toHaveBeenCalledWith('recording-upload:mpu-1', ttlMs);
      expect(tx.pexpire).toHaveBeenCalledWith(`recording-upload-pending:${SESSION}`, ttlMs);
      const [pendingKey, score, member] = tx.zadd.mock.calls[0] as [string, number, string];
      expect(pendingKey).toBe(`recording-upload-pending:${SESSION}`);
      expect(member).toBe(key);
      expect(score).toBeGreaterThanOrEqual(before + ttlMs);
    });

    it('refuses a part request for an upload that already expired', async () => {
      repo.findSessionForPlayer.mockResolvedValue(makeSession());
      redis.get.mockResolvedValue(null);

      await expect(
        service.createUploadUrl(USER, SESSION, {
          contentType: 'video/webm',
          sizeBytes: 8 * 1024 * 1024,
          partNumber: 2,
          uploadId: 'mpu-gone',
        }),
      ).rejects.toMatchObject({ status: 422 });
      expect(tx.exec).not.toHaveBeenCalled();
    });
  });

  describe('concurrent completes of the same upload', () => {
    const key = buildRecordingStorageKey(ORG, SESSION, 'screen', OBJECT);

    beforeEach(() => {
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
      storage.stat.mockResolvedValue({ contentType: 'video/webm', sizeBytes: 128 });
    });

    it('answers with the winner’s row when the insert hits the storage_key unique', async () => {
      const winner = makeRecording({ storageKey: key });
      repo.findRecordingByStorageKey.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
      repo.insertRecordingWithinCap.mockRejectedValue(
        Object.assign(new Error('Failed query'), {
          cause: { code: '23505', constraint_name: 'session_recordings_storage_key_unique' },
        }),
      );

      const out = await service.completeUpload(USER, SESSION, {
        storageKey: key,
        durationMs: 1500,
      });

      expect(out).toMatchObject({ id: RECORDING, status: 'processing' });
      // Re-ensured under the same deterministic ids — never a second job.
      expect(queue.ensureEnqueued).toHaveBeenCalledWith(
        JobName.MEDIA_TRANSCODE,
        mediaTranscodeJobId(RECORDING),
        { recordingId: RECORDING },
      );
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('rethrows a unique violation on any other constraint', async () => {
      repo.findRecordingByStorageKey.mockResolvedValue(null);
      const err = Object.assign(new Error('Failed query'), {
        cause: { code: '23505', constraint_name: 'something_else_unique' },
      });
      repo.insertRecordingWithinCap.mockRejectedValue(err);

      await expect(
        service.completeUpload(USER, SESSION, { storageKey: key, durationMs: 1500 }),
      ).rejects.toBe(err);
    });

    it('answers with the winner’s row when the multipart upload was already completed by it', async () => {
      const winner = makeRecording({ storageKey: key });
      repo.findRecordingByStorageKey.mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
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
      storage.completeMultipartUpload.mockRejectedValue(new Error('NoSuchUpload'));

      const out = await service.completeUpload(USER, SESSION, {
        storageKey: key,
        durationMs: 1500,
        uploadId: 'mpu-1',
        parts: [{ partNumber: 1, etag: 'abc' }],
      });

      expect(out.id).toBe(RECORDING);
      expect(storage.abortMultipartUpload).not.toHaveBeenCalled();
    });

    it('409s and drops the object when the session is already at the cap', async () => {
      repo.findRecordingByStorageKey.mockResolvedValue(null);
      repo.insertRecordingWithinCap.mockResolvedValue(null);

      await expect(
        service.completeUpload(USER, SESSION, { storageKey: key, durationMs: 1500 }),
      ).rejects.toMatchObject({ status: 409 });
      expect(repo.insertRecordingWithinCap).toHaveBeenCalledWith(
        expect.objectContaining({ storageKey: key }),
        MAX_RECORDINGS_PER_SESSION,
      );
      expect(storage.remove).toHaveBeenCalledWith(key);
      expect(queue.ensureEnqueued).not.toHaveBeenCalled();
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
