import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DashboardKpiCache } from '../src/infra/redis/dashboard-kpi-cache';
import { GAME_IDS, ORG_ID, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

// Fixed ids for a second organization used to prove cross-org isolation.
const RIVAL = {
  userId: '01997000-0000-7000-8000-0000000000e1',
  orgId: '01997000-0000-7000-8000-0000000000f1',
  membershipId: '01997000-0000-7000-8000-0000000000e9',
  gameId: '01997000-0000-7000-8000-0000000000d1',
  email: 'rival-owner@dashboard-rival.dev',
};

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

interface Kpi {
  value: number | null;
  delta: number | null;
  unit: string | null;
}

describe('Studio dashboard (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let studioToken: string;
  let playerToken: string;
  let rivalToken: string;

  const getDashboard = (token: string) =>
    request(app.getHttpServer()).get('/studio/dashboard').set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${RIVAL.userId}, ${RIVAL.email}, password_hash, 'Rival Owner'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${RIVAL.orgId}, 'Dashboard Rival', 'dashboard-rival', ${RIVAL.userId})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id)
      VALUES (${RIVAL.membershipId}, ${RIVAL.orgId}, ${RIVAL.userId},
              (SELECT id FROM roles WHERE key = 'owner'))
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO games (id, organization_id, title, slug, status)
      VALUES (${RIVAL.gameId}, ${RIVAL.orgId}, 'Rival Game', 'dashboard-rival-game', 'active')
      ON CONFLICT DO NOTHING`;

    // Redis outlives the test database between runs — never start from a stale entry.
    const cache = app.get(DashboardKpiCache);
    await Promise.all([cache.invalidate(ORG_ID), cache.invalidate(RIVAL.orgId)]);

    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
    rivalToken = await bearer(app, RIVAL.email);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  it('returns KPIs consolidated by the backend, scoped to the org (RN-01/RN-02)', async () => {
    const res = await getDashboard(studioToken);
    expect(res.status).toBe(200);

    const [{ games }] = await sql<{ games: number }[]>`
      SELECT count(*)::int AS games FROM games
      WHERE organization_id = ${ORG_ID} AND deleted_at IS NULL`;
    const [{ tests }] = await sql<{ tests: number }[]>`
      SELECT count(*)::int AS tests FROM tests WHERE organization_id = ${ORG_ID}`;

    const kpis = res.body.kpis as Record<string, Kpi>;
    expect(kpis.gamesTotal).toEqual({ value: games, delta: null, unit: null });
    expect(kpis.testsTotal.value).toBe(tests);
    expect(Object.keys(kpis).sort()).toEqual(
      [
        'averageRating',
        'completionRate',
        'gamesTotal',
        'playersTotal',
        'sessionsValid',
        'testsActive',
        'testsTotal',
      ].sort(),
    );
    expect(kpis.completionRate.unit).toBe('ratio');

    expect(res.body.games.length).toBeGreaterThan(0);
    expect(
      res.body.games.every((g: { organizationId: string }) => g.organizationId === ORG_ID),
    ).toBe(true);
    expect(
      res.body.recentTests.every((t: { organizationId: string }) => t.organizationId === ORG_ID),
    ).toBe(true);
    expect(res.body.stats).toMatchObject({ key: 'sessions_evolution', status: 'ready' });
  });

  it('serves KPIs from cache and drops them when a domain event happens', async () => {
    const before = await getDashboard(studioToken);
    const testsBefore = (before.body.kpis as Record<string, Kpi>).testsTotal.value!;
    const gamesBefore = (before.body.kpis as Record<string, Kpi>).gamesTotal.value!;

    // A write that bypasses the services emits no event: the cached value stays.
    await sql`
      INSERT INTO games (id, organization_id, title, slug, status)
      VALUES (gen_random_uuid(), ${ORG_ID}, 'Out of band', ${`out-of-band-${Date.now()}`}, 'draft')`;
    const cached = await getDashboard(studioToken);
    expect((cached.body.kpis as Record<string, Kpi>).gamesTotal.value).toBe(gamesBefore);

    // Creating a test through the API invalidates the org's KPIs.
    const created = await request(app.getHttpServer())
      .post(`/games/${GAME_IDS.one}/tests`)
      .set('Authorization', `Bearer ${studioToken}`)
      .send({ testModelKey: 'free_exploration', title: 'Dashboard KPI' });
    expect(created.status).toBe(201);

    const after = await getDashboard(studioToken);
    const kpis = after.body.kpis as Record<string, Kpi>;
    expect(kpis.testsTotal.value).toBe(testsBefore + 1);
    expect(kpis.gamesTotal.value).toBe(gamesBefore + 1);
    expect(after.body.recentTests[0].id).toBe(created.body.id);
  });

  it('never mixes another organization’s data in', async () => {
    const res = await getDashboard(rivalToken);
    expect(res.status).toBe(200);
    const kpis = res.body.kpis as Record<string, Kpi>;
    expect(kpis.gamesTotal.value).toBe(1);
    expect(kpis.testsTotal.value).toBe(0);
    expect(kpis.completionRate.value).toBeNull();
    expect(res.body.games.map((g: { id: string }) => g.id)).toEqual([RIVAL.gameId]);
    expect(res.body.recentTests).toEqual([]);
  });

  it('is studio-only: player gets 403, anonymous gets 401', async () => {
    const asPlayer = await getDashboard(playerToken);
    expect(asPlayer.status).toBe(403);

    const anonymous = await request(app.getHttpServer()).get('/studio/dashboard');
    expect(anonymous.status).toBe(401);
  });

  it('exposes the benchmark contract as unavailable until its data source is decided', async () => {
    const res = await request(app.getHttpServer())
      .get('/studio/benchmark')
      .set('Authorization', `Bearer ${studioToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      key: 'benchmark',
      status: 'unavailable',
      payload: null,
      computedAt: null,
    });

    const asPlayer = await request(app.getHttpServer())
      .get('/studio/benchmark')
      .set('Authorization', `Bearer ${playerToken}`);
    expect(asPlayer.status).toBe(403);
  });
});
