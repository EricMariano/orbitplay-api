import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORG_ID, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

// Each run creates its own games (fresh UUIDv7 ids), so nothing here touches
// the seeded GAME_IDS other specs assert counts on.
describe('Player catalog — M8-03 (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let studioToken: string;
  let playerToken: string;

  const gameId = uuidv7();
  const draftGameId = uuidv7();
  const ids = {
    open: uuidv7(),
    full: uuidv7(),
    paused: uuidv7(),
    finished: uuidv7(),
    draft: uuidv7(),
  };
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  async function insertGame(id: string, status: 'active' | 'draft'): Promise<void> {
    await sql`
      INSERT INTO games (id, organization_id, title, slug, genre, status)
      VALUES (${id}, ${ORG_ID}, ${`Catálogo ${id}`}, ${`catalogo-${id}`}, 'Puzzle', ${status})`;
  }

  async function insertTest(test: {
    id: string;
    gameId: string;
    status: string;
    slotsTotal?: number;
    slotsTaken?: number;
    reward?: number | null;
    name?: string | null;
  }): Promise<void> {
    await sql`
      INSERT INTO tests (id, organization_id, game_id, name, model_key, status, slots_total, slots_taken, ends_at, reward_amount_cents)
      VALUES (
        ${test.id}, ${ORG_ID}, ${test.gameId}, ${test.name ?? null}, 'free_exploration',
        ${test.status}, ${test.slotsTotal ?? 5}, ${test.slotsTaken ?? 0}, ${future}, ${test.reward ?? null}
      )`;
  }

  const api = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });
    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);

    await insertGame(gameId, 'active');
    await insertGame(draftGameId, 'draft');
    await insertTest({ id: ids.open, gameId, status: 'published', reward: 1500, name: 'Fase 1' });
    await insertTest({ id: ids.full, gameId, status: 'published', slotsTotal: 1, slotsTaken: 1 });
    await insertTest({ id: ids.paused, gameId, status: 'paused', reward: 9000 });
    await insertTest({ id: ids.finished, gameId, status: 'finished' });
    await insertTest({ id: ids.draft, gameId, status: 'draft' });
    await sql`
      INSERT INTO test_audience_criteria (test_id, platforms)
      VALUES (${ids.open}, ${sql.array(['windows', 'not-a-platform'])})`;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  it('403s a studio-role token on every player route', async () => {
    for (const path of [
      `/player/games/${gameId}`,
      `/player/games/${gameId}/tests`,
      `/player/tests/${ids.open}`,
      '/player/participations',
    ]) {
      const res = await api().get(path).set('Authorization', `Bearer ${studioToken}`);
      expect(res.status, path).toBe(403);
    }
  });

  it('GET /player/games/:id counts only open tests and their max reward', async () => {
    const res = await api()
      .get(`/player/games/${gameId}`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(res.status).toBe(200);
    expect(res.body.game.id).toBe(gameId);
    // `full` has no slot and `paused` isn't published — only `open` counts.
    expect(res.body.openTests).toBe(1);
    expect(res.body.maxRewardCents).toBe(1500);
    expect(res.body.specs).toEqual(expect.any(Object));
  });

  it('404s a draft game, a malformed id and an unknown id', async () => {
    for (const id of [draftGameId, 'not-a-uuid', uuidv7()]) {
      const game = await api()
        .get(`/player/games/${id}`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(game.status, id).toBe(404);
      const tests = await api()
        .get(`/player/games/${id}/tests`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(tests.status, id).toBe(404);
    }
  });

  it('GET /player/games/:id/tests lists published and paused tests with a backend CTA', async () => {
    const res = await api()
      .get(`/player/games/${gameId}/tests`)
      .set('Authorization', `Bearer ${playerToken}`);

    expect(res.status).toBe(200);
    const byId = new Map(
      (res.body.data as { testId: string }[]).map((test) => [test.testId, test]),
    );
    expect([...byId.keys()].sort()).toEqual([ids.open, ids.full, ids.paused].sort());

    expect(byId.get(ids.open)).toMatchObject({
      title: 'Fase 1',
      genre: 'Puzzle',
      rewardCents: 1500,
      spotsLeft: 5,
      platforms: ['windows'],
      cta: 'start',
      disabled: false,
      disabledReason: null,
      promoted: false,
      modelKey: 'free_exploration',
      participation: null,
    });
    expect(byId.get(ids.full)).toMatchObject({
      cta: 'unavailable',
      disabled: true,
      disabledReason: 'Vagas esgotadas',
      spotsLeft: 0,
    });
    expect(byId.get(ids.paused)).toMatchObject({
      cta: 'unavailable',
      disabledReason: 'Teste pausado pelo estúdio',
    });
  });

  it('paginates the test list with a cursor', async () => {
    const first = await api()
      .get(`/player/games/${gameId}/tests?limit=2`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await api()
      .get(`/player/games/${gameId}/tests?limit=2&cursor=${first.body.nextCursor}`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
  });

  it('GET /player/tests/:id hides drafts but still shows a finished test, disabled', async () => {
    const draft = await api()
      .get(`/player/tests/${ids.draft}`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(draft.status).toBe(404);

    const finished = await api()
      .get(`/player/tests/${ids.finished}`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(finished.status).toBe(200);
    expect(finished.body).toMatchObject({ cta: 'unavailable', disabledReason: 'Teste encerrado' });
    // No name → falls back to the game title.
    expect(finished.body.title).toBe(`Catálogo ${gameId}`);
  });

  it('after joining, the test turns into "continue" and shows up in /player/participations', async () => {
    const join = await api()
      .post(`/player/tests/${ids.open}/participations`)
      .set('Authorization', `Bearer ${playerToken}`)
      .send();
    expect(join.status).toBe(201);

    const test = await api()
      .get(`/player/tests/${ids.open}`)
      .set('Authorization', `Bearer ${playerToken}`);
    expect(test.status).toBe(200);
    expect(test.body.cta).toBe('continue');
    expect(test.body.spotsLeft).toBe(4);
    expect(test.body.participation).toMatchObject({ id: join.body.id, status: 'reserved' });

    const mine = await api()
      .get('/player/participations?status=reserved')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.map((p: { id: string }) => p.id)).toContain(join.body.id);

    const completed = await api()
      .get('/player/participations?status=completed')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(completed.body.data.map((p: { id: string }) => p.id)).not.toContain(join.body.id);
  });

  it('another player (from another org) sees neither the slot nor the participation', async () => {
    const signup = await api()
      .post('/auth/signup/player')
      .send({
        displayName: 'Outro Jogador',
        email: `outro-${uuidv7()}@orbitplay.dev`,
        password: 'Senha@Forte123',
        birthdate: '1995-05-05',
        acceptedTerms: true,
      });
    expect(signup.status).toBe(201);
    const otherToken = signup.body.accessToken as string;

    const mine = await api()
      .get('/player/participations')
      .set('Authorization', `Bearer ${otherToken}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data).toEqual([]);

    // Cross-org read of a game's test: allowed, with this player's own CTA.
    const test = await api()
      .get(`/player/tests/${ids.open}`)
      .set('Authorization', `Bearer ${otherToken}`);
    expect(test.status).toBe(200);
    expect(test.body.cta).toBe('start');
    expect(test.body.participation).toBeNull();
  });
});
