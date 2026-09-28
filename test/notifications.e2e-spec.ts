import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

const NEWER_UNREAD = '01990000-0000-7000-8000-0000000000c3';
const OLDER_UNREAD = '01990000-0000-7000-8000-0000000000c2';
const ALREADY_READ = '01990000-0000-7000-8000-0000000000c1';
const OTHER_USER = '01990000-0000-7000-8000-0000000000d1';
const SEEDED_IDS = [NEWER_UNREAD, OLDER_UNREAD, ALREADY_READ, OTHER_USER];

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

describe('Notifications (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let playerToken: string;
  let studioToken: string;
  let playerId: string;
  let studioId: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    playerToken = await bearer(app, SEED_EMAILS.player);
    studioToken = await bearer(app, SEED_EMAILS.studio);

    const player = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${playerToken}`);
    playerId = player.body.id as string;

    const studio = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${studioToken}`);
    studioId = studio.body.id as string;

    await sql`DELETE FROM notifications WHERE user_id IN (${playerId}, ${studioId})`;
    await sql`
      INSERT INTO notifications (id, user_id, kind, title, body, link, read_at)
      VALUES
        (${NEWER_UNREAD}, ${playerId}, 'session.validated', 'Sessão validada', 'Aceita.', '/sessions/new', NULL),
        (${OLDER_UNREAD}, ${playerId}, 'test.published', 'Teste publicado', NULL, NULL, NULL),
        (${ALREADY_READ}, ${playerId}, 'build.rejected', 'Build reprovada', 'Checksum.', NULL, now()),
        (${OTHER_USER}, ${studioId}, 'member.invited', 'Convite', 'Você foi convidado.', '/orgs', NULL)`;
  });

  afterAll(async () => {
    await sql`DELETE FROM notifications WHERE id IN ${sql(SEEDED_IDS)}`;
    await sql.end({ timeout: 5 });
    await app.close();
  });

  describe('GET /notifications', () => {
    it('requires auth', async () => {
      const res = await request(app.getHttpServer()).get('/notifications');
      expect(res.status).toBe(401);
    });

    it('lists only the caller inbox, newest id first, with the unread total', async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${playerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.unreadCount).toBe(2);
      expect(res.body.data.map((n: { id: string }) => n.id)).toEqual([
        NEWER_UNREAD,
        OLDER_UNREAD,
        ALREADY_READ,
      ]);
      expect(res.body.data[0]).toMatchObject({
        type: 'session.validated',
        title: 'Sessão validada',
        read: false,
        link: '/sessions/new',
      });
      expect(res.body.data[1]).toMatchObject({ body: null, link: null, read: false });
      expect(res.body.data[2]).toMatchObject({ type: 'build.rejected', read: true });
      expect(res.body.nextCursor).toBeNull();
    });

    it('unreadOnly drops rows that already have read_at', async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications?unreadOnly=true')
        .set('Authorization', `Bearer ${playerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.map((n: { id: string }) => n.id)).toEqual([NEWER_UNREAD, OLDER_UNREAD]);
      expect(res.body.unreadCount).toBe(2);
    });

    it('paginates with limit=1 and an opaque cursor', async () => {
      const first = await request(app.getHttpServer())
        .get('/notifications?limit=1')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(first.body.data).toHaveLength(1);
      expect(first.body.data[0].id).toBe(NEWER_UNREAD);
      expect(first.body.nextCursor).toEqual(expect.any(String));

      const second = await request(app.getHttpServer())
        .get(`/notifications?limit=1&cursor=${first.body.nextCursor}`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(second.body.data[0].id).toBe(OLDER_UNREAD);
    });

    it('a studio account sees only its own notification', async () => {
      const res = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${studioToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        expect.objectContaining({ id: OTHER_USER, type: 'member.invited', read: false }),
      ]);
      expect(res.body.unreadCount).toBe(1);
    });
  });

  describe('PATCH /notifications/:id/read', () => {
    it('marks the row read and drops unreadCount; repeating is a 204', async () => {
      const first = await request(app.getHttpServer())
        .patch(`/notifications/${NEWER_UNREAD}/read`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(first.status).toBe(204);
      expect(first.body).toEqual({});

      const list = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(list.body.unreadCount).toBe(1);
      expect(list.body.data.find((n: { id: string }) => n.id === NEWER_UNREAD)).toMatchObject({
        read: true,
      });

      const again = await request(app.getHttpServer())
        .patch(`/notifications/${NEWER_UNREAD}/read`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(again.status).toBe(204);
    });

    it('another user notification, a malformed id, and an unknown id are 404', async () => {
      const foreign = await request(app.getHttpServer())
        .patch(`/notifications/${OTHER_USER}/read`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe('NOT_FOUND');

      const malformed = await request(app.getHttpServer())
        .patch('/notifications/not-a-uuid/read')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(malformed.status).toBe(404);

      const missing = await request(app.getHttpServer())
        .patch('/notifications/01990000-0000-7000-8000-0000000000ff/read')
        .set('Authorization', `Bearer ${playerToken}`);
      expect(missing.status).toBe(404);

      const studio = await request(app.getHttpServer())
        .get('/notifications')
        .set('Authorization', `Bearer ${studioToken}`);
      expect(studio.body.data[0]).toMatchObject({ id: OTHER_USER, read: false });
    });
  });
});
