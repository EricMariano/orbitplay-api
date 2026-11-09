import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp, listenOnRandomPort } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

/**
 * Mural, avaliações e chat de um jogo que não está `active` (rascunho ou
 * arquivado): estado privado do estúdio (DECISIONS.md M8-03) — 404 para quem
 * não é da organização dona, que continua lendo e moderando.
 *
 * Tudo vive numa organização própria, para não mexer nas contagens de jogos
 * da org semeada de que outras specs dependem.
 */
const HIDDEN = {
  orgId: '019c1000-0000-7000-8000-0000000000f1',
  ownerId: '019c1000-0000-7000-8000-0000000000e1',
  membershipId: '019c1000-0000-7000-8000-0000000000e9',
  ownerEmail: 'owner@hidden-games-e2e.dev',
};

const GAMES = {
  draft: {
    gameId: '019c1000-0000-7000-8000-0000000000d1',
    postId: '019c1000-0000-7000-8000-0000000000a1',
    channelId: '019c1000-0000-7000-8000-0000000000c1',
  },
  archived: {
    gameId: '019c1000-0000-7000-8000-0000000000d2',
    postId: '019c1000-0000-7000-8000-0000000000a2',
    channelId: '019c1000-0000-7000-8000-0000000000c2',
  },
} as const;

type Ack = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.accessToken as string;
}

function connect(port: number, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}/chat`, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
    });
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timeout no handshake'));
    }, 8000);
    socket.on('connected', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('Comunidade e chat de jogo não publicado (e2e)', () => {
  let app: INestApplication;
  let port: number;
  let sql: postgres.Sql;
  let ownerToken: string;
  let playerToken: string;
  let otherStudioToken: string;
  let ownerSocket: Socket;
  let playerSocket: Socket;

  beforeAll(async () => {
    app = await createE2EApp({ realtime: true });
    port = await listenOnRandomPort(app);
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${HIDDEN.ownerId}, ${HIDDEN.ownerEmail}, password_hash, 'Hidden Owner'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${HIDDEN.orgId}, 'Hidden Games Studio', 'hidden-games-e2e', ${HIDDEN.ownerId})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id)
      VALUES (${HIDDEN.membershipId}, ${HIDDEN.orgId}, ${HIDDEN.ownerId},
              (SELECT id FROM roles WHERE key = 'owner'))
      ON CONFLICT DO NOTHING`;

    for (const [status, ids] of Object.entries(GAMES)) {
      await sql`
        INSERT INTO games (id, organization_id, title, slug, status)
        VALUES (${ids.gameId}, ${HIDDEN.orgId}, ${`Jogo ${status}`}, ${`jogo-${status}-e2e`},
                ${status})
        ON CONFLICT DO NOTHING`;
      await sql`
        INSERT INTO community_posts (id, game_id, author_user_id, body)
        VALUES (${ids.postId}, ${ids.gameId}, ${HIDDEN.ownerId}, 'Bastidores do estúdio')
        ON CONFLICT DO NOTHING`;
      await sql`
        INSERT INTO chat_channels (id, game_id, slug, name, created_by)
        VALUES (${ids.channelId}, ${ids.gameId}, 'geral', 'Geral', ${HIDDEN.ownerId})
        ON CONFLICT DO NOTHING`;
    }

    ownerToken = await bearer(app, HIDDEN.ownerEmail);
    // Both seeded accounts belong to ANOTHER organization than the games' owner.
    playerToken = await bearer(app, SEED_EMAILS.player);
    otherStudioToken = await bearer(app, SEED_EMAILS.studio);

    ownerSocket = await connect(port, ownerToken);
    playerSocket = await connect(port, playerToken);
  });

  afterAll(async () => {
    ownerSocket?.close();
    playerSocket?.close();
    await sql.end({ timeout: 5 });
    await app.close();
  });

  describe.each(Object.entries(GAMES))('jogo %s', (_status, ids) => {
    const http = () => request(app.getHttpServer());

    describe('para quem não é da organização dona → 404', () => {
      it('mural: listar, publicar e denunciar', async () => {
        const list = await http()
          .get(`/games/${ids.gameId}/community/posts`)
          .set('Authorization', `Bearer ${playerToken}`);
        expect(list.status).toBe(404);
        expect(list.body.code).toBe('NOT_FOUND');

        const create = await http()
          .post(`/games/${ids.gameId}/community/posts`)
          .set('Authorization', `Bearer ${playerToken}`)
          .send({ body: 'Achei pelo id!' });
        expect(create.status).toBe(404);

        const report = await http()
          .post(`/community/posts/${ids.postId}/report`)
          .set('Authorization', `Bearer ${playerToken}`)
          .send({ reason: 'spam' });
        expect(report.status).toBe(404);

        const rows = await sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM community_posts WHERE game_id = ${ids.gameId}`;
        expect(rows[0].count).toBe('1');
      });

      it('avaliações: listar e avaliar', async () => {
        const list = await http()
          .get(`/games/${ids.gameId}/reviews`)
          .set('Authorization', `Bearer ${playerToken}`);
        expect(list.status).toBe(404);

        const create = await http()
          .post(`/games/${ids.gameId}/reviews`)
          .set('Authorization', `Bearer ${playerToken}`)
          .send({ rating: 5 });
        expect(create.status).toBe(404);
      });

      it('outro estúdio não modera (404, não 403: o post não é público)', async () => {
        const res = await http()
          .patch(`/community/posts/${ids.postId}/moderate`)
          .set('Authorization', `Bearer ${otherStudioToken}`)
          .send({ action: 'hide' });
        expect(res.status).toBe(404);
      });

      it('chat REST: canais, histórico e envio', async () => {
        const channels = await http()
          .get(`/games/${ids.gameId}/chat/channels`)
          .set('Authorization', `Bearer ${playerToken}`);
        expect(channels.status).toBe(404);

        const history = await http()
          .get(`/chat/channels/${ids.channelId}/messages`)
          .set('Authorization', `Bearer ${playerToken}`);
        expect(history.status).toBe(404);

        const send = await http()
          .post(`/chat/channels/${ids.channelId}/messages`)
          .set('Authorization', `Bearer ${playerToken}`)
          .send({ body: 'oi' });
        expect(send.status).toBe(404);
      });

      it('chat socket: entrar no canal e enviar', async () => {
        const join = (await playerSocket
          .timeout(8000)
          .emitWithAck('channel:join', { channelId: ids.channelId })) as Ack;
        expect(join).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

        const send = (await playerSocket
          .timeout(8000)
          .emitWithAck('message:send', { channelId: ids.channelId, body: 'oi' })) as Ack;
        expect(send).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

        const rows = await sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM chat_messages WHERE channel_id = ${ids.channelId}
            AND author_user_id <> ${HIDDEN.ownerId}`;
        expect(rows[0].count).toBe('0');
      });
    });

    describe('para a organização dona → continua acessível', () => {
      it('lê o mural e as avaliações', async () => {
        const posts = await http()
          .get(`/games/${ids.gameId}/community/posts`)
          .set('Authorization', `Bearer ${ownerToken}`);
        expect(posts.status).toBe(200);
        expect((posts.body.data as { id: string }[]).map((p) => p.id)).toContain(ids.postId);

        const reviews = await http()
          .get(`/games/${ids.gameId}/reviews`)
          .set('Authorization', `Bearer ${ownerToken}`);
        expect(reviews.status).toBe(200);
      });

      it('modera o mural', async () => {
        const hide = await http()
          .patch(`/community/posts/${ids.postId}/moderate`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ action: 'hide' });
        expect(hide.status).toBe(200);
        expect(hide.body.status).toBe('hidden');

        const restore = await http()
          .patch(`/community/posts/${ids.postId}/moderate`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ action: 'restore' });
        expect(restore.status).toBe(200);
      });

      it('usa o chat por REST e por socket', async () => {
        const channels = await http()
          .get(`/games/${ids.gameId}/chat/channels`)
          .set('Authorization', `Bearer ${ownerToken}`);
        expect(channels.status).toBe(200);
        expect((channels.body.data as { id: string }[]).map((c) => c.id)).toContain(ids.channelId);

        const send = await http()
          .post(`/chat/channels/${ids.channelId}/messages`)
          .set('Authorization', `Bearer ${ownerToken}`)
          .send({ body: 'Só a equipe vê isto' });
        expect(send.status).toBe(201);

        const history = await http()
          .get(`/chat/channels/${ids.channelId}/messages`)
          .set('Authorization', `Bearer ${ownerToken}`);
        expect(history.status).toBe(200);

        const join = (await ownerSocket
          .timeout(8000)
          .emitWithAck('channel:join', { channelId: ids.channelId })) as Ack;
        expect(join.ok).toBe(true);
      });
    });
  });
});
