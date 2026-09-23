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
});
