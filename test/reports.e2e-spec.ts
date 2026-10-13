import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, ORG_ID, SEED_EMAILS, SEED_PASSWORD, USER_IDS } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

// Dedicated testers (ids unique to this spec — see the shared-DB note in
// session-rate.e2e-spec.ts) so the profile aggregation is deterministic.
const EXPLORER_ID = '019b0000-0000-7000-8000-0000000000a1';
const NO_PROFILE_ID = '019b0000-0000-7000-8000-0000000000a2';

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

interface Block {
  key: string;
  status: string;
  payload: Record<string, unknown> | null;
}

/** M10 — report blocks, sessions list and AI insights (Tela 11). */
describe('Test report — M10 (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let studioToken: string;
  let playerToken: string;

  const testId = uuidv7();
  const scaleQuestionId = uuidv7();
  const textQuestionId = uuidv7();
  const choiceQuestionId = uuidv7();
  const optionA = uuidv7();
  const optionB = uuidv7();
  const explorerSessionId = uuidv7();
  const noProfileSessionId = uuidv7();

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    for (const [id, email, name] of [
      [EXPLORER_ID, 'report-explorer@orbitplay.test', 'Report Explorer'],
      [NO_PROFILE_ID, 'report-noprofile@orbitplay.test', 'Report No Profile'],
    ]) {
      await sql`
        INSERT INTO users (id, email, password_hash, display_name)
        SELECT ${id}, ${email}, password_hash, ${name}
        FROM users WHERE email = ${SEED_EMAILS.studio}
        ON CONFLICT DO NOTHING`;
    }
    await sql`
      INSERT INTO player_preferences (user_id, archetype, player_tier)
      VALUES (${EXPLORER_ID}, 'explorer', 'casual')
      ON CONFLICT (user_id) DO UPDATE SET archetype = 'explorer', player_tier = 'casual'`;

    await sql`
      INSERT INTO tests (id, organization_id, game_id, model_key, status, slots_total, slots_taken, starts_at)
      VALUES (${testId}, ${ORG_ID}, ${GAME_IDS.two}, 'free_exploration', 'published', 5, 2,
              '2026-01-01T00:00:00Z')`;
    await sql`
      INSERT INTO test_form_questions (id, test_id, type, label, position, scale_min, scale_max)
      VALUES (${scaleQuestionId}, ${testId}, 'scale', 'Quão divertido foi?', 0, 1, 5),
             (${textQuestionId}, ${testId}, 'open_text', 'O que mais te incomodou?', 1, null, null),
             (${choiceQuestionId}, ${testId}, 'single_choice', 'Qual fase preferiu?', 2, null, null)`;
    await sql`
      INSERT INTO test_form_options (id, question_id, label, position)
      VALUES (${optionA}, ${choiceQuestionId}, 'Fase 1', 0),
             (${optionB}, ${choiceQuestionId}, 'Fase 2', 1)`;

    const sessions = [
      {
        userId: EXPLORER_ID,
        sessionId: explorerSessionId,
        startedAt: '2026-01-02T10:00:00Z',
        endedAt: '2026-01-02T10:30:00Z',
        submittedAt: '2026-01-02T10:35:00Z',
        rating: 5,
        text: 'Uma parte do menu não funciona',
      },
      {
        userId: NO_PROFILE_ID,
        sessionId: noProfileSessionId,
        startedAt: '2026-01-16T10:00:00Z',
        endedAt: '2026-01-16T10:20:00Z',
        submittedAt: null,
        rating: null,
        text: null,
      },
    ];
    for (const s of sessions) {
      const participationId = uuidv7();
      await sql`
        INSERT INTO participations (id, test_id, user_id, status)
        VALUES (${participationId}, ${testId}, ${s.userId}, 'completed')`;
      await sql`
        INSERT INTO sessions (id, participation_id, test_id, organization_id, status,
                              started_at, ended_at, duration_ms)
        VALUES (${s.sessionId}, ${participationId}, ${testId}, ${ORG_ID}, 'completed',
                ${s.startedAt}, ${s.endedAt}, 1200000)`;
      if (s.submittedAt) {
        const responseId = uuidv7();
        await sql`
          INSERT INTO form_responses (id, session_id, submitted_at)
          VALUES (${responseId}, ${s.sessionId}, ${s.submittedAt})`;
        await sql`
          INSERT INTO form_answers (id, response_id, question_id, value_number, value_text, option_ids)
          VALUES (${uuidv7()}, ${responseId}, ${scaleQuestionId}, ${s.rating}, null, null),
                 (${uuidv7()}, ${responseId}, ${textQuestionId}, null, ${s.text}, null),
                 (${uuidv7()}, ${responseId}, ${choiceQuestionId}, null, null, ${sql.array([optionB])}::uuid[])`;
      }
    }
    await sql`
      INSERT INTO session_tokens (id, session_id, token_hash, expires_at)
      VALUES (${uuidv7()}, ${explorerSessionId}, 'hash', now() + interval '1 hour')`;

    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  async function getBlocks(): Promise<Map<string, Block>> {
    const res = await request(app.getHttpServer())
      .get(`/tests/${testId}/report`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(res.status).toBe(200);
    return new Map((res.body.blocks as Block[]).map((b) => [b.key, b]));
  }

  it('returns every block, typed, with the new metrics', async () => {
    const blocks = await getBlocks();

    expect([...blocks.keys()]).toEqual([
      'overview',
      'evolution',
      'rating_distribution',
      'tester_profile',
      'evaluations',
      'telemetry',
    ]);
    expect(blocks.get('overview')).toMatchObject({
      status: 'ready',
      payload: { testersCount: 2, aiScore: null, funFactor: null, bugsCount: null },
    });
    expect(blocks.get('evolution')?.payload?.weeks).toEqual([
      { week: 1, startDate: '2026-01-01', sessions: 1 },
      { week: 2, startDate: '2026-01-08', sessions: 0 },
      { week: 3, startDate: '2026-01-15', sessions: 1 },
    ]);

    const profile = blocks.get('tester_profile')?.payload;
    expect(profile?.archetypes).toEqual([
      { key: 'achiever', count: 0 },
      { key: 'explorer', count: 1 },
      { key: 'socializer', count: 0 },
      { key: 'killer', count: 0 },
      { key: 'unknown', count: 1 },
    ]);
    expect(profile?.playerTiers).toContainEqual({ key: 'casual', count: 1 });
    expect(profile?.playerTiers).toContainEqual({ key: 'unknown', count: 1 });
  });

  it('summarizes the evaluation form per question', async () => {
    const evaluations = (await getBlocks()).get('evaluations');

    expect(evaluations?.status).toBe('ready');
    expect(evaluations?.payload).toMatchObject({
      questionsCount: 3,
      responsesCount: 1,
      averageResponseTimeMs: 5 * 60 * 1000,
      dropoutRate: 0.5,
    });
    const [scale, text, choice] = evaluations?.payload?.questions as Record<string, unknown>[];
    expect(scale).toMatchObject({
      questionId: scaleQuestionId,
      responsesCount: 1,
      average: 5,
      distribution: [
        { value: 1, count: 0 },
        { value: 2, count: 0 },
        { value: 3, count: 0 },
        { value: 4, count: 0 },
        { value: 5, count: 1 },
      ],
    });
    expect(text).toMatchObject({
      type: 'open_text',
      average: null,
      samples: ['Uma parte do menu não funciona'],
    });
    expect(choice).toMatchObject({
      options: [
        { label: 'Fase 1', count: 0 },
        { label: 'Fase 2', count: 1 },
      ],
    });
  });

  it('reports telemetry as unavailable while the build has no plug-in', async () => {
    expect((await getBlocks()).get('telemetry')).toEqual({
      key: 'telemetry',
      status: 'unavailable',
      payload: null,
      computedAt: null,
    });
  });

  it('lists sessions with profile, plug-in flag and the total', async () => {
    const res = await request(app.getHttpServer())
      .get(`/tests/${testId}/report/sessions?limit=1`)
      .set('Authorization', `Bearer ${studioToken}`);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.nextCursor).not.toBeNull();
    expect(res.body.data).toHaveLength(1);

    const next = await request(app.getHttpServer())
      .get(`/tests/${testId}/report/sessions?limit=1&cursor=${res.body.nextCursor}`)
      .set('Authorization', `Bearer ${studioToken}`);
    const all = [...res.body.data, ...next.body.data] as Record<string, unknown>[];

    expect(all.find((s) => s.sessionId === explorerSessionId)).toMatchObject({
      archetype: 'explorer',
      playerTier: 'casual',
      aiQualityScore: null,
      telemetryConnected: true,
    });
    expect(all.find((s) => s.sessionId === noProfileSessionId)).toMatchObject({
      archetype: null,
      playerTier: null,
      telemetryConnected: false,
    });
  });

  // Runs after the assertions above: it adds a third tester to the test.
  it('drops the cached blocks when a new form response arrives', async () => {
    const before = await getBlocks();
    expect(before.get('evaluations')?.payload).toMatchObject({ responsesCount: 1 });

    const participationId = uuidv7();
    const sessionId = uuidv7();
    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${participationId}, ${testId}, ${USER_IDS.player}, 'form_pending')`;
    await sql`
      INSERT INTO sessions (id, participation_id, test_id, organization_id, status,
                            started_at, ended_at, duration_ms)
      VALUES (${sessionId}, ${participationId}, ${testId}, ${ORG_ID}, 'completed',
              '2026-01-20T10:00:00Z', '2026-01-20T10:15:00Z', 900000)`;

    const submit = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/form-response`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ answers: [{ questionId: scaleQuestionId, value: 3 }] });
    expect(submit.status).toBe(201);

    const after = await getBlocks();
    expect(after.get('evaluations')?.payload).toMatchObject({ responsesCount: 2 });
    expect(after.get('overview')?.payload).toMatchObject({ testersCount: 3 });
  });

  describe('GET /tests/:id/insights', () => {
    it('answers unavailable with an empty list until the AI generation exists', async () => {
      const res = await request(app.getHttpServer())
        .get(`/tests/${testId}/insights?q=menu&category=ux_ui`)
        .set('Authorization', `Bearer ${studioToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: 'unavailable', model: null, data: [] });
    });

    it('rejects an unknown category', async () => {
      const res = await request(app.getHttpServer())
        .get(`/tests/${testId}/insights?category=nope`)
        .set('Authorization', `Bearer ${studioToken}`);
      expect(res.status).toBe(422);
    });

    it('answers 404 for an unknown test and 403 for a player', async () => {
      const missing = await request(app.getHttpServer())
        .get(`/tests/${uuidv7()}/insights`)
        .set('Authorization', `Bearer ${studioToken}`);
      expect(missing.status).toBe(404);

      const player = await request(app.getHttpServer())
        .get(`/tests/${testId}/insights`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(player.status).toBe(403);
    });
  });
});
