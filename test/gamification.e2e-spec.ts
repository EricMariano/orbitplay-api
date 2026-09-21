import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
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

describe('Gamification (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let playerToken: string;
  let studioToken: string;
  let playerId: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    playerToken = await bearer(app, SEED_EMAILS.player);
    studioToken = await bearer(app, SEED_EMAILS.studio);

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${playerToken}`);
    playerId = me.body.id as string;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  describe('GET /player/progress', () => {
    it('requires auth', async () => {
      const res = await request(app.getHttpServer()).get('/player/progress');
      expect(res.status).toBe(401);
    });

    it('a studio role cannot read player progress — player-only', async () => {
      const res = await request(app.getHttpServer())
        .get('/player/progress')
        .set('Authorization', `Bearer ${studioToken}`);
      expect(res.status).toBe(403);
    });

    it('starts at level 1 / 0 XP with no achievements/XP history', async () => {
      const res = await request(app.getHttpServer())
        .get('/player/progress')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.status).toBe(200);
      // hoursPlayed/testsCompleted are NOT asserted here: the e2e suite shares
      // one seeded database across spec files (test/setup-e2e.ts resets it
      // once for the whole run, not per file) — community.e2e-spec.ts's
      // review test already writes a valid `completed` session for this same
      // seeded player, so testsCompleted may already be >0 by the time this
      // file runs. Real coverage for those two fields is the unit spec
      // (`gamification.service.spec.ts`), which controls the repository.
      expect(res.body).toMatchObject({
        level: 1,
        xp: 0,
        xpToNextLevel: 100,
        feedbackQuality: 0,
        achievementsUnlocked: 0,
      });
    });

    it('reflects the XP ledger once an event is recorded (pre-M8: seeded straight into xp_events)', async () => {
      await sql`
        INSERT INTO xp_events (id, user_id, source_type, source_id, xp)
        VALUES (gen_random_uuid(), ${playerId}, 'manual_test', gen_random_uuid(), 150)
        ON CONFLICT DO NOTHING`;

      const res = await request(app.getHttpServer())
        .get('/player/progress')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.body).toMatchObject({ level: 2, xp: 150, xpToNextLevel: 50 });
    });
  });

  describe('GET /player/achievements', () => {
    it('lists the seeded catalog, all locked for a fresh player', async () => {
      const res = await request(app.getHttpServer())
        .get('/player/achievements')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data.every((a: { unlocked: boolean }) => a.unlocked === false)).toBe(true);
    });

    it('marks an achievement unlocked once player_achievements has a row', async () => {
      await sql`
        INSERT INTO player_achievements (id, user_id, achievement_key, progress, unlocked_at)
        VALUES (gen_random_uuid(), ${playerId}, 'first_test_completed', 1, now())
        ON CONFLICT (user_id, achievement_key) DO UPDATE SET unlocked_at = now()`;

      const res = await request(app.getHttpServer())
        .get('/player/achievements')
        .set('Authorization', `Bearer ${playerToken}`);
      const unlocked = res.body.data.find(
        (a: { achievement: { key: string } }) => a.achievement.key === 'first_test_completed',
      );
      expect(unlocked).toMatchObject({ unlocked: true });
      expect(unlocked.unlockedAt).not.toBeNull();
    });

    it('paginates with limit=1', async () => {
      const res = await request(app.getHttpServer())
        .get('/player/achievements?limit=1')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.nextCursor).not.toBeNull();
    });
  });

  describe('GET /player/missions', () => {
    it('lists the seeded active missions with progress 0', async () => {
      const res = await request(app.getHttpServer())
        .get('/player/missions')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toMatchObject({ progress: 0, target: 1 });
    });
  });

  describe('GET /rankings', () => {
    it('scope=game without gameId is a 422', async () => {
      const res = await request(app.getHttpServer())
        .get('/rankings?scope=game')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.status).toBe(422);
    });

    it('empty page when no snapshot has been computed yet', async () => {
      const res = await request(app.getHttpServer())
        .get('/rankings')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ data: [], nextCursor: null, currentUserEntry: null });
    });

    it('serves from a materialized snapshot and flags the current user', async () => {
      await sql`
        INSERT INTO ranking_snapshots (id, scope, period, game_id, entries)
        VALUES (gen_random_uuid(), 'global', 'month', NULL, ${JSON.stringify([
          { position: 1, userId: '01994000-0000-7000-8000-00000000fff1', displayName: 'Rival', level: 9, score: 999 },
          { position: 2, userId: playerId, displayName: 'Pedro Player', level: 2, score: 150 },
        ])}::jsonb)`;

      const res = await request(app.getHttpServer())
        .get('/rankings')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.currentUserEntry).toMatchObject({ userId: playerId, isCurrentUser: true });
    });

    it('scope=game requires the gameId to resolve a snapshot (still empty — none computed for this game)', async () => {
      const res = await request(app.getHttpServer())
        .get(`/rankings?scope=game&gameId=${GAME_IDS.one}`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });
});
