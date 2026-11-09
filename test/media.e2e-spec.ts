import type { INestApplication } from '@nestjs/common';
import { Worker } from 'bullmq';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, ORG_ID, SEED_EMAILS, SEED_PASSWORD, USER_IDS } from '../src/infra/database/seed';
import { redisConnectionOptions } from '../src/infra/queue/connection';
import { MAIN_QUEUE } from '../src/infra/queue/queue.constants';
import {
  MAX_RECORDING_PARTS,
  MAX_RECORDINGS_PER_SESSION,
} from '../src/modules/media/dto/media.dto';
import { buildRecordingStorageKey } from '../src/modules/media/storage-key';
import { closeWorkerDeps, createWorkerDeps } from '../src/workers/deps';
import { handleJob } from '../src/workers/handle-job';
import { createE2EApp } from './helpers/e2e-app';
import { generateSampleWebm } from './helpers/sample-media';
import { TEST_DATABASE_URL } from './helpers/test-db';

const SESSION = {
  testId: '01940000-0000-7000-8000-0000000000a1',
  participationId: '01940000-0000-7000-8000-0000000000a2',
  sessionId: '01940000-0000-7000-8000-0000000000a3',
  noConsentTestId: '01940000-0000-7000-8000-0000000000a4',
  noConsentParticipationId: '01940000-0000-7000-8000-0000000000a5',
  noConsentSessionId: '01940000-0000-7000-8000-0000000000a6',
};

const RIVAL = {
  userId: '01930000-0000-7000-8000-0000000000e1',
  orgId: '01930000-0000-7000-8000-0000000000f1',
  membershipId: '01930000-0000-7000-8000-0000000000e9',
  email: 'rival-owner@rival.dev',
};

// A genuinely valid VP8/Opus WebM (GAP-04) — the worker now runs real ffmpeg
// validation, so a fake buffer would legitimately end up `failed`, not
// `ready`. Generated once in beforeAll into WEBM_BYTES below.
let WEBM_BYTES: Buffer;
let sampleMediaDir: string;

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

describe('Media (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let worker: Worker;
  let workerDeps: Awaited<ReturnType<typeof createWorkerDeps>>;
  let playerToken: string;
  let studioToken: string;
  let rivalToken: string;

  beforeAll(async () => {
    sampleMediaDir = await mkdtemp(join(tmpdir(), 'orbitplay-media-e2e-'));
    const samplePath = join(sampleMediaDir, 'sample.webm');
    await generateSampleWebm(samplePath, { durationSeconds: 1, withAudio: true });
    WEBM_BYTES = await readFile(samplePath);

    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${RIVAL.userId}, ${RIVAL.email}, password_hash, 'Rival Owner'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${RIVAL.orgId}, 'Rival Studio', 'rival-studio', ${RIVAL.userId})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id)
      VALUES (${RIVAL.membershipId}, ${RIVAL.orgId}, ${RIVAL.userId},
              (SELECT id FROM roles WHERE key = 'owner'))
      ON CONFLICT DO NOTHING`;

    // GAME_IDS.two on purpose: games.e2e-spec asserts playersTotal === 0 for
    // GAME_IDS.one, and the participation below would count against it whenever
    // this file happens to run first.
    await sql`
      INSERT INTO tests (id, organization_id, game_id, model_key, status)
      VALUES
        (${SESSION.testId}, ${ORG_ID}, ${GAME_IDS.two}, 'free_exploration', 'published'),
        (${SESSION.noConsentTestId}, ${ORG_ID}, ${GAME_IDS.two}, 'free_exploration', 'published')
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES
        (${SESSION.participationId}, ${SESSION.testId}, ${USER_IDS.player}, 'playing'),
        (${SESSION.noConsentParticipationId}, ${SESSION.noConsentTestId}, ${USER_IDS.player}, 'playing')
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO session_consents (participation_id, screen_recording, audio, microphone, webcam, accepted_at)
      VALUES (${SESSION.participationId}, true, true, true, true, now())
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO sessions (id, participation_id, test_id, organization_id, status)
      VALUES
        (${SESSION.sessionId}, ${SESSION.participationId}, ${SESSION.testId}, ${ORG_ID}, 'recording'),
        (${SESSION.noConsentSessionId}, ${SESSION.noConsentParticipationId}, ${SESSION.noConsentTestId}, ${ORG_ID}, 'recording')
      ON CONFLICT DO NOTHING`;

    workerDeps = await createWorkerDeps();
    worker = new Worker(MAIN_QUEUE, (job) => handleJob(job, workerDeps), {
      connection: redisConnectionOptions(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    });
    await worker.waitUntilReady();

    playerToken = await bearer(app, SEED_EMAILS.player);
    studioToken = await bearer(app, SEED_EMAILS.studio);
    rivalToken = await bearer(app, RIVAL.email);
  });

  afterAll(async () => {
    await worker.close();
    await closeWorkerDeps(workerDeps);
    await sql.end({ timeout: 5 });
    await app.close();
    await rm(sampleMediaDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('uploads in parts, completes, processes, and returns playback', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/sessions/${SESSION.sessionId}/recordings/upload-url`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({
        contentType: 'video/webm',
        sizeBytes: WEBM_BYTES.length,
        partNumber: 1,
        kind: 'screen_recording',
      });
    expect(upload.status).toBe(201);
    expect(upload.body.uploadUrl).toMatch(/^https?:\/\//);
    expect(upload.body.uploadId).toBeTruthy();
    expect(upload.body.storageKey).toContain(`/sessions/${SESSION.sessionId}/recordings/screen/`);

    const put = await fetch(upload.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/webm' },
      body: WEBM_BYTES,
    });
    expect(put.ok).toBe(true);
    const etag = put.headers.get('etag');
    expect(etag).toBeTruthy();

    const complete = await request(app.getHttpServer())
      .post(`/sessions/${SESSION.sessionId}/recordings/complete`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({
        storageKey: upload.body.storageKey,
        // Deliberately wrong — the ~1s sample's real, ffprobe-measured
        // duration must win over whatever the client claims (GAP-04).
        durationMs: 999_999,
        uploadId: upload.body.uploadId,
        parts: [{ partNumber: 1, etag }],
      });
    expect(complete.status).toBe(202);
    expect(complete.body.status).toBe('processing');
    expect(complete.body.sessionId).toBe(SESSION.sessionId);
    const recordingId = complete.body.id as string;

    const processing = await request(app.getHttpServer())
      .get(`/sessions/${SESSION.sessionId}/recordings/${recordingId}/playback-url`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(processing.status).toBe(200);
    expect(['processing', 'ready']).toContain(processing.body.status);
    if (processing.body.status !== 'ready') {
      expect(processing.body.url).toBeNull();
    }

    const ready = await waitForReady(app, studioToken, SESSION.sessionId, recordingId);
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
    expect(ready.body.url).toMatch(/^https?:\/\//);
    // Real ffprobe duration for the ~1s sample, not the client's 999999.
    expect(ready.body.durationMs).toBeGreaterThan(500);
    expect(ready.body.durationMs).toBeLessThan(2000);
    // Real thumbnail generated from an actual video frame (GAP-04).
    expect(ready.body.thumbnailUrl).toMatch(/^https?:\/\//);
  });

  it('fails a recording whose upload is not actually valid media (GAP-04)', async () => {
    const garbage = Buffer.from('not a real video file');
    const upload = await request(app.getHttpServer())
      .post(`/sessions/${SESSION.sessionId}/recordings/upload-url`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({
        contentType: 'video/webm',
        sizeBytes: garbage.length,
        partNumber: 1,
        kind: 'screen_recording',
      });
    expect(upload.status).toBe(201);

    const put = await fetch(upload.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/webm' },
      body: garbage,
    });
    expect(put.ok).toBe(true);
    const etag = put.headers.get('etag');

    const complete = await request(app.getHttpServer())
      .post(`/sessions/${SESSION.sessionId}/recordings/complete`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({
        storageKey: upload.body.storageKey,
        durationMs: 1000,
        uploadId: upload.body.uploadId,
        parts: [{ partNumber: 1, etag }],
      });
    expect(complete.status).toBe(202);
    const recordingId = complete.body.id as string;

    const failed = await waitForStatus(app, studioToken, SESSION.sessionId, recordingId, 'failed');
    expect(failed.body.status).toBe('failed');
    expect(failed.body.url).toBeNull();
  });

  it('forbids studio from uploading and player from playback', async () => {
    const studioUpload = await request(app.getHttpServer())
      .post(`/sessions/${SESSION.sessionId}/recordings/upload-url`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ contentType: 'video/webm', sizeBytes: 16 });
    expect(studioUpload.status).toBe(403);

    const playerPlay = await request(app.getHttpServer())
      .get(`/sessions/${SESSION.sessionId}/recordings/${SESSION.sessionId}/playback-url`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(playerPlay.status).toBe(403);
  });

  it('returns 404 for another org and for a missing session', async () => {
    const cross = await request(app.getHttpServer())
      .get(`/sessions/${SESSION.sessionId}/recordings/${SESSION.sessionId}/playback-url`)
      .set('Authorization', `Bearer ${rivalToken}`);
    expect(cross.status).toBe(404);

    const missing = await request(app.getHttpServer())
      .post('/sessions/not-a-uuid/recordings/upload-url')
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ contentType: 'video/webm', sizeBytes: 16 });
    expect(missing.status).toBe(404);
  });

  /** A fresh session of the seeded player (own test, all consents granted). */
  async function seedSession(
    status: 'recording' | 'processing' | 'completed' | 'invalidated',
    endedMinutesAgo: number | null,
  ): Promise<string> {
    const testId = uuidv7();
    const participationId = uuidv7();
    const sessionId = uuidv7();
    await sql`
      INSERT INTO tests (id, organization_id, game_id, model_key, status)
      VALUES (${testId}, ${ORG_ID}, ${GAME_IDS.two}, 'free_exploration', 'published')`;
    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${participationId}, ${testId}, ${USER_IDS.player}, 'playing')`;
    await sql`
      INSERT INTO session_consents (participation_id, screen_recording, audio, microphone, webcam, accepted_at)
      VALUES (${participationId}, true, true, true, true, now())`;
    const endedAt =
      endedMinutesAgo === null ? null : new Date(Date.now() - endedMinutesAgo * 60_000);
    await sql`
      INSERT INTO sessions (id, participation_id, test_id, organization_id, status, ended_at)
      VALUES (${sessionId}, ${participationId}, ${testId}, ${ORG_ID}, ${status}, ${endedAt})`;
    return sessionId;
  }

  function startUpload(sessionId: string, body: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .post(`/sessions/${sessionId}/recordings/upload-url`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ contentType: 'video/webm', sizeBytes: 16, kind: 'screen_recording', ...body });
  }

  it(`422s a part number above ${MAX_RECORDING_PARTS}`, async () => {
    const res = await startUpload(SESSION.sessionId, { partNumber: MAX_RECORDING_PARTS + 1 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it(`409s a new upload once the session holds ${MAX_RECORDINGS_PER_SESSION} recordings`, async () => {
    const sessionId = await seedSession('recording', null);
    for (let i = 0; i < MAX_RECORDINGS_PER_SESSION; i += 1) {
      const id = uuidv7();
      await sql`
        INSERT INTO session_recordings (id, session_id, kind, storage_key, status)
        VALUES (${id}, ${sessionId}, 'screen',
                ${buildRecordingStorageKey(ORG_ID, sessionId, 'screen', id)}, 'ready')`;
    }

    const res = await startUpload(sessionId);
    expect(res.status).toBe(409);
  });

  it('409s new uploads for a session that ended long ago, but not right after finish', async () => {
    const old = await seedSession('completed', 3 * 60);
    expect((await startUpload(old)).status).toBe(409);

    const justFinished = await seedSession('processing', 1);
    expect((await startUpload(justFinished)).status).toBe(201);

    // `session.validate` runs right after finish: a session validated a minute
    // ago is still the normal "upload when the recorder stops" case.
    const justValidated = await seedSession('completed', 1);
    expect((await startUpload(justValidated)).status).toBe(201);
  });

  // The web uploads parts while it records: each part request renews the
  // upload session, so a recording longer than one TTL (1 h) keeps going.
  it('renews the upload session on every part request', async () => {
    const sessionId = await seedSession('recording', null);
    const first = await startUpload(sessionId, { sizeBytes: 8 * 1024 * 1024 });
    expect(first.status).toBe(201);
    const uploadId = first.body.uploadId as string;
    const uploadKey = `recording-upload:${uploadId}`;
    // As if almost an hour of parts had already gone by.
    await workerDeps.redis.pexpire(uploadKey, 5_000);

    const next = await startUpload(sessionId, {
      sizeBytes: 8 * 1024 * 1024,
      partNumber: 2,
      uploadId,
    });
    expect(next.status).toBe(201);
    expect(next.body.storageKey).toBe(first.body.storageKey);
    expect(await workerDeps.redis.pttl(uploadKey)).toBeGreaterThan(50 * 60 * 1000);
  });

  it('keeps a single recording when the same upload is completed twice at once', async () => {
    const sessionId = await seedSession('recording', null);
    const storageKey = buildRecordingStorageKey(ORG_ID, sessionId, 'screen', uuidv7());
    await workerDeps.storage.putObject(storageKey, WEBM_BYTES, 'video/webm');

    const complete = () =>
      request(app.getHttpServer())
        .post(`/sessions/${sessionId}/recordings/complete`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ storageKey, durationMs: 1000 });
    const [a, b] = await Promise.all([complete(), complete()]);

    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.body.id).toBe(a.body.id);
    const rows = await sql`SELECT id FROM session_recordings WHERE storage_key = ${storageKey}`;
    expect(rows).toHaveLength(1);
  });

  it('refuses upload without consent and incomplete complete parts', async () => {
    const noConsent = await request(app.getHttpServer())
      .post(`/sessions/${SESSION.noConsentSessionId}/recordings/upload-url`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ contentType: 'video/webm', sizeBytes: 16, kind: 'screen_recording' });
    expect(noConsent.status).toBe(422);
    expect(noConsent.body.code).toBe('VALIDATION_ERROR');

    const incomplete = await request(app.getHttpServer())
      .post(`/sessions/${SESSION.sessionId}/recordings/complete`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({
        storageKey: 'orgs/x/sessions/y/recordings/screen/z',
        durationMs: 10,
        uploadId: 'missing',
      });
    expect(incomplete.status).toBe(422);
  });
});

async function waitForReady(
  app: INestApplication,
  token: string,
  sessionId: string,
  recordingId: string,
) {
  return waitForStatus(app, token, sessionId, recordingId, 'ready');
}

/** Polls playback-url until `status` matches `target`, or the opposite terminal state, or it times out. */
async function waitForStatus(
  app: INestApplication,
  token: string,
  sessionId: string,
  recordingId: string,
  target: 'ready' | 'failed',
) {
  const otherTerminal = target === 'ready' ? 'failed' : 'ready';
  for (let i = 0; i < 40; i += 1) {
    const res = await request(app.getHttpServer())
      .get(`/sessions/${sessionId}/recordings/${recordingId}/playback-url`)
      .set('Authorization', `Bearer ${token}`);
    if (res.status === 200 && res.body.status === target) return res;
    if (res.status === 200 && res.body.status === otherTerminal) {
      throw new Error(`recording ended as ${otherTerminal}, expected ${target}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`timeout waiting for recording to become ${target}`);
}
