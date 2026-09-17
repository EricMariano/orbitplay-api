import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, ORG_ID, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

// A second org/studio, used to prove moderation is restricted to the owning studio.
const RIVAL = {
  userId: '01994000-0000-7000-8000-0000000000e1',
  orgId: '01994000-0000-7000-8000-0000000000f1',
  membershipId: '01994000-0000-7000-8000-0000000000e9',
  email: 'rival-owner@community-e2e.dev',
};

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

describe('Community & reviews (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let studioToken: string;
  let ownerToken: string;
  let playerToken: string;
  let rivalOwnerToken: string;
  let postId: string;

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
      VALUES (${RIVAL.orgId}, 'Rival Studio', 'rival-studio-community', ${RIVAL.userId})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id)
      VALUES (${RIVAL.membershipId}, ${RIVAL.orgId}, ${RIVAL.userId},
              (SELECT id FROM roles WHERE key = 'owner'))
      ON CONFLICT DO NOTHING`;

    studioToken = await bearer(app, SEED_EMAILS.studio);
    ownerToken = await bearer(app, SEED_EMAILS.owner);
    playerToken = await bearer(app, SEED_EMAILS.player);
    rivalOwnerToken = await bearer(app, RIVAL.email);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  describe('community posts', () => {
    it('a studio role cannot post — only player', async () => {
      const res = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.one}/community/posts`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ body: 'Tentando postar como estúdio' });
      expect(res.status).toBe(403);
    });

    it('a player posts to the game community', async () => {
      const res = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.one}/community/posts`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ body: 'Adorei a demo!' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        gameId: GAME_IDS.one,
        body: 'Adorei a demo!',
        status: 'visible',
      });
      postId = res.body.id;
    });

    it('rejects an empty body with 422', async () => {
      const res = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.one}/community/posts`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ body: '' });
      expect(res.status).toBe(422);
    });

    it('404s for a non-existent game', async () => {
      const res = await request(app.getHttpServer())
        .post('/games/01994000-0000-7000-8000-00000000ffff/community/posts')
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ body: 'oi' });
      expect(res.status).toBe(404);
    });

    it('any authenticated role (e.g. studio, from any org) reads the community', async () => {
      const res = await request(app.getHttpServer())
        .get(`/games/${GAME_IDS.one}/community/posts`)
        .set('Authorization', `Bearer ${rivalOwnerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.some((p: { id: string }) => p.id === postId)).toBe(true);
    });

    it('an unauthenticated request gets 401', async () => {
      const res = await request(app.getHttpServer()).get(`/games/${GAME_IDS.one}/community/posts`);
      expect(res.status).toBe(401);
    });

    it('any authenticated user can report a post; unknown post 404s', async () => {
      const ok = await request(app.getHttpServer())
        .post(`/community/posts/${postId}/report`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ reason: 'spam' });
      expect(ok.status).toBe(202);
      expect(ok.body).toEqual({});

      const missing = await request(app.getHttpServer())
        .post('/community/posts/01994000-0000-7000-8000-00000000ffff/report')
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ reason: 'spam' });
      expect(missing.status).toBe(404);
    });

    it('rejects an unknown report reason with 422', async () => {
      const res = await request(app.getHttpServer())
        .post(`/community/posts/${postId}/report`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ reason: 'not-a-real-reason' });
      expect(res.status).toBe(422);
    });

    it('a studio from another org cannot moderate — 403, not 404 (public content, no tenancy hiding)', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/community/posts/${postId}/moderate`)
        .set('Authorization', `Bearer ${rivalOwnerToken}`)
        .send({ action: 'hide' });
      expect(res.status).toBe(403);
    });

    it('a player cannot moderate — studio+ only', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/community/posts/${postId}/moderate`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ action: 'hide' });
      expect(res.status).toBe(403);
    });

    it('rejects an action outside hide|restore|remove with 422', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/community/posts/${postId}/moderate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ action: 'pin' });
      expect(res.status).toBe(422);
    });

    it("the owning studio's owner hides the post, and it drops off the public list", async () => {
      const moderated = await request(app.getHttpServer())
        .patch(`/community/posts/${postId}/moderate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ action: 'hide' });
      expect(moderated.status).toBe(200);
      expect(moderated.body.status).toBe('hidden');

      const list = await request(app.getHttpServer())
        .get(`/games/${GAME_IDS.one}/community/posts`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(list.body.data.some((p: { id: string }) => p.id === postId)).toBe(false);
    });

    it('restores the post', async () => {
      const res = await request(app.getHttpServer())
        .patch(`/community/posts/${postId}/moderate`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ action: 'restore' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('visible');
    });
  });

  describe('game reviews', () => {
    it('starts with no reviews and a null average', async () => {
      const res = await request(app.getHttpServer())
        .get(`/games/${GAME_IDS.two}/reviews`)
        .set('Authorization', `Bearer ${studioToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ data: [], averageRating: null });
    });

    it('a player without a completed valid session cannot review — 403', async () => {
      const res = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.two}/reviews`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ rating: 5 });
      expect(res.status).toBe(403);
    });

    it('404s reviewing a non-existent game', async () => {
      const res = await request(app.getHttpServer())
        .post('/games/01994000-0000-7000-8000-00000000ffff/reviews')
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ rating: 5 });
      expect(res.status).toBe(404);
    });

    it('once eligible (a valid completed session), the player can review once, not twice', async () => {
      // Directly seed M8's tables (sessions/participations/session_validations)
      // since M8's HTTP layer doesn't exist yet — the eligibility check reads
      // these tables straight, so a real row makes it pass regardless.
      const testId = '01994000-0000-7000-8000-000000001001';
      const participationId = '01994000-0000-7000-8000-000000002001';
      const sessionId = '01994000-0000-7000-8000-000000003001';
      const playerRes = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${playerToken}`);
      const playerId = playerRes.body.id as string;

      await sql`
        INSERT INTO tests (id, organization_id, game_id, model_key, status)
        VALUES (${testId}, ${ORG_ID}, ${GAME_IDS.two}, 'free_exploration', 'published')
        ON CONFLICT DO NOTHING`;
      await sql`
        INSERT INTO participations (id, test_id, user_id, status)
        VALUES (${participationId}, ${testId}, ${playerId}, 'completed')
        ON CONFLICT DO NOTHING`;
      await sql`
        INSERT INTO sessions (id, participation_id, test_id, organization_id, status)
        VALUES (${sessionId}, ${participationId}, ${testId}, ${ORG_ID}, 'completed')
        ON CONFLICT DO NOTHING`;
      await sql`
        INSERT INTO session_validations (session_id, valid, validated_at)
        VALUES (${sessionId}, true, now())
        ON CONFLICT DO NOTHING`;

      const created = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.two}/reviews`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ rating: 5, body: 'Muito bom!' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ gameId: GAME_IDS.two, rating: 5, body: 'Muito bom!' });

      const again = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.two}/reviews`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ rating: 3 });
      expect(again.status).toBe(409);

      const list = await request(app.getHttpServer())
        .get(`/games/${GAME_IDS.two}/reviews`)
        .set('Authorization', `Bearer ${studioToken}`);
      expect(list.body.averageRating).toBe(5);
      expect(list.body.data.some((r: { rating: number }) => r.rating === 5)).toBe(true);
    });
  });
});
