import type { INestApplication } from '@nestjs/common';
import { Worker } from 'bullmq';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, ORG_ID, SEED_EMAILS, SEED_PASSWORD, USER_IDS } from '../src/infra/database/seed';
import { MAIN_QUEUE } from '../src/infra/queue/queue.constants';
import { closeWorkerDeps, createWorkerDeps } from '../src/workers/deps';
import { handleJob } from '../src/workers/handle-job';
import { createE2EApp } from './helpers/e2e-app';
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

const WEBM_BYTES = Buffer.from('webm-fixture');

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

    await sql`
      INSERT INTO tests (id, organization_id, game_id, model_key, status)
      VALUES
        (${SESSION.testId}, ${ORG_ID}, ${GAME_IDS.one}, 'free_exploration', 'published'),
        (${SESSION.noConsentTestId}, ${ORG_ID}, ${GAME_IDS.one}, 'free_exploration', 'published')
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
    const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
    worker = new Worker(MAIN_QUEUE, (job) => handleJob(job, workerDeps), {
      connection: {
        host: redisUrl.hostname,
        port: Number(redisUrl.port || 6379),
        maxRetriesPerRequest: null,
      },
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
        durationMs: 1500,
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
    expect(ready.body.durationMs).toBe(1500);
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
  for (let i = 0; i < 40; i += 1) {
    const res = await request(app.getHttpServer())
      .get(`/sessions/${sessionId}/recordings/${recordingId}/playback-url`)
      .set('Authorization', `Bearer ${token}`);
    if (res.status === 200 && res.body.status === 'ready') return res;
    if (res.status === 200 && res.body.status === 'failed') {
      throw new Error('recording ended as failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('timeout waiting for recording to become ready');
}
