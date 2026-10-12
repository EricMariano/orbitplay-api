import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, ORG_ID, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

function ids(body: { data: { id: string }[] }): string[] {
  return body.data.map((g) => g.id);
}

describe('Player feed — M8 (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let playerToken: string;
  let studioToken: string;
  const lateGameId = uuidv7();

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });
    playerToken = await bearer(app, SEED_EMAILS.player);
    studioToken = await bearer(app, SEED_EMAILS.studio);
  });

  afterAll(async () => {
    await sql`DELETE FROM games WHERE id = ${lateGameId}`;
    await sql.end({ timeout: 5 });
    await app.close();
  });

  const feed = (query: Record<string, string | number> = {}) =>
    request(app.getHttpServer())
      .get('/player/feed')
      .query(query)
      .set('Authorization', `Bearer ${playerToken}`);

  it('requires auth', async () => {
    const res = await request(app.getHttpServer()).get('/player/feed');
    expect(res.status).toBe(401);
  });

  it('is player-only — a studio role gets 403', async () => {
    const res = await request(app.getHttpServer())
      .get('/player/feed')
      .set('Authorization', `Bearer ${studioToken}`);
    expect(res.status).toBe(403);
  });

  it('lists active games of any org and freezes the order under the returned seed', async () => {
    const first = await feed();
    expect(first.status).toBe(200);
    expect(typeof first.body.seed).toBe('string');
    expect(ids(first.body)).toContain(GAME_IDS.one);
    expect(ids(first.body)).not.toContain(GAME_IDS.two); // draft

    await sql`
      INSERT INTO games (id, organization_id, title, slug, status)
      VALUES (${lateGameId}, ${ORG_ID}, 'Late Arrival', ${`late-${lateGameId}`}, 'active')`;

    // Same seed: the snapshot is frozen, the new game doesn't show up.
    const frozen = await feed({ seed: first.body.seed as string });
    expect(frozen.status).toBe(200);
    expect(frozen.body.seed).toBe(first.body.seed);
    expect(ids(frozen.body)).toEqual(ids(first.body));

    // No seed: a fresh snapshot, newest first.
    const fresh = await feed();
    expect(fresh.body.seed).not.toBe(first.body.seed);
    expect(ids(fresh.body)[0]).toBe(lateGameId);
  });

  it('pages the snapshot with an offset cursor', async () => {
    const page1 = await feed({ limit: 1 });
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(1);
    expect(page1.body.nextCursor).not.toBeNull();

    const page2 = await feed({
      limit: 1,
      seed: page1.body.seed as string,
      cursor: page1.body.nextCursor as string,
    });
    expect(page2.status).toBe(200);
    expect(page2.body.seed).toBe(page1.body.seed);
    expect(ids(page2.body)[0]).not.toBe(ids(page1.body)[0]);
  });

  it('skips a game deleted after the snapshot instead of failing the page', async () => {
    const before = await feed();
    expect(ids(before.body)).toContain(lateGameId);

    await sql`UPDATE games SET deleted_at = now() WHERE id = ${lateGameId}`;

    const after = await feed({ seed: before.body.seed as string });
    expect(after.status).toBe(200);
    expect(after.body.seed).toBe(before.body.seed);
    expect(ids(after.body)).not.toContain(lateGameId);
  });

  it("ignores another user's seed and mints a new one", async () => {
    const [owner] = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE email = ${SEED_EMAILS.owner}`;
    const foreignSeed = uuidv7();
    await sql`
      INSERT INTO feed_ranking_snapshots (seed, user_id, item_ids, expires_at)
      VALUES (${foreignSeed}, ${owner.id}, ${sql.array([GAME_IDS.one])}::uuid[], now() + interval '1 hour')`;

    const res = await feed({ seed: foreignSeed });
    expect(res.status).toBe(200);
    expect(res.body.seed).not.toBe(foreignSeed);
  });
});
