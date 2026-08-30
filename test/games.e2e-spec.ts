import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, ORG_ID, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

// Fixed ids for a second organization used to prove cross-org isolation.
const RIVAL = {
  userId: '01930000-0000-7000-8000-0000000000e1',
  orgId: '01930000-0000-7000-8000-0000000000f1',
  membershipId: '01930000-0000-7000-8000-0000000000e9',
  gameId: '01930000-0000-7000-8000-0000000000d1',
  email: 'rival-owner@rival.dev',
};

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

describe('Games (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let studioToken: string;
  let playerToken: string;
  let rivalToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    // Build a second organization sharing the seed password hash.
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
      INSERT INTO games (id, organization_id, title, slug, status)
      VALUES (${RIVAL.gameId}, ${RIVAL.orgId}, 'Rival Game', 'rival-game', 'active')
      ON CONFLICT DO NOTHING`;

    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
    rivalToken = await bearer(app, RIVAL.email);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  it('lists only the org’s own games (criterion #3)', async () => {
    const res = await request(app.getHttpServer())
      .get('/games')
      .set('Authorization', `Bearer ${studioToken}`);
    expect(res.status).toBe(200);
    const orgIds = new Set(res.body.data.map((g: { organizationId: string }) => g.organizationId));
    expect(orgIds).toEqual(new Set([ORG_ID]));
    expect(res.body.data.length).toBeGreaterThanOrEqual(2);
  });

  it('org B gets an empty list and 404 for org A’s game — not 403/500 (criterion #4)', async () => {
    const list = await request(app.getHttpServer())
      .get('/games')
      .set('Authorization', `Bearer ${rivalToken}`);
    expect(list.status).toBe(200);
    expect(
      list.body.data.every((g: { organizationId: string }) => g.organizationId === RIVAL.orgId),
    ).toBe(true);

    const crossOrg = await request(app.getHttpServer())
      .get(`/games/${GAME_IDS.one}`)
      .set('Authorization', `Bearer ${rivalToken}`);
    expect(crossOrg.status).toBe(404);
    expect(crossOrg.body.code).toBe('NOT_FOUND');
  });

  it('returns 404 (not 500) for a malformed id', async () => {
    const res = await request(app.getHttpServer())
      .get('/games/not-a-uuid')
      .set('Authorization', `Bearer ${studioToken}`);
    expect(res.status).toBe(404);
  });

  it('forbids a player from creating a game — 403 envelope (criterion #5)', async () => {
    const res = await request(app.getHttpServer())
      .post('/games')
      .set('Authorization', `Bearer ${playerToken}`)
      .send({ title: 'Player Game' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
    expect(res.body.requestId).toBeTypeOf('string');
  });

  it('rejects an invalid body with 422 + fieldErrors (criterion #6)', async () => {
    const res = await request(app.getHttpServer())
      .post('/games')
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ title: '' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.fieldErrors).toHaveProperty('title');
  });

  it('creates a game and writes an audit_log row (criterion #8)', async () => {
    const res = await request(app.getHttpServer())
      .post('/games')
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ title: 'Audited Game', slug: 'audited-game', genre: 'RPG' });
    expect(res.status).toBe(201);
    const id = res.body.id as string;

    const rows = await sql`
      SELECT action, actor_user_id, ip FROM audit_log
      WHERE entity = 'games' AND entity_id = ${id}`;
    expect(rows.length).toBe(1);
    expect(rows[0].action).toBe('game.created');
    expect(rows[0].actor_user_id).toBeTruthy();
  });

  it('makes duplicate Idempotency-Key requests a single effect (criterion #7)', async () => {
    // Unique per run: idempotency results live in Redis (24h TTL) and survive
    // the test-DB reset, so a fixed key would replay a stale cached response.
    const key = `e2e-idem-${randomUUID()}`;
    const slug = `idem-e2e-${key.slice(-12)}`;
    const payload = { title: 'Idem E2E', slug };
    const first = await request(app.getHttpServer())
      .post('/games')
      .set('Authorization', `Bearer ${studioToken}`)
      .set('Idempotency-Key', key)
      .send(payload);
    const second = await request(app.getHttpServer())
      .post('/games')
      .set('Authorization', `Bearer ${studioToken}`)
      .set('Idempotency-Key', key)
      .send(payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);

    const rows = await sql`SELECT count(*)::int AS c FROM games WHERE slug = ${slug}`;
    expect(rows[0].c).toBe(1);
  });
});
