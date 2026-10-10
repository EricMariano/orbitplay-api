import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, ORG_ID, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

// Second organization + dedicated tester, to prove cross-org isolation without
// touching the seeded player's ledger (other suites assert on it).
const RIVAL = {
  userId: '01940000-0000-7000-8000-0000000000e1',
  orgId: '01940000-0000-7000-8000-0000000000f1',
  membershipId: '01940000-0000-7000-8000-0000000000e9',
  email: 'rate-rival-owner@rival.dev',
};
const TESTER_ID = '01940000-0000-7000-8000-0000000000e2';

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

/** M10-03 — `POST /sessions/{id}/rate`. */
describe('Session rating — M10-03 (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let studioToken: string;
  let playerToken: string;
  let rivalToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${RIVAL.userId}, ${RIVAL.email}, password_hash, 'Rate Rival Owner'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${TESTER_ID}, 'rate-tester@orbitplay.test', password_hash, 'Rate Tester'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${RIVAL.orgId}, 'Rate Rival Studio', 'rate-rival-studio', ${RIVAL.userId})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id)
      VALUES (${RIVAL.membershipId}, ${RIVAL.orgId}, ${RIVAL.userId},
              (SELECT id FROM roles WHERE key = 'owner'))
      ON CONFLICT DO NOTHING`;

    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
    rivalToken = await bearer(app, RIVAL.email);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  /** A completed, valid session of the demo org's test. */
  async function seedSession(): Promise<{ testId: string; sessionId: string }> {
    const testId = uuidv7();
    const participationId = uuidv7();
    const sessionId = uuidv7();

    await sql`
      INSERT INTO tests (id, organization_id, game_id, model_key, status, slots_total, slots_taken)
      VALUES (${testId}, ${ORG_ID}, ${GAME_IDS.two}, 'free_exploration', 'published', 5, 0)`;
    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${participationId}, ${testId}, ${TESTER_ID}, 'completed')`;
    await sql`
      INSERT INTO sessions (id, participation_id, test_id, organization_id, status, duration_ms)
      VALUES (${sessionId}, ${participationId}, ${testId}, ${ORG_ID}, 'completed', 60000)`;
    await sql`
      INSERT INTO session_validations (session_id, valid, validator_version, validated_at)
      VALUES (${sessionId}, true, 'v1', now())`;
    return { testId, sessionId };
  }

  it('rates a session and upserts on a second call', async () => {
    const { sessionId } = await seedSession();

    const first = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/rate`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ rating: 4, comment: 'Bom feedback' });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      sessionId,
      rating: 4,
      comment: 'Bom feedback',
      markedInvalid: false,
    });

    const second = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/rate`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ rating: 2 });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ rating: 2, comment: null });

    const rows = await sql`SELECT rating FROM session_ratings WHERE session_id = ${sessionId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(2);
  });

  it('markedInvalid removes the session from the metrics and un-marking restores it', async () => {
    const { testId, sessionId } = await seedSession();
    const overview = async () => {
      const res = await request(app.getHttpServer())
        .get(`/tests/${testId}/report`)
        .set('Authorization', `Bearer ${studioToken}`);
      expect(res.status).toBe(200);
      return res.body.blocks.find((b: { key: string }) => b.key === 'overview').payload as {
        validSessions: number;
      };
    };

    expect((await overview()).validSessions).toBe(1);

    const invalid = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/rate`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ rating: 1, markedInvalid: true });
    expect(invalid.status).toBe(200);
    expect(invalid.body.markedInvalid).toBe(true);
    // The cached report block was dropped, so the metric is recomputed.
    expect((await overview()).validSessions).toBe(0);

    const restored = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/rate`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ rating: 3, markedInvalid: false });
    expect(restored.status).toBe(200);
    expect((await overview()).validSessions).toBe(1);
  });

  it('validates the body (rating 1–5) with the error envelope', async () => {
    const { sessionId } = await seedSession();

    for (const rating of [0, 6, 2.5]) {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionId}/rate`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ rating });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
  });

  it('answers 404 for another organization, unknown and malformed ids', async () => {
    const { sessionId } = await seedSession();

    const cross = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/rate`)
      .set('Authorization', `Bearer ${rivalToken}`)
      .send({ rating: 5 });
    expect(cross.status).toBe(404);
    expect(cross.body.code).toBe('NOT_FOUND');

    const unknown = await request(app.getHttpServer())
      .post(`/sessions/${uuidv7()}/rate`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ rating: 5 });
    expect(unknown.status).toBe(404);

    const malformed = await request(app.getHttpServer())
      .post('/sessions/not-a-uuid/rate')
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ rating: 5 });
    expect(malformed.status).toBe(404);

    const rows = await sql`SELECT 1 FROM session_ratings WHERE session_id = ${sessionId}`;
    expect(rows).toHaveLength(0);
  });

  it('rejects players and anonymous callers', async () => {
    const { sessionId } = await seedSession();

    const player = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/rate`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ rating: 5 });
    expect(player.status).toBe(403);

    const anon = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/rate`)
      .send({ rating: 5 });
    expect(anon.status).toBe(401);
  });
});
