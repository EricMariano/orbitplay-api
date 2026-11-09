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

// Starts with the zip signature — the build worker sniffs magic bytes against
// the declared `.zip` extension.
const BUILD_BYTES = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('fake-build-bytes'),
]);

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

  // Regression: PUT form / PATCH audience used to write their child rows on a
  // separate connection while `withRowLock` held `FOR UPDATE` on the test —
  // the FK check (`FOR KEY SHARE`) waited on that lock forever. A build-less
  // model reaches publish without depending on the build worker.
  it('saves form and audience under the row lock and publishes a build-less model', async () => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'ab_test_images', title: 'Capas A/B' });
    expect(create.status).toBe(201);
    const testId = create.body.id as string;

    const putForm = await request(app.getHttpServer())
      .put(`/tests/${testId}/form`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        questions: [
          {
            type: 'open_text',
            prompt: 'Qual capa chamou mais atenção?',
            required: true,
            position: 0,
          },
        ],
      });
    expect(putForm.status).toBe(200);
    expect(putForm.body.questions).toHaveLength(1);

    const setAudience = await request(app.getHttpServer())
      .patch(`/tests/${testId}/audience`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ ageMin: 18, ageMax: 99, quantity: 5, durationDays: 7 });
    expect(setAudience.status).toBe(200);
    expect(setAudience.body.pendingValidations).toEqual([]);

    const publish = await request(app.getHttpServer())
      .post(`/tests/${testId}/publish`)
      .set('Authorization', `Bearer ${studioToken}`)
      .set('Idempotency-Key', uuidv7())
      .send();
    expect(publish.status).toBe(200);
    expect(publish.body.status).toBe('published');
    expect(publish.body.spotsTotal).toBe(5);

    // Regression: the wizard used to leave `slots_total` at 0, so a test
    // published through it answered every join with 409 "Vagas esgotadas".
    const join = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(join.status).toBe(201);
    expect(join.body.status).toBe('reserved');
    // The seed player and games are shared by every e2e file (games.e2e asserts
    // `playersTotal = 0` on this game), so don't leave the participation behind.
    await sql`DELETE FROM participations WHERE id = ${join.body.id as string}`;
  });

  it('rejects an unavailable model at creation with 422', async () => {
    const res = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration_telemetry' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // The report lays out one bucket per scale step: an unbounded range let any
  // studio make `GET /tests/:id/report` allocate a giant array.
  it.each([
    ['beyond 0–10', { scaleMin: -1_000_000_000, scaleMax: 1_000_000_000 }],
    ['an inverted range', { scaleMin: 5, scaleMax: 1 }],
  ])('rejects a scale question with %s with 422', async (_label, scale) => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration', title: 'Escala inválida' });
    expect(create.status).toBe(201);

    const res = await request(app.getHttpServer())
      .put(`/tests/${create.body.id as string}/form`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        questions: [{ type: 'scale', prompt: 'Nota?', required: true, position: 0, ...scale }],
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  // Past int4 these used to reach the `integer` columns and answer 500.
  it('rejects wizard numbers past the column range with 422', async () => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration', title: 'Números grandes' });
    const testId = create.body.id as string;

    const form = await request(app.getHttpServer())
      .put(`/tests/${testId}/form`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        questions: [
          { type: 'open_text', prompt: 'E aí?', required: true, position: 3_000_000_000 },
        ],
      });
    expect(form.status).toBe(422);

    const audience = await request(app.getHttpServer())
      .patch(`/tests/${testId}/audience`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ ageMin: 18, ageMax: 60, quantity: 3_000_000_000, durationDays: 7 });
    expect(audience.status).toBe(422);
  });

  it('rejects two options at the same position with 422, not 500', async () => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration', title: 'Opções repetidas' });

    const res = await request(app.getHttpServer())
      .put(`/tests/${create.body.id as string}/form`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        questions: [
          {
            type: 'single_choice',
            prompt: 'Qual fase?',
            required: true,
            position: 0,
            options: [
              { label: 'Fase 1', position: 0 },
              { label: 'Fase 2', position: 0 },
            ],
          },
        ],
      });
    expect(res.status).toBe(422);
  });

  // A paused test could drop its build and then be resumed with nothing for
  // its players to download.
  it('keeps the build of a paused test: DELETE is 409', async () => {
    const testId = uuidv7();
    const buildId = uuidv7();
    await sql`
      INSERT INTO tests (id, organization_id, game_id, model_key, status, slots_total, slots_taken)
      VALUES (${testId}, (SELECT organization_id FROM games WHERE id = ${GAME_IDS.one}),
              ${GAME_IDS.one}, 'free_exploration', 'paused', 5, 0)`;
    await sql`
      INSERT INTO builds (id, organization_id, test_id, file_name, storage_key, status)
      VALUES (${buildId}, (SELECT organization_id FROM games WHERE id = ${GAME_IDS.one}),
              ${testId}, 'game.zip', ${`orgs/x/tests/${testId}/builds/${buildId}/game.zip`},
              'validated')`;

    const res = await request(app.getHttpServer())
      .delete(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(res.status).toBe(409);

    const kept = await sql`SELECT id FROM builds WHERE id = ${buildId}`;
    expect(kept).toHaveLength(1);
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

  // The worker's immutable copy lives one segment deeper than an upload key
  // (`.../builds/<id>/validated/<file>`): a client confirming such a key would
  // make a never-scanned object look like an approved copy.
  it('refuses to confirm a key shaped like the validated copy (raw `/` in the file name)', async () => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration' });
    const testId = create.body.id as string;
    const orgId = create.body.organizationId as string;

    const res = await request(app.getHttpServer())
      .post(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        storageKey: `orgs/${orgId}/tests/${testId}/builds/${uuidv7()}/validated/game.zip`,
        platform: 'windows',
      });
    expect(res.status).toBe(422);
  });

  it('DELETE removes the validated copy and the upload, even one re-PUT after validation', async () => {
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
        sizeBytes: BUILD_BYTES.length,
        platform: 'windows',
      });
    const uploadKey = uploadUrl.body.storageKey as string;
    const putBytes = () =>
      fetch(uploadUrl.body.uploadUrl as string, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/zip' },
        body: BUILD_BYTES,
      });
    expect((await putBytes()).ok).toBe(true);
    const confirm = await request(app.getHttpServer())
      .post(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ storageKey: uploadKey, platform: 'windows' });
    expect(confirm.status).toBe(202);
    const validated = await waitForBuildValidated(app, studioToken, testId);
    expect(validated.status).toBe('validated');

    const [row] = await sql`SELECT storage_key FROM builds WHERE id = ${validated.id as string}`;
    const validatedKey = row.storage_key as string;
    expect(validatedKey).toContain('/validated/');
    // Re-created through the still-live URL: referenced by no row, still the build's.
    expect((await putBytes()).ok).toBe(true);

    const del = await request(app.getHttpServer())
      .delete(`/tests/${testId}/build`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(del.status).toBe(204);
    expect(await workerDeps.storage.stat(validatedKey)).toBeNull();
    expect(await workerDeps.storage.stat(uploadKey)).toBeNull();
  });

  // `tests_publish_idempotency_key_unique` is global: a key already spent on
  // another test used to come back as 200 with this test still a draft.
  it('answers 409, not a 200 draft, when the Idempotency-Key was already spent on another test', async () => {
    const readyBuildlessTest = async (title: string): Promise<string> => {
      const create = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.one}/tests`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ testModelKey: 'ab_test_images', title });
      const testId = create.body.id as string;
      const form = await request(app.getHttpServer())
        .put(`/tests/${testId}/form`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({
          questions: [{ type: 'open_text', prompt: 'Qual capa?', required: true, position: 0 }],
        });
      expect(form.status).toBe(200);
      const audience = await request(app.getHttpServer())
        .patch(`/tests/${testId}/audience`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ ageMin: 18, ageMax: 99, quantity: 1, durationDays: 7 });
      expect(audience.body.pendingValidations).toEqual([]);
      return testId;
    };
    const first = await readyBuildlessTest('Capas A');
    const second = await readyBuildlessTest('Capas B');
    const key = uuidv7();

    const publishFirst = await request(app.getHttpServer())
      .post(`/tests/${first}/publish`)
      .set('Authorization', `Bearer ${studioToken}`)
      .set('Idempotency-Key', key)
      .send();
    expect(publishFirst.status).toBe(200);

    const reused = await request(app.getHttpServer())
      .post(`/tests/${second}/publish`)
      .set('Authorization', `Bearer ${studioToken}`)
      .set('Idempotency-Key', key)
      .send();
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('CONFLICT');

    const stillDraft = await request(app.getHttpServer())
      .get(`/tests/${second}`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(stillDraft.body.status).toBe('draft');

    const freshKey = await request(app.getHttpServer())
      .post(`/tests/${second}/publish`)
      .set('Authorization', `Bearer ${studioToken}`)
      .set('Idempotency-Key', uuidv7())
      .send();
    expect(freshKey.status).toBe(200);
    expect(freshKey.body.status).toBe('published');
  });

  it('caps the form at 100 questions and 50 options per question (422)', async () => {
    const create = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration', title: 'Formulário enorme' });
    const testId = create.body.id as string;

    const tooManyQuestions = await request(app.getHttpServer())
      .put(`/tests/${testId}/form`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        questions: Array.from({ length: 101 }, (_, position) => ({
          type: 'open_text',
          prompt: `Pergunta ${position}`,
          required: false,
          position,
        })),
      });
    expect(tooManyQuestions.status).toBe(422);

    const tooManyOptions = await request(app.getHttpServer())
      .put(`/tests/${testId}/form`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        questions: [
          {
            type: 'single_choice',
            prompt: 'Qual?',
            required: true,
            position: 0,
            options: Array.from({ length: 51 }, (_, position) => ({
              label: `Opção ${position}`,
              position,
            })),
          },
        ],
      });
    expect(tooManyOptions.status).toBe(422);

    // At the caps the batched insert still saves everything, in input order
    // (99 + 1 with 50 options keeps the body under Express's 100kb JSON limit).
    const atCaps = await request(app.getHttpServer())
      .put(`/tests/${testId}/form`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        questions: [
          ...Array.from({ length: 99 }, (_, position) => ({
            type: 'open_text',
            prompt: `Pergunta ${position}`,
            required: false,
            position,
          })),
          {
            type: 'multiple_choice',
            prompt: 'Pergunta 99',
            required: false,
            position: 99,
            options: Array.from({ length: 50 }, (_, position) => ({
              label: `Opção ${49 - position}`,
              position: 49 - position,
            })),
          },
        ],
      });
    expect(atCaps.status).toBe(200);
    expect(atCaps.body.questions).toHaveLength(100);
    expect(atCaps.body.questions[0].prompt).toBe('Pergunta 0');
    expect(atCaps.body.questions[99].prompt).toBe('Pergunta 99');
    expect(atCaps.body.questions[99].options).toHaveLength(50);
    expect(atCaps.body.questions[99].options[0]).toMatchObject({ label: 'Opção 0', position: 0 });
    expect(atCaps.body.questions[98].options).toEqual([]);
  });

  it('returns 404 (not 500) for a malformed test id on a row-locked wizard step (VAL-01)', async () => {
    const res = await request(app.getHttpServer())
      .patch('/tests/not-a-uuid/model')
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration' });
    expect(res.status).toBe(404);
  });

  // M3's loose end (STATUS-IMPLEMENTACAO.md): GET /games/:id/tests (Tela 05).
  // Seeded directly via SQL (not the wizard) so each status is deterministic —
  // GAME_IDS.two, untouched by the other its in this file.
  describe('GET /games/:id/tests (Tela 05)', () => {
    const draftId = '01990000-0000-7000-8000-00000000aa01';
    const publishedId = '01990000-0000-7000-8000-00000000aa02';
    const finishedId = '01990000-0000-7000-8000-00000000aa03';

    beforeAll(async () => {
      await sql`
        INSERT INTO tests (id, organization_id, game_id, model_key, status)
        VALUES
          (${draftId}, (SELECT organization_id FROM games WHERE id = ${GAME_IDS.two}), ${GAME_IDS.two}, 'free_exploration', 'draft'),
          (${publishedId}, (SELECT organization_id FROM games WHERE id = ${GAME_IDS.two}), ${GAME_IDS.two}, 'free_exploration', 'published'),
          (${finishedId}, (SELECT organization_id FROM games WHERE id = ${GAME_IDS.two}), ${GAME_IDS.two}, 'free_exploration', 'finished')
        ON CONFLICT DO NOTHING`;
    });

    it('defaults to tab=active — draft/published, not finished', async () => {
      const res = await request(app.getHttpServer())
        // limit=100: other spec files also create tests on GAME_IDS.two, and these
        // fixed (older) ids would fall off the default 20-row first page.
        .get(`/games/${GAME_IDS.two}/tests?limit=100`)
        .set('Authorization', `Bearer ${studioToken}`);
      expect(res.status).toBe(200);
      const ids = res.body.data.map((t: { id: string }) => t.id);
      expect(ids).toEqual(expect.arrayContaining([draftId, publishedId]));
      expect(ids).not.toContain(finishedId);
    });

    it('tab=all includes finished too', async () => {
      const res = await request(app.getHttpServer())
        .get(`/games/${GAME_IDS.two}/tests?tab=all&limit=100`)
        .set('Authorization', `Bearer ${studioToken}`);
      expect(res.body.data.map((t: { id: string }) => t.id)).toEqual(
        expect.arrayContaining([draftId, publishedId, finishedId]),
      );
    });

    it('status= narrows to one exact status, overriding tab', async () => {
      const res = await request(app.getHttpServer())
        .get(`/games/${GAME_IDS.two}/tests?status=finished`)
        .set('Authorization', `Bearer ${studioToken}`);
      // Other spec files share GAME_IDS.two (sessions.e2e finishes a test of
      // its own there): assert the filter, not the exact set of tests.
      const tests = res.body.data as { id: string; status: string }[];
      expect(tests.map((t) => t.id)).toContain(finishedId);
      expect(tests.every((t) => t.status === 'finished')).toBe(true);
    });

    it("a rival org gets 404, not another studio's tests", async () => {
      const res = await request(app.getHttpServer())
        .get(`/games/${GAME_IDS.two}/tests`)
        .set('Authorization', `Bearer ${rivalToken}`);
      expect(res.status).toBe(404);
    });

    it('a player token is refused — studio-only', async () => {
      const res = await request(app.getHttpServer())
        .get(`/games/${GAME_IDS.two}/tests`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.status).toBe(403);
    });

    it('404s for a non-existent game', async () => {
      const res = await request(app.getHttpServer())
        .get('/games/01994000-0000-7000-8000-00000000ffff/tests')
        .set('Authorization', `Bearer ${studioToken}`);
      expect(res.status).toBe(404);
    });
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
