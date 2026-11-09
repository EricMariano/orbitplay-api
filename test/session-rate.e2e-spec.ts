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
  userId: '019a0000-0000-7000-8000-0000000000e1',
  orgId: '019a0000-0000-7000-8000-0000000000f1',
  membershipId: '019a0000-0000-7000-8000-0000000000e9',
  email: 'rate-rival-owner@rival.dev',
};
const TESTER_ID = '019a0000-0000-7000-8000-0000000000e2';

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

  /**
   * A completed session of the demo org's test. `validation` is the worker's
   * verdict: valid by default, `false` for a rejected session, `null` for one
   * the worker hasn't validated yet.
   */
  async function seedSession(
    validation: boolean | null = true,
  ): Promise<{ testId: string; sessionId: string }> {
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
    if (validation !== null) {
      await sql`
        INSERT INTO session_validations (session_id, valid, reason, validator_version, validated_at)
        VALUES (${sessionId}, ${validation}, ${validation ? null : 'duration_too_short'}, 'v1', now())`;
    }
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

  it("never turns a session the worker rejected valid, nor overwrites the worker's reason", async () => {
    const { sessionId } = await seedSession(false);

    for (const markedInvalid of [true, false]) {
      const res = await request(app.getHttpServer())
        .post(`/sessions/${sessionId}/rate`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ rating: 1, markedInvalid });
      expect(res.status).toBe(200);
    }

    const [validation] = await sql`
      SELECT valid, reason, validator_version FROM session_validations WHERE session_id = ${sessionId}`;
    expect(validation).toMatchObject({
      valid: false,
      reason: 'duration_too_short',
      validator_version: 'v1',
    });
  });

  it('refuses to mark invalid a session the worker has not validated yet (409)', async () => {
    const { sessionId } = await seedSession(null);

    const res = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/rate`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ rating: 2, markedInvalid: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');

    // Nothing was written — the rating rolled back with the transaction, and
    // the worker still finds no validation row to skip on.
    expect(await sql`SELECT 1 FROM session_ratings WHERE session_id = ${sessionId}`).toHaveLength(
      0,
    );
    expect(
      await sql`SELECT 1 FROM session_validations WHERE session_id = ${sessionId}`,
    ).toHaveLength(0);

    // A plain rating (no invalidation) is still accepted.
    const plain = await request(app.getHttpServer())
      .post(`/sessions/${sessionId}/rate`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ rating: 2 });
    expect(plain.status).toBe(200);
  });

  /**
   * A validated session as the worker leaves it: participation `completed`
   * holding one of `slotsTotal` places, and the session's XP credited.
   */
  async function seedCreditedSession(slotsTotal = 5) {
    const testId = uuidv7();
    const participationId = uuidv7();
    const sessionId = uuidv7();
    await sql`
      INSERT INTO tests (id, organization_id, game_id, model_key, status, slots_total, slots_taken)
      VALUES (${testId}, ${ORG_ID}, ${GAME_IDS.two}, 'free_exploration', 'published', ${slotsTotal}, 1)`;
    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${participationId}, ${testId}, ${TESTER_ID}, 'completed')`;
    await sql`
      INSERT INTO sessions (id, participation_id, test_id, organization_id, status, duration_ms)
      VALUES (${sessionId}, ${participationId}, ${testId}, ${ORG_ID}, 'completed', 600000)`;
    await sql`
      INSERT INTO session_validations (session_id, valid, reason, validator_version, validated_at)
      VALUES (${sessionId}, true, null, 'v1', now())`;
    await sql`
      INSERT INTO xp_events (id, user_id, source_type, source_id, xp)
      VALUES (${uuidv7()}, ${TESTER_ID}, 'session', ${sessionId}, 50)`;
    return { testId, participationId, sessionId };
  }

  async function outcome(ids: { testId: string; participationId: string; sessionId: string }) {
    const [row] = await sql`
      SELECT p.status AS participation, s.status AS session, t.slots_taken AS slots,
             (SELECT count(*)::int FROM xp_events x
               WHERE x.source_type = 'session' AND x.source_id = s.id) AS xp
      FROM sessions s
      JOIN participations p ON p.id = s.participation_id
      JOIN tests t ON t.id = s.test_id
      WHERE s.id = ${ids.sessionId}`;
    return row as { participation: string; session: string; slots: number; xp: number };
  }

  function rate(sessionId: string, markedInvalid: boolean) {
    return request(app.getHttpServer())
      .post(`/sessions/${sessionId}/rate`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ rating: 2, markedInvalid });
  }

  it('marking invalid reverts the verdict (rejected, slot back, XP removed), once', async () => {
    const ids = await seedCreditedSession();

    expect((await rate(ids.sessionId, true)).status).toBe(200);
    expect(await outcome(ids)).toEqual({
      participation: 'rejected',
      session: 'invalidated',
      slots: 0,
      xp: 0,
    });

    // Sending it again is not a second transition: the slot stays at zero.
    expect((await rate(ids.sessionId, true)).status).toBe(200);
    expect((await outcome(ids)).slots).toBe(0);
  });

  it('restoring brings back completed, the XP and the slot', async () => {
    const ids = await seedCreditedSession();
    await rate(ids.sessionId, true);

    expect((await rate(ids.sessionId, false)).status).toBe(200);
    expect(await outcome(ids)).toEqual({
      participation: 'completed',
      session: 'completed',
      slots: 1,
      xp: 1,
    });
  });

  it('409s restoring when the test is full, changing nothing', async () => {
    const ids = await seedCreditedSession(1);
    await rate(ids.sessionId, true);
    // Someone else took the freed place.
    await sql`UPDATE tests SET slots_taken = 1 WHERE id = ${ids.testId}`;

    const res = await rate(ids.sessionId, false);
    expect(res.status).toBe(409);
    expect(await outcome(ids)).toEqual({
      participation: 'rejected',
      session: 'invalidated',
      slots: 1,
      xp: 0,
    });
    const [validation] = await sql`
      SELECT valid FROM session_validations WHERE session_id = ${ids.sessionId}`;
    expect(validation.valid).toBe(false);
  });

  it('409s restoring when the player already joined the test again', async () => {
    const ids = await seedCreditedSession();
    await rate(ids.sessionId, true);
    await sql`
      INSERT INTO participations (id, test_id, user_id, status)
      VALUES (${uuidv7()}, ${ids.testId}, ${TESTER_ID}, 'reserved')`;

    expect((await rate(ids.sessionId, false)).status).toBe(409);
    expect((await outcome(ids)).participation).toBe('rejected');
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
