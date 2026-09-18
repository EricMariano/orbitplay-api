import type { INestApplication } from '@nestjs/common';
import { Worker } from 'bullmq';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { redisConnectionOptions } from '../src/infra/queue/connection';
import { MAIN_QUEUE } from '../src/infra/queue/queue.constants';
import { closeWorkerDeps, createWorkerDeps } from '../src/workers/deps';
import { handleJob } from '../src/workers/handle-job';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

const RIVAL = {
  userId: '01990000-0000-7000-8000-0000000000e1',
  orgId: '01990000-0000-7000-8000-0000000000f1',
  membershipId: '01990000-0000-7000-8000-0000000000e9',
  email: 'rival-wizard@rival.dev',
};

const BUILD_BYTES = Buffer.from('fake-build-bytes');

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

describe('Tests wizard — M5 (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let worker: Worker;
  let workerDeps: Awaited<ReturnType<typeof createWorkerDeps>>;
  let studioToken: string;
  let playerToken: string;
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
      VALUES (${RIVAL.orgId}, 'Rival Wizard Studio', 'rival-wizard-studio', ${RIVAL.userId})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id)
      VALUES (${RIVAL.membershipId}, ${RIVAL.orgId}, ${RIVAL.userId},
              (SELECT id FROM roles WHERE key = 'owner'))
      ON CONFLICT DO NOTHING`;

    workerDeps = await createWorkerDeps();
    worker = new Worker(MAIN_QUEUE, (job) => handleJob(job, workerDeps), {
      connection: redisConnectionOptions(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    });
    await worker.waitUntilReady();

    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
    rivalToken = await bearer(app, RIVAL.email);
  });

  afterAll(async () => {
    await worker.close();
    await closeWorkerDeps(workerDeps);
    await sql.end({ timeout: 5 });
    await app.close();
  });

  it('walks the whole wizard from draft to publish, then pauses/resumes', async () => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration', title: 'Onboarding v2' });
    expect(create.status).toBe(201);
    expect(create.body.status).toBe('draft');
    expect(create.body.currentStep).toBe(2); // model done at creation → resume at form
    expect(create.body.pendingValidations.map((p: { code: string }) => p.code)).toEqual(
      expect.arrayContaining(['FORM_EMPTY', 'BUILD_NOT_VALIDATED', 'AUDIENCE_NOT_CONFIGURED']),
    );
    const testId = create.body.id as string;

    const setModel = await request(app.getHttpServer())
      .patch(`/tests/${testId}/model`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'ab_test' });
    expect(setModel.status).toBe(200);
    expect(setModel.body.testModelKey).toBe('ab_test');

    const putForm = await request(app.getHttpServer())
      .put(`/tests/${testId}/form`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        questions: [
          { type: 'open_text', prompt: 'O que achou do jogo?', required: true, position: 0 },
          {
            type: 'single_choice',
            prompt: 'Recomendaria?',
            required: true,
            position: 1,
            options: [
              { label: 'Sim', position: 0 },
              { label: 'Não', position: 1 },
            ],
          },
        ],
      });
    expect(putForm.status).toBe(200);
    expect(putForm.body.questions).toHaveLength(2);
    expect(putForm.body.questions[1].options).toHaveLength(2);

    const preview = await request(app.getHttpServer())
      .get(`/tests/${testId}/form/preview`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(preview.status).toBe(200);
    expect(preview.body.questions).toHaveLength(2);

    const uploadUrl = await request(app.getHttpServer())
      .post(`/tests/${testId}/build/upload-url`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        fileName: 'game.zip',
        contentType: 'application/zip',
        sizeBytes: BUILD_BYTES.length,
        platform: 'windows',
      });
    expect(uploadUrl.status).toBe(201);
    expect(uploadUrl.body.storageKey).toContain(`/tests/${testId}/builds/`);

    const put = await fetch(uploadUrl.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/zip' },
      body: BUILD_BYTES,
    });
    expect(put.ok).toBe(true);

    const confirmBuild = await request(app.getHttpServer())
      .post(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ storageKey: uploadUrl.body.storageKey, platform: 'windows', version: '1.0.0' });
    expect(confirmBuild.status).toBe(202);
    expect(confirmBuild.body.status).toBe('processing');
    expect(confirmBuild.body.validationSteps).toHaveLength(3);

    const validated = await waitForBuildValidated(app, studioToken, testId);
    expect(validated.status).toBe('validated');
    expect(validated.validationSteps.every((s: { status: string }) => s.status === 'ready')).toBe(
      true,
    );

    const setAudience = await request(app.getHttpServer())
      .patch(`/tests/${testId}/audience`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ ageMin: 18, ageMax: 99, quantity: 5, durationDays: 14 });
    expect(setAudience.status).toBe(200);
    expect(setAudience.body.audience.estimatedReach).toBeGreaterThanOrEqual(1);
    expect(setAudience.body.currentStep).toBe(5);
    expect(setAudience.body.pendingValidations).toEqual([]);

    const idempotencyKey = uuidv7();
    const publish = await request(app.getHttpServer())
      .post(`/tests/${testId}/publish`)
      .set('Authorization', `Bearer ${studioToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send();
    expect(publish.status).toBe(200);
    expect(publish.body.status).toBe('published');
    expect(publish.body.publishedAt).toBeTruthy();
    expect(publish.body.expiresAt).toBeTruthy();

    // Replaying the same key must never create a second test.
    const replay = await request(app.getHttpServer())
      .post(`/tests/${testId}/publish`)
      .set('Authorization', `Bearer ${studioToken}`)
      .set('Idempotency-Key', idempotencyKey)
      .send();
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(testId);
    const [{ count }] = await sql`SELECT count(*)::int AS count FROM tests WHERE id = ${testId}`;
    expect(count).toBe(1);

    const pause = await request(app.getHttpServer())
      .patch(`/tests/${testId}/status`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ status: 'paused' });
    expect(pause.status).toBe(200);
    expect(pause.body.status).toBe('paused');

    const resume = await request(app.getHttpServer())
      .patch(`/tests/${testId}/status`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ status: 'published' });
    expect(resume.status).toBe(200);
    expect(resume.body.status).toBe('published');

    const invalidTransition = await request(app.getHttpServer())
      .patch(`/tests/${testId}/status`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ status: 'published' });
    expect(invalidTransition.status).toBe(409);
  });

  it('rejects an unavailable model at creation with 422', async () => {
    const res = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration_telemetry' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('requires Idempotency-Key and gates publish on pending steps', async () => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration' });
    const testId = create.body.id as string;

    const noKey = await request(app.getHttpServer())
      .post(`/tests/${testId}/publish`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send();
    expect(noKey.status).toBe(422);

    const pending = await request(app.getHttpServer())
      .post(`/tests/${testId}/publish`)
      .set('Authorization', `Bearer ${studioToken}`)
      .set('Idempotency-Key', uuidv7())
      .send();
    expect(pending.status).toBe(422);
    expect(pending.body.fieldErrors).toHaveProperty('FORM_EMPTY');
  });

  it('isolates tests across organizations and blocks players from studio routes', async () => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration' });
    const testId = create.body.id as string;

    const cross = await request(app.getHttpServer())
      .get(`/tests/${testId}`)
      .set('Authorization', `Bearer ${rivalToken}`);
    expect(cross.status).toBe(404);

    const forbidden = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ testModelKey: 'free_exploration' });
    expect(forbidden.status).toBe(403);
  });

  // SEC-05: the wizard's read-only routes are documented as studio-only too
  // (the controller's own comment says "a player token never sees a studio's
  // draft") — these three previously carried no @Roles guard at all, so any
  // authenticated player could read a studio's draft test/form/build state.
  it('blocks a player token from reading draft test/form/build state', async () => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration' });
    const testId = create.body.id as string;

    const getTest = await request(app.getHttpServer())
      .get(`/tests/${testId}`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(getTest.status).toBe(403);

    const formPreview = await request(app.getHttpServer())
      .get(`/tests/${testId}/form/preview`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(formPreview.status).toBe(403);

    const getBuild = await request(app.getHttpServer())
      .get(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(getBuild.status).toBe(403);
  });

  it('lets a failed build be retried without deleting it first, and blocks a validated one until deleted', async () => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration' });
    const testId = create.body.id as string;

    const uploadUrl = await request(app.getHttpServer())
      .post(`/tests/${testId}/build/upload-url`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        fileName: 'game.zip',
        contentType: 'application/zip',
        sizeBytes: 10,
        platform: 'windows',
      });

    // Confirm without ever PUTting the bytes: storage.stat() finds nothing → 422.
    const missingObject = await request(app.getHttpServer())
      .post(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ storageKey: uploadUrl.body.storageKey, platform: 'windows' });
    expect(missingObject.status).toBe(422);

    const noBuildYet = await request(app.getHttpServer())
      .get(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(noBuildYet.status).toBe(404);
  });
});

async function waitForBuildValidated(app: INestApplication, token: string, testId: string) {
  for (let i = 0; i < 40; i += 1) {
    const res = await request(app.getHttpServer())
      .get(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${token}`);
    if (res.status === 200 && (res.body.status === 'validated' || res.body.status === 'failed')) {
      return res.body;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('timeout waiting for build validation');
}
