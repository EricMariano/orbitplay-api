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

  it('filters GET /games by q and status and always returns GameMetrics', async () => {
    const byStatus = await request(app.getHttpServer())
      .get('/games')
      .query({ status: 'active' })
      .set('Authorization', `Bearer ${studioToken}`);
    expect(byStatus.status).toBe(200);
    expect(byStatus.body.data.length).toBeGreaterThanOrEqual(1);
    expect(byStatus.body.data.every((g: { status: string }) => g.status === 'active')).toBe(true);
    expect(byStatus.body.data[0].metrics).toEqual({
      testsTotal: expect.any(Number),
      testsActive: expect.any(Number),
      sessionsValid: expect.any(Number),
      playersTotal: expect.any(Number),
      averageRating: null,
    });

    const byQ = await request(app.getHttpServer())
      .get('/games')
      .query({ q: 'nebula' })
      .set('Authorization', `Bearer ${studioToken}`);
    expect(byQ.status).toBe(200);
    expect(byQ.body.data.every((g: { slug: string }) => g.slug.includes('nebula'))).toBe(true);
    expect(byQ.body.data.some((g: { id: string }) => g.id === GAME_IDS.one)).toBe(true);
  });

  it('aggregates testsTotal/testsActive from the tests table', async () => {
    const testId = '01930000-0000-7000-8000-0000000000aa';
    await sql`
      INSERT INTO tests (id, organization_id, game_id, name, model_key, status)
      VALUES (
        ${testId},
        ${ORG_ID},
        ${GAME_IDS.one},
        'E2E published test',
        'free_exploration',
        'published'
      )
      ON CONFLICT DO NOTHING`;

    const res = await request(app.getHttpServer())
      .get(`/games/${GAME_IDS.one}`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(res.status).toBe(200);
    expect(res.body.metrics.testsTotal).toBeGreaterThanOrEqual(1);
    expect(res.body.metrics.testsActive).toBeGreaterThanOrEqual(1);
    expect(res.body.metrics.sessionsValid).toBe(0);
    expect(res.body.metrics.playersTotal).toBe(0);
    expect(res.body.metrics.averageRating).toBeNull();
  });

  it('issues a signed upload URL, confirms only after PUT, and deletes the asset', async () => {
    const upload = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/assets/upload-url`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        kind: 'cover',
        contentType: 'image/png',
        sizeBytes: PNG_1X1.length,
        fileName: 'cover.png',
      });
    expect(upload.status).toBe(201);
    expect(upload.body.uploadUrl).toMatch(/^https?:\/\//);
    expect(upload.body.storageKey).toContain(`/games/${GAME_IDS.one}/assets/cover/`);
    expect(upload.body.maxSizeBytes).toBeGreaterThan(0);

    const missing = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/assets`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ kind: 'cover', storageKey: upload.body.storageKey });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('VALIDATION_ERROR');

    const put = await fetch(upload.body.uploadUrl as string, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG_1X1,
    });
    expect(put.ok).toBe(true);

    const confirm = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/assets`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ kind: 'cover', storageKey: upload.body.storageKey });
    expect(confirm.status).toBe(201);
    expect(confirm.body.kind).toBe('cover');
    expect(confirm.body.url).toMatch(/^https?:\/\//);
    const assetId = confirm.body.id as string;

    const replay = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/assets`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ kind: 'cover', storageKey: upload.body.storageKey });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(assetId);

    const game = await request(app.getHttpServer())
      .get(`/games/${GAME_IDS.one}`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(game.status).toBe(200);
    expect(game.body.coverUrl).toMatch(/^https?:\/\//);

    const removed = await request(app.getHttpServer())
      .delete(`/games/${GAME_IDS.one}/assets/${assetId}`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(removed.status).toBe(204);

    const after = await request(app.getHttpServer())
      .get(`/games/${GAME_IDS.one}`)
      .set('Authorization', `Bearer ${studioToken}`);
    expect(after.body.coverUrl).toBeNull();
  });

  it('forbids a player from uploading assets and hides the rival org game', async () => {
    const player = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/assets/upload-url`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send({
        kind: 'banner',
        contentType: 'image/png',
        sizeBytes: 16,
        fileName: 'banner.png',
      });
    expect(player.status).toBe(403);

    const crossOrg = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/assets/upload-url`)
      .set('Authorization', `Bearer ${rivalToken}`)
      .send({
        kind: 'banner',
        contentType: 'image/png',
        sizeBytes: 16,
        fileName: 'banner.png',
      });
    expect(crossOrg.status).toBe(404);
    expect(crossOrg.body.code).toBe('NOT_FOUND');
  });

  it('rejects an invalid asset upload body with 422', async () => {
    const res = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/assets/upload-url`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({
        kind: 'cover',
        contentType: 'application/pdf',
        sizeBytes: 12,
        fileName: 'not-an-image.pdf',
      });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.fieldErrors).toHaveProperty('contentType');
  });
});

/** 1×1 PNG — small enough to PUT to a presigned URL in e2e. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
