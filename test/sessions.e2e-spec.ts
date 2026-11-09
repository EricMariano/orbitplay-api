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
import { processReconcileStuckJobs } from '../src/workers/reconcile.processor';
import { processSessionValidate } from '../src/workers/session.processor';
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

  /** A screen recording row of the session, already through (or still in) the media pipeline. */
  async function insertScreenRecording(
    sessionId: string,
    status: 'ready' | 'processing' | 'failed',
  ): Promise<string> {
    const id = uuidv7();
    await sql`
      INSERT INTO session_recordings (id, session_id, kind, storage_key, status)
      SELECT ${id}, s.id, 'screen',
             'orgs/' || s.organization_id::text || '/sessions/' || s.id::text
               || '/recordings/screen/' || ${id},
             ${status}
      FROM sessions s WHERE s.id = ${sessionId}`;
    return id;
  }

  /**
   * What a valid verdict needs (product rule): at least a minute played — the
   * start is moved back since `finish` caps the duration at the real elapsed
   * time — and, for a model that requires it, a ready screen recording.
   */
  async function makeValidatable(sessionId: string): Promise<void> {
    await sql`UPDATE sessions SET started_at = now() - interval '5 minutes' WHERE id = ${sessionId}`;
    await insertScreenRecording(sessionId, 'ready');
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

    await makeValidatable(sessionId);
    const finish = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/finish`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ tMs: 120_000, confirmed: true });
    expect(finish.status).toBe(200);
    expect(finish.body.status).toBe('in_review');

    const secondFinish = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/finish`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ tMs: 130_000, confirmed: true });
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

  // Deleting a game used to 404 the player's Home and the gameplay/summary of
  // a session still running on it — no way to finish it or answer the form.
  it('keeps the session and the Home working after the studio deletes the game', async () => {
    const { testId } = await seedReadyTest();
    const { sessionId } = await joinAndStart(testId);

    await sql`UPDATE games SET deleted_at = now() WHERE id = ${GAME_IDS.two}`;
    try {
      for (const path of [`/sessions/${sessionId}/gameplay`, `/sessions/${sessionId}/summary`]) {
        const res = await request(app.getHttpServer())
          .get(path)
          .set('Authorization', `Bearer ${playerToken}`);
        expect(res.status).toBe(200);
      }
      const home = await request(app.getHttpServer())
        .get('/player/home')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(home.status).toBe(200);
    } finally {
      await sql`UPDATE games SET deleted_at = NULL WHERE id = ${GAME_IDS.two}`;
    }
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
    await makeValidatable(sessionId);
    const finish = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/finish`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ tMs: 120_000, confirmed: true });
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

  it('refuses to join again a test the player already completed', async () => {
    const { testId } = await seedReadyTest();
    const first = await joinAndStart(testId);
    await finishAndWaitCompleted(first.participationId, first.sessionId);

    const again = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(again.status).toBe(409);
    const [test] = await sql`SELECT slots_taken FROM tests WHERE id = ${testId}`;
    expect(test.slots_taken).toBe(1);
  });

  it('credits session XP once per test even for a second participation', async () => {
    const { testId } = await seedReadyTest();
    const first = await joinAndStart(testId);
    await finishAndWaitCompleted(first.participationId, first.sessionId);

    // Joining a completed test is refused now; a second participation can
    // still exist from before that rule, and the worker must not pay twice.
    const participationId = uuidv7();
    const sessionId = uuidv7();
    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      SELECT ${participationId}, test_id, user_id, 'in_review'
      FROM participations WHERE id = ${first.participationId}`;
    await sql`
      INSERT INTO sessions (id, participation_id, test_id, organization_id, status,
                            started_at, ended_at, duration_ms)
      SELECT ${sessionId}, ${participationId}, id, organization_id, 'processing',
             now() - interval '2 minutes', now(), 60000
      FROM tests WHERE id = ${testId}`;
    await insertScreenRecording(sessionId, 'ready');
    await expect(processSessionValidate(workerDeps, sessionId)).resolves.toBe('validated');

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

  // M8-03: `rejected` doesn't hold a slot — the one taken on join comes back,
  // exactly once, and the player can take it again.
  it('gives the slot back when the session is rejected, once, and lets the player rejoin', async () => {
    const { testId } = await seedReadyTest();
    const { participationId, sessionId } = await joinAndStart(testId);
    const slotsTaken = async () =>
      (await sql`SELECT slots_taken FROM tests WHERE id = ${testId}`)[0].slots_taken as number;
    expect(await slotsTaken()).toBe(1);

    await workerDeps.redis.del(`session:heartbeat:${sessionId}`);
    await processReconcileStuckJobs(workerDeps);
    const result = await waitForResult(participationId, (s) => s !== 'in_review');
    expect(result.status).toBe('rejected');
    expect(await slotsTaken()).toBe(0);

    // Redelivery of the same validation changes nothing.
    await processSessionValidate(workerDeps, sessionId);
    expect(await slotsTaken()).toBe(0);

    const rejoin = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(rejoin.status).toBe(201);
    expect(await slotsTaken()).toBe(1);
  });

  // "Marcar inválida" by the studio reverts the verdict; the player's result
  // follows it both ways.
  it('reflects the studio marking the session invalid, and restoring it, in the result', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: SEED_EMAILS.studio, password: SEED_PASSWORD });
    const studioToken = login.body.accessToken as string;
    const { testId } = await seedReadyTest();
    const { participationId, sessionId } = await joinAndStart(testId);
    await finishAndWaitCompleted(participationId, sessionId);
    const rate = (markedInvalid: boolean) =>
      request(app.getHttpServer())
        .post(`/sessions/${sessionId}/rate`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ rating: 1, markedInvalid });
    const result = async () =>
      (
        await request(app.getHttpServer())
          .get(`/participations/${participationId}/result`)
          .set('Authorization', `Bearer ${playerToken}`)
      ).body as { status: string; xpEarned: number | null; invalidReason: string | null };

    expect((await rate(true)).status).toBe(200);
    expect(await result()).toMatchObject({
      status: 'rejected',
      xpEarned: null,
      invalidReason: 'Marcada como inválida pelo estúdio',
    });
    expect(await sessionXpEventsForTest(testId)).toBe(0);

    expect((await rate(false)).status).toBe(200);
    const restored = await result();
    expect(restored.status).toBe('completed');
    expect(restored.xpEarned).toBeGreaterThan(0);
  });

  it('keeps the slot of a completed participation', async () => {
    const { testId } = await seedReadyTest();
    const { participationId, sessionId } = await joinAndStart(testId);
    await finishAndWaitCompleted(participationId, sessionId);

    const [test] = await sql`SELECT slots_taken FROM tests WHERE id = ${testId}`;
    expect(test.slots_taken).toBe(1);
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
    await insertScreenRecording(sessionId, 'ready');

    await processReconcileStuckJobs(workerDeps);

    const result = await waitForResult(participationId, (s) => s !== 'in_review');
    expect(result.status).toBe('completed');
  });

  // Validity rule (product decision): ≥ 1 minute and, when the model requires
  // it, a ready screen recording — judged after media processing.
  it('rejects a session shorter than a minute and gives its slot back', async () => {
    const { testId } = await seedReadyTest();
    const { participationId, sessionId } = await joinAndStart(testId);
    await sql`UPDATE sessions SET started_at = now() - interval '40 seconds' WHERE id = ${sessionId}`;
    await insertScreenRecording(sessionId, 'ready');

    const finish = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/finish`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ tMs: 30_000, confirmed: true });
    expect(finish.status).toBe(200);

    const result = await waitForResult(participationId, (s) => s !== 'in_review');
    expect(result.status).toBe('rejected');
    expect(result.invalidReason).toContain('mínimo');
    const [test] = await sql`SELECT slots_taken FROM tests WHERE id = ${testId}`;
    expect(test.slots_taken).toBe(0);
  });

  it('waits for the recording to finish processing before validating', async () => {
    const { testId } = await seedReadyTest();
    const { participationId, sessionId } = await joinAndStart(testId);
    await sql`UPDATE sessions SET started_at = now() - interval '5 minutes' WHERE id = ${sessionId}`;
    const recordingId = await insertScreenRecording(sessionId, 'processing');

    const finish = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/finish`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ tMs: 120_000, confirmed: true });
    expect(finish.status).toBe(200);

    await expect(processSessionValidate(workerDeps, sessionId)).resolves.toBe('deferred');
    expect(
      await sql`SELECT 1 FROM session_validations WHERE session_id = ${sessionId}`,
    ).toHaveLength(0);
    const pending = await request(app.getHttpServer())
      .get(`/participations/${participationId}/result`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(pending.body.status).toBe('in_review');

    // The transcode settles it and asks for the verdict again.
    await sql`UPDATE session_recordings SET status = 'ready' WHERE id = ${recordingId}`;
    await expect(processSessionValidate(workerDeps, sessionId)).resolves.toBe('validated');
    const result = await waitForResult(participationId, (s) => s !== 'in_review');
    expect(result.status).toBe('completed');
  });

  it('rejects a session whose required recording never arrived within the upload window', async () => {
    const { testId } = await seedReadyTest();
    const { participationId, sessionId } = await joinAndStart(testId);
    await sql`
      UPDATE sessions
      SET status = 'processing', duration_ms = 600000,
          started_at = now() - interval '4 hours', ended_at = now() - interval '3 hours'
      WHERE id = ${sessionId}`;
    await sql`UPDATE participations SET status = 'in_review' WHERE id = ${participationId}`;

    await processReconcileStuckJobs(workerDeps);

    const result = await waitForResult(participationId, (s) => s !== 'in_review');
    expect(result.status).toBe('rejected');
    expect(result.invalidReason).toBe('Gravação obrigatória ausente');
  });
});
