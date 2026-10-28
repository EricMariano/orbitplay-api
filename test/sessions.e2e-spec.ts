import type { INestApplication } from '@nestjs/common';
import { Worker } from 'bullmq';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS } from '../src/infra/database/seed';
import { redisConnectionOptions } from '../src/infra/queue/connection';
import { MAIN_QUEUE } from '../src/infra/queue/queue.constants';
import { closeWorkerDeps, createWorkerDeps } from '../src/workers/deps';
import { handleJob } from '../src/workers/handle-job';
import { processReconcileStuckJobs } from '../src/workers/reconcile.processor';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

const PLAYER_PASSWORD = 'Sessions@Test123';

/**
 * A dedicated, freshly-signed-up player (not `SEED_EMAILS.player`): this
 * suite's happy path actually credits real XP via `xp_events`
 * (`session.processor.ts`), which would otherwise leak into the seeded
 * player's ledger and desync `gamification.e2e-spec.ts`'s own assertions
 * about it.
 */
async function signupPlayer(app: INestApplication): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/signup/player')
    .send({
      displayName: 'Sessions E2E Player',
      email: `sessions-e2e-${uuidv7()}@orbitplay.test`,
      password: PLAYER_PASSWORD,
      birthdate: '1995-06-15',
    });
  expect(res.status).toBe(201);
  return res.body.accessToken as string;
}

/**
 * M7-04/05/06 — session lifecycle end to end. GAM_IDS.two, like
 * builds.e2e-spec.ts, to keep games.e2e-spec's playersTotal===0 assertion
 * for GAME_IDS.one intact.
 *
 * The build validation worker always fails a real build's `malware_scan`
 * step (no scanner integrated — `build.processor.ts` fails closed on
 * purpose), so a build can never actually reach `validated` through that
 * pipeline in this environment. This suite seeds an already-`validated`
 * build directly via SQL instead — same pre-M7 seeding pattern already used
 * for `tests`/`participations`/`sessions` fixtures elsewhere (e.g.
 * `tests-wizard.e2e-spec.ts`'s `GET /games/:id/tests` fixtures).
 */
describe('Sessions — M7-03/04/05/06 (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let worker: Worker;
  let workerDeps: Awaited<ReturnType<typeof createWorkerDeps>>;
  let playerToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    workerDeps = await createWorkerDeps();
    worker = new Worker(MAIN_QUEUE, (job) => handleJob(job, workerDeps), {
      connection: redisConnectionOptions(process.env.REDIS_URL ?? 'redis://localhost:6379'),
    });
    await worker.waitUntilReady();

    playerToken = await signupPlayer(app);
  });

  afterAll(async () => {
    await worker.close();
    await closeWorkerDeps(workerDeps);
    await sql.end({ timeout: 5 });
    await app.close();
  });

  async function seedReadyTest(): Promise<{ testId: string; questionId: string }> {
    const testId = uuidv7();
    const buildId = uuidv7();
    const questionId = uuidv7();

    await sql`
      INSERT INTO tests (id, organization_id, game_id, model_key, status, slots_total, slots_taken)
      VALUES (
        ${testId},
        (SELECT organization_id FROM games WHERE id = ${GAME_IDS.two}),
        ${GAME_IDS.two},
        'free_exploration',
        'published',
        5,
        0
      )`;
    await sql`
      INSERT INTO builds (id, organization_id, test_id, file_name, storage_key, status)
      VALUES (
        ${buildId},
        (SELECT organization_id FROM games WHERE id = ${GAME_IDS.two}),
        ${testId},
        'game.zip',
        ${`orgs/x/tests/${testId}/builds/${buildId}/game.zip`},
        'validated'
      )`;
    await sql`
      INSERT INTO test_form_questions (id, test_id, type, label, required, position)
      VALUES (${questionId}, ${testId}, 'open_text', 'O que achou?', true, 0)`;

    return { testId, questionId };
  }

  async function joinAndStart(
    testId: string,
  ): Promise<{ participationId: string; sessionId: string }> {
    const join = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(join.status).toBe(201);
    const participationId = join.body.id as string;

    const consent = await request(app.getHttpServer())
      .post(`/participations/${participationId}/consents`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ consents: [{ kind: 'screen_recording', granted: true }] });
    expect(consent.status).toBe(201);
    expect(consent.body.allRequiredGranted).toBe(true);

    const start = await request(app.getHttpServer())
      .post(`/participations/${participationId}/sessions`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ buildVersion: '1.0.0', platform: 'windows' });
    expect(start.status).toBe(201);
    expect(start.body.recordingRequired).toBe(true);

    return { participationId, sessionId: start.body.sessionId as string };
  }

  async function waitForResult(
    participationId: string,
    predicate: (status: string) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/participations/${participationId}/result`)
        .set('Authorization', `Bearer ${playerToken}`);
      if (res.status === 200 && predicate(res.body.status as string)) return res.body;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('timeout waiting for participation result');
  }

  it('walks tutorial → consents → session → devices/heartbeat → finish → form → result (valid)', async () => {
    const { testId, questionId } = await seedReadyTest();

    const join = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(join.status).toBe(201);
    const participationId = join.body.id as string;

    const tutorial = await request(app.getHttpServer())
      .get(`/participations/${participationId}/tutorial`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(tutorial.status).toBe(200);
    expect(tutorial.body.requiredConsents).toContain('screen_recording');

    const consent = await request(app.getHttpServer())
      .post(`/participations/${participationId}/consents`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ consents: [{ kind: 'screen_recording', granted: true }] });
    expect(consent.status).toBe(201);

    const start = await request(app.getHttpServer())
      .post(`/participations/${participationId}/sessions`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ buildVersion: '1.0.0', platform: 'windows' });
    expect(start.status).toBe(201);
    const sessionId = start.body.sessionId as string;

    const gameplay = await request(app.getHttpServer())
      .get(`/sessions/${sessionId}/gameplay`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(gameplay.status).toBe(200);
    expect(gameplay.body).toMatchObject({
      session: { id: sessionId, participationId, status: 'active' },
      test: { id: testId },
      game: { id: GAME_IDS.two },
      heartbeatIntervalMs: 15_000,
      recordingRequired: true,
    });

    const devices = await request(app.getHttpServer())
      .patch(`/sessions/${sessionId}/devices`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ kind: 'webcam', enabled: true, tMs: 500 });
    expect(devices.status).toBe(204);

    const heartbeat = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/heartbeat`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ tMs: 1000 });
    expect(heartbeat.status).toBe(204);

    const finish = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/finish`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ tMs: 12_000, confirmed: true });
    expect(finish.status).toBe(200);
    expect(finish.body.status).toBe('in_review');

    const secondFinish = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/finish`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ tMs: 13_000, confirmed: true });
    expect(secondFinish.status).toBe(409);

    const summary = await request(app.getHttpServer())
      .get(`/sessions/${sessionId}/summary`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(summary.status).toBe(200);
    expect(summary.body.form.questions).toHaveLength(1);
    expect(summary.body.alreadySubmitted).toBe(false);
    expect(summary.body.game.id).toBe(GAME_IDS.two);

    const missingAnswer = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/form-response`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ answers: [] });
    expect(missingAnswer.status).toBe(422);
    expect(missingAnswer.body.fieldErrors[questionId]).toBeTruthy();

    const formResponse = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/form-response`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ answers: [{ questionId, value: 'Muito bom' }] });
    expect(formResponse.status).toBe(201);

    const duplicateResponse = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/form-response`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ answers: [{ questionId, value: 'de novo' }] });
    expect(duplicateResponse.status).toBe(409);

    const result = await waitForResult(participationId, (s) => s !== 'in_review');
    expect(result.status).toBe('completed');
    expect(result.xpEarned).toBeGreaterThan(0);
    expect(result.rewardStatus).toBe('pending');
  });

  // A rating past int4 used to break the studio's report for good, and a
  // foreign question id landed in another test's answers.
  it("422s answers that don't fit the form (wrong type, foreign question)", async () => {
    const { testId, questionId } = await seedReadyTest();
    const { sessionId } = await joinAndStart(testId);

    const wrongType = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/form-response`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ answers: [{ questionId, value: 3_000_000_000 }] });
    expect(wrongType.status).toBe(422);
    expect(wrongType.body.fieldErrors[questionId]).toBeTruthy();

    const foreignId = uuidv7();
    const foreign = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/form-response`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({
        answers: [
          { questionId, value: 'ok' },
          { questionId: foreignId, value: 'x' },
        ],
      });
    expect(foreign.status).toBe(422);
    expect(foreign.body.fieldErrors[foreignId]).toBeTruthy();
  });

  // The web sends a single choice as the option id; stored as text, the
  // report never counted it and the session detail showed the raw id.
  it('stores a single-choice answer in option_ids, where the report counts it', async () => {
    const { testId, questionId } = await seedReadyTest();
    const choiceId = uuidv7();
    const optionId = uuidv7();
    await sql`
      INSERT INTO test_form_questions (id, test_id, type, label, required, position)
      VALUES (${choiceId}, ${testId}, 'single_choice', 'Qual fase?', true, 1)`;
    await sql`
      INSERT INTO test_form_options (id, question_id, label, position)
      VALUES (${optionId}, ${choiceId}, 'Fase 1', 0), (${uuidv7()}, ${choiceId}, 'Fase 2', 1)`;
    const { sessionId } = await joinAndStart(testId);

    const res = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/form-response`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({
        answers: [
          { questionId, value: 'ok' },
          { questionId: choiceId, value: optionId },
        ],
      });
    expect(res.status).toBe(201);

    const [answer] = await sql`
      SELECT value_text, option_ids FROM form_answers WHERE question_id = ${choiceId}`;
    expect(answer.value_text).toBeNull();
    expect(answer.option_ids).toEqual([optionId]);
  });

  it('409s starting a session without consents recorded', async () => {
    const { testId } = await seedReadyTest();
    const join = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    const participationId = join.body.id as string;

    const start = await request(app.getHttpServer())
      .post(`/participations/${participationId}/sessions`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ buildVersion: '1.0.0', platform: 'windows' });
    expect(start.status).toBe(409);
  });

  async function finishAndWaitCompleted(participationId: string, sessionId: string) {
    const finish = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/finish`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ tMs: 1, confirmed: true });
    expect(finish.status).toBe(200);
    const result = await waitForResult(participationId, (s) => s === 'completed');
    expect(result.status).toBe('completed');
  }

  async function sessionXpEventsForTest(testId: string): Promise<number> {
    const [row] = await sql`
      SELECT count(*)::int AS n FROM xp_events x
      JOIN sessions s ON s.id = x.source_id
      WHERE x.source_type = 'session' AND s.test_id = ${testId}`;
    return row.n as number;
  }

  it('refuses a second session on an already played participation', async () => {
    const { testId } = await seedReadyTest();
    const { participationId, sessionId } = await joinAndStart(testId);
    await finishAndWaitCompleted(participationId, sessionId);

    const again = await request(app.getHttpServer())
      .post(`/participations/${participationId}/sessions`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ buildVersion: '1.0.0', platform: 'windows' });
    expect(again.status).toBe(409);
    expect(await sessionXpEventsForTest(testId)).toBe(1);
  });

  it('credits session XP once per test even after joining the test again', async () => {
    const { testId } = await seedReadyTest();
    const first = await joinAndStart(testId);
    await finishAndWaitCompleted(first.participationId, first.sessionId);

    const second = await joinAndStart(testId);
    await finishAndWaitCompleted(second.participationId, second.sessionId);

    expect(await sessionXpEventsForTest(testId)).toBe(1);
  });

  it('409s starting a session once the test is finished', async () => {
    const { testId } = await seedReadyTest();
    const join = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    const participationId = join.body.id as string;
    await request(app.getHttpServer())
      .post(`/participations/${participationId}/consents`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ consents: [{ kind: 'screen_recording', granted: true }] });
    await sql`UPDATE tests SET status = 'finished' WHERE id = ${testId}`;

    const start = await request(app.getHttpServer())
      .post(`/participations/${participationId}/sessions`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ buildVersion: '1.0.0', platform: 'windows' });
    expect(start.status).toBe(409);
  });

  it('invalidates a session that never sends a heartbeat and reports rejected', async () => {
    const { testId } = await seedReadyTest();
    const { participationId, sessionId } = await joinAndStart(testId);

    // Force the heartbeat key to expire immediately instead of waiting out
    // the real TTL, then let the reconciliation sweep do its job.
    await workerDeps.redis.del(`session:heartbeat:${sessionId}`);
    await processReconcileStuckJobs(workerDeps);

    const result = await waitForResult(participationId, (s) => s !== 'in_review');
    expect(result.status).toBe('rejected');
    expect(result.invalidReason).toContain('timeout');
  });

  // `finish` commits the session as `processing` and only then enqueues
  // `session.validate`: a lost enqueue used to leave it there for good.
  it('validates a finished session whose validation job never got enqueued', async () => {
    const { testId } = await seedReadyTest();
    const { participationId, sessionId } = await joinAndStart(testId);
    await sql`
      UPDATE sessions
      SET status = 'processing', duration_ms = 60000, ended_at = now() - interval '20 minutes'
      WHERE id = ${sessionId}`;
    await sql`UPDATE participations SET status = 'in_review' WHERE id = ${participationId}`;

    await processReconcileStuckJobs(workerDeps);

    const result = await waitForResult(participationId, (s) => s !== 'in_review');
    expect(result.status).toBe('completed');
  });
});
