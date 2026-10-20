import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

// GAME_IDS.two on purpose — see the note in builds.e2e-spec.ts: participations
// created here would otherwise pollute games.e2e-spec's playersTotal===0
// assertion for GAME_IDS.one.
describe('Participations — M7-02 (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let studioToken: string;
  let playerToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });
    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  /** Seeded directly via SQL (pre-M7 pattern, e.g. tests-wizard.e2e-spec.ts) — no wizard round trip needed. */
  async function seedPublishedTest(overrides: {
    id: string;
    slotsTotal: number;
    slotsTaken?: number;
    endsAt?: string | null;
    ageMin?: number;
    ageMax?: number;
  }): Promise<void> {
    await sql`
      INSERT INTO tests (id, organization_id, game_id, model_key, status, slots_total, slots_taken, ends_at)
      VALUES (
        ${overrides.id},
        (SELECT organization_id FROM games WHERE id = ${GAME_IDS.two}),
        ${GAME_IDS.two},
        'free_exploration',
        'published',
        ${overrides.slotsTotal},
        ${overrides.slotsTaken ?? 0},
        ${overrides.endsAt ?? null}
      )
      ON CONFLICT DO NOTHING`;

    if (overrides.ageMin != null || overrides.ageMax != null) {
      await sql`
        INSERT INTO test_audience_criteria (test_id, age_min, age_max)
        VALUES (${overrides.id}, ${overrides.ageMin ?? null}, ${overrides.ageMax ?? null})
        ON CONFLICT DO NOTHING`;
    }
  }

  it('403s a studio-role token (player-only route)', async () => {
    const testId = uuidv7();
    await seedPublishedTest({ id: testId, slotsTotal: 5 });

    const res = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send();
    expect(res.status).toBe(403);
  });

  it('404s a non-existent test', async () => {
    const res = await request(app.getHttpServer())
      .post(`/player/tests/${uuidv7()}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(res.status).toBe(404);
  });

  it('201s and reserves a slot, then GET /participations/:id returns it', async () => {
    const testId = uuidv7();
    await seedPublishedTest({ id: testId, slotsTotal: 5 });

    const join = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(join.status).toBe(201);
    expect(join.body.testId).toBe(testId);
    expect(join.body.gameId).toBe(GAME_IDS.two);
    expect(join.body.status).toBe('reserved');
    expect(join.body.consentsGranted).toBe(false);

    const [row] = await sql`SELECT slots_taken FROM tests WHERE id = ${testId}`;
    expect(row.slots_taken).toBe(1);

    const get = await request(app.getHttpServer())
      .get(`/participations/${join.body.id}`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(get.status).toBe(200);
    expect(get.body.id).toBe(join.body.id);
  });

  it('409s a second reservation attempt for the same player/test (RN-02)', async () => {
    const testId = uuidv7();
    await seedPublishedTest({ id: testId, slotsTotal: 5 });

    const first = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(first.status).toBe(201);

    const second = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(second.status).toBe(409);

    // The failed second attempt must not have kept the slot it briefly reserved.
    const [row] = await sql`SELECT slots_taken FROM tests WHERE id = ${testId}`;
    expect(row.slots_taken).toBe(1);
  });

  it('409s when slots are already full', async () => {
    const testId = uuidv7();
    await seedPublishedTest({ id: testId, slotsTotal: 1, slotsTaken: 1 });

    const res = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(res.status).toBe(409);
  });

  it('409s when the test has already ended', async () => {
    const testId = uuidv7();
    await seedPublishedTest({
      id: testId,
      slotsTotal: 5,
      endsAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
    });

    const res = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(res.status).toBe(409);
  });

  it('403s a player outside the audience age bracket', async () => {
    const testId = uuidv7();
    // seed player birthdate is 1995-06-15 (well over 90 by this bracket's math)
    // — use a bracket the seeded player cannot fall into.
    await seedPublishedTest({ id: testId, slotsTotal: 5, ageMin: 1, ageMax: 5 });

    const res = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(res.status).toBe(403);
  });

  it('replays the same response for a repeated Idempotency-Key without double-reserving', async () => {
    const testId = uuidv7();
    await seedPublishedTest({ id: testId, slotsTotal: 5 });
    const key = uuidv7();

    const first = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .set('Idempotency-Key', key)
      .send();
    expect(first.status).toBe(201);

    const replay = await request(app.getHttpServer())
      .post(`/player/tests/${testId}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .set('Idempotency-Key', key)
      .send();
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(first.body.id);

    const [row] = await sql`SELECT slots_taken FROM tests WHERE id = ${testId}`;
    expect(row.slots_taken).toBe(1);
  });

  it('404s GET /participations/:id for a participation that is not the caller’s', async () => {
    // No membership/participation row exists for this random id at all, which
    // is indistinguishable — by design — from a real participation owned by
    // someone else: `getByIdForUserOrThrow` 404s both cases the same way.
    const get = await request(app.getHttpServer())
      .get(`/participations/${uuidv7()}`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(get.status).toBe(404);
  });

  describe('GET /player/home', () => {
    it('returns own current participation, recent tests and validated rewards', async () => {
      const activeTestId = uuidv7();
      const completedTestId = uuidv7();
      await seedPublishedTest({ id: activeTestId, slotsTotal: 5 });
      await seedPublishedTest({ id: completedTestId, slotsTotal: 5 });
      await sql`
        UPDATE tests
        SET name = 'Exploração de casa', reward_amount_cents = 2500, reward_currency = 'BRL'
        WHERE id IN (${activeTestId}, ${completedTestId})`;

      const active = await request(app.getHttpServer())
        .post(`/player/tests/${activeTestId}/participations`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send();
      expect(active.status).toBe(201);

      const completed = await request(app.getHttpServer())
        .post(`/player/tests/${completedTestId}/participations`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send();
      expect(completed.status).toBe(201);
      await sql`UPDATE participations SET status = 'completed' WHERE id = ${completed.body.id}`;
      const sessionId = uuidv7();
      await sql`
        INSERT INTO sessions (id, participation_id, test_id, organization_id, status, ended_at, duration_ms)
        VALUES (
          ${sessionId},
          ${completed.body.id},
          ${completedTestId},
          (SELECT organization_id FROM games WHERE id = ${GAME_IDS.two}),
          'completed', now(), 60000
        )`;
      await sql`
        INSERT INTO session_validations (session_id, valid, validated_at)
        VALUES (${sessionId}, true, now())`;

      const home = await request(app.getHttpServer())
        .get('/player/home')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(home.status).toBe(200);
      expect(home.body.continuing).toMatchObject({
        participationId: active.body.id,
        testId: activeTestId,
        status: 'reserved',
        progress: 10,
      });
      expect(home.body.tests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ participationId: active.body.id, title: 'Exploração de casa' }),
          expect.objectContaining({ participationId: completed.body.id, status: 'completed' }),
        ]),
      );
      expect(home.body.earnings).toMatchObject({
        currency: 'BRL',
        last7DaysCents: 2500,
        totalValidatedCents: 2500,
      });
      expect(home.body.earnings.series).toHaveLength(7);
    });

    it('403s a studio-role token', async () => {
      const home = await request(app.getHttpServer())
        .get('/player/home')
        .set('Authorization', `Bearer ${studioToken}`);
      expect(home.status).toBe(403);
    });
  });

  describe('GET /player/participations', () => {
    async function join(testId: string): Promise<string> {
      const res = await request(app.getHttpServer())
        .post(`/player/tests/${testId}/participations`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send();
      expect(res.status).toBe(201);
      return res.body.id as string;
    }

    it('403s a studio-role token (player-only route)', async () => {
      const res = await request(app.getHttpServer())
        .get('/player/participations')
        .set('Authorization', `Bearer ${studioToken}`);
      expect(res.status).toBe(403);
    });

    it('lists the caller own participations newest first, in the Participation shape', async () => {
      const first = uuidv7();
      const second = uuidv7();
      await seedPublishedTest({ id: first, slotsTotal: 5 });
      await seedPublishedTest({ id: second, slotsTotal: 5 });
      const firstId = await join(first);
      const secondId = await join(second);

      const res = await request(app.getHttpServer())
        .get('/player/participations?limit=100')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.status).toBe(200);
      const ids = (res.body.data as { id: string }[]).map((p) => p.id);
      expect(ids).toContain(secondId);
      expect(ids.indexOf(secondId)).toBeLessThan(ids.indexOf(firstId));

      const item = res.body.data.find((p: { id: string }) => p.id === secondId);
      expect(item).toMatchObject({
        testId: second,
        gameId: GAME_IDS.two,
        status: 'reserved',
        currentSessionId: null,
        consentsGranted: false,
        build: null,
        startedAt: null,
        completedAt: null,
      });
    });

    it('paginates by cursor without repeating items', async () => {
      const a = uuidv7();
      const b = uuidv7();
      await seedPublishedTest({ id: a, slotsTotal: 5 });
      await seedPublishedTest({ id: b, slotsTotal: 5 });
      await join(a);
      await join(b);

      const page1 = await request(app.getHttpServer())
        .get('/player/participations?limit=1')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(page1.status).toBe(200);
      expect(page1.body.data).toHaveLength(1);
      expect(page1.body.nextCursor).toEqual(expect.any(String));

      const page2 = await request(app.getHttpServer())
        .get(`/player/participations?limit=1&cursor=${page1.body.nextCursor}`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(page2.status).toBe(200);
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.data[0].id).not.toBe(page1.body.data[0].id);
    });

    it('filters by status', async () => {
      const testId = uuidv7();
      await seedPublishedTest({ id: testId, slotsTotal: 5 });
      const id = await join(testId);
      await sql`UPDATE participations SET status = 'completed' WHERE id = ${id}`;

      const done = await request(app.getHttpServer())
        .get('/player/participations?status=completed&limit=100')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(done.status).toBe(200);
      expect((done.body.data as { id: string }[]).map((p) => p.id)).toContain(id);
      expect((done.body.data as { status: string }[]).every((p) => p.status === 'completed')).toBe(
        true,
      );

      const reserved = await request(app.getHttpServer())
        .get('/player/participations?status=reserved&limit=100')
        .set('Authorization', `Bearer ${playerToken}`);
      expect((reserved.body.data as { id: string }[]).map((p) => p.id)).not.toContain(id);
    });

    it('422s an unknown status', async () => {
      const res = await request(app.getHttpServer())
        .get('/player/participations?status=banana')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.status).toBe(422);
    });
  });
});
