import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp, listenOnRandomPort } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

// A second studio, used to prove channel management is restricted to the owner.
const RIVAL = {
  userId: '01995000-0000-7000-8000-0000000000e1',
  orgId: '01995000-0000-7000-8000-0000000000f1',
  membershipId: '01995000-0000-7000-8000-0000000000e9',
  email: 'rival-owner@chat-e2e.dev',
};

type Ack<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

interface MessageView {
  id: string;
  channelId: string;
  authorUserId: string;
  authorDisplayName: string;
  body: string;
  status: string;
}

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

/** Resolves once the gateway has accepted the handshake and greeted the socket. */
function connect(port: number, token?: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(`http://127.0.0.1:${port}/chat`, {
      transports: ['websocket'],
      auth: token ? { token } : {},
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
    socket.on('chat:error', (err: { message: string }) => {
      clearTimeout(timer);
      socket.close();
      reject(new Error(err.message));
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function once<T>(socket: Socket, event: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando "${event}"`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function ack<T>(socket: Socket, event: string, payload: unknown): Promise<Ack<T>> {
  return socket.timeout(8000).emitWithAck(event, payload) as Promise<Ack<T>>;
}

describe('Chat em tempo real (e2e)', () => {
  let app: INestApplication;
  let port: number;
  let sql: postgres.Sql;
  let studioToken: string;
  let playerToken: string;
  let rivalToken: string;
  let channelId: string;

  beforeAll(async () => {
    app = await createE2EApp({ realtime: true });
    port = await listenOnRandomPort(app);
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${RIVAL.userId}, ${RIVAL.email}, password_hash, 'Rival Owner'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${RIVAL.orgId}, 'Rival Studio', 'rival-studio-chat', ${RIVAL.userId})
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

  describe('canais (REST)', () => {
    it('o estúdio dono cria um canal e o slug sai do nome', async () => {
      const res = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.one}/chat/channels`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ name: 'Geral', topic: 'Papo livre' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        gameId: GAME_IDS.one,
        slug: 'geral',
        name: 'Geral',
        archived: false,
      });
      channelId = res.body.id as string;
    });

    it('um jogador não cria canal', async () => {
      const res = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.one}/chat/channels`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ name: 'Canal do player' });
      expect(res.status).toBe(403);
    });

    it('outro estúdio não cria canal no jogo alheio', async () => {
      const res = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.one}/chat/channels`)
        .set('Authorization', `Bearer ${rivalToken}`)
        .send({ name: 'Invasao' });
      expect(res.status).toBe(403);
    });

    it('nome repetido no mesmo jogo vira 409', async () => {
      const res = await request(app.getHttpServer())
        .post(`/games/${GAME_IDS.one}/chat/channels`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ name: 'Geral' });
      expect(res.status).toBe(409);
    });

    it('qualquer autenticado lista os canais do jogo', async () => {
      const res = await request(app.getHttpServer())
        .get(`/games/${GAME_IDS.one}/chat/channels`)
        .set('Authorization', `Bearer ${playerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data.some((c: { id: string }) => c.id === channelId)).toBe(true);
    });
  });

  describe('handshake do socket', () => {
    it('recusa uma conexão sem token', async () => {
      await expect(connect(port)).rejects.toThrow(/Não autenticado/);
    });

    it('recusa um token inválido', async () => {
      await expect(connect(port, 'nao-e-um-jwt')).rejects.toThrow(/inválida|expirada/);
    });
  });

  describe('mensagens em tempo real', () => {
    let playerSocket: Socket;
    let studioSocket: Socket;

    beforeAll(async () => {
      playerSocket = await connect(port, playerToken);
      studioSocket = await connect(port, studioToken);
    });

    afterAll(() => {
      playerSocket?.close();
      studioSocket?.close();
    });

    it('entrar no canal devolve a presença e avisa quem já estava', async () => {
      const first = await ack<{ members: { userId: string }[] }>(playerSocket, 'channel:join', {
        channelId,
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.data.members).toHaveLength(1);

      // O segundo a entrar deve fazer o primeiro receber a presença atualizada.
      const presenceOnPlayer = once<{ members: { userId: string }[] }>(
        playerSocket,
        'channel:presence',
      );
      const second = await ack<{ members: unknown[] }>(studioSocket, 'channel:join', { channelId });
      expect(second.ok).toBe(true);
      expect((await presenceOnPlayer).members).toHaveLength(2);
    });

    it('404 ao entrar num canal inexistente', async () => {
      const res = await ack(playerSocket, 'channel:join', {
        channelId: '01920000-0000-7000-8000-00000000dead',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('NOT_FOUND');
    });

    it('payload inválido volta como VALIDATION_ERROR, não derruba o socket', async () => {
      const res = await ack(playerSocket, 'message:send', { channelId, body: '' });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe('VALIDATION_ERROR');
      expect(playerSocket.connected).toBe(true);
    });

    it('a mensagem do jogador chega ao estúdio pelo socket', async () => {
      const received = once<MessageView>(studioSocket, 'message:new');

      const sent = await ack<MessageView>(playerSocket, 'message:send', {
        channelId,
        body: 'Alguém aí?',
      });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;

      const broadcast = await received;
      expect(broadcast.id).toBe(sent.data.id);
      expect(broadcast.body).toBe('Alguém aí?');
      expect(broadcast.authorDisplayName).toBeTruthy();
    });

    it('uma mensagem enviada por REST também chega pelo socket', async () => {
      const received = once<MessageView>(playerSocket, 'message:new');

      const res = await request(app.getHttpServer())
        .post(`/chat/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ body: 'Estou aqui!' });
      expect(res.status).toBe(201);

      expect((await received).body).toBe('Estou aqui!');
    });

    it('propaga o indicador de digitação para os outros', async () => {
      const typing = once<{ userId: string; displayName: string }>(studioSocket, 'user:typing');
      const res = await ack(playerSocket, 'typing:start', { channelId });
      expect(res.ok).toBe(true);
      expect((await typing).displayName).toBeTruthy();
    });

    it('sair do canal atualiza a presença de quem ficou', async () => {
      const presence = once<{ members: unknown[] }>(studioSocket, 'channel:presence');
      await ack(playerSocket, 'channel:leave', { channelId });
      expect((await presence).members).toHaveLength(1);
    });
  });

  describe('histórico e moderação', () => {
    it('o histórico devolve as mensagens mais novas primeiro', async () => {
      const res = await request(app.getHttpServer())
        .get(`/chat/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${playerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.data[0].body).toBe('Estou aqui!');
      expect(res.body.data).toHaveLength(2);
    });

    it('o estúdio dono esconde uma mensagem e ela some do histórico', async () => {
      const history = await request(app.getHttpServer())
        .get(`/chat/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${playerToken}`);
      const target = history.body.data[0].id as string;

      const moderated = await request(app.getHttpServer())
        .patch(`/chat/messages/${target}/moderate`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ action: 'hide' });
      expect(moderated.status).toBe(200);
      expect(moderated.body.status).toBe('hidden');

      const after = await request(app.getHttpServer())
        .get(`/chat/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${playerToken}`);
      expect(after.body.data.some((m: { id: string }) => m.id === target)).toBe(false);
    });

    it('estúdio de outro jogo não modera — 403, não 404', async () => {
      const history = await request(app.getHttpServer())
        .get(`/chat/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${playerToken}`);
      const target = history.body.data[0].id as string;

      const res = await request(app.getHttpServer())
        .patch(`/chat/messages/${target}/moderate`)
        .set('Authorization', `Bearer ${rivalToken}`)
        .send({ action: 'hide' });
      expect(res.status).toBe(403);
    });

    it('a moderação é transmitida para quem está no canal', async () => {
      const socket = await connect(port, studioToken);
      try {
        await ack(socket, 'channel:join', { channelId });
        const history = await request(app.getHttpServer())
          .get(`/chat/channels/${channelId}/messages`)
          .set('Authorization', `Bearer ${playerToken}`);
        const target = history.body.data[0].id as string;

        const moderated = once<MessageView>(socket, 'message:moderated');
        await request(app.getHttpServer())
          .patch(`/chat/messages/${target}/moderate`)
          .set('Authorization', `Bearer ${studioToken}`)
          .send({ action: 'remove' });

        expect(await moderated).toMatchObject({ id: target, status: 'removed' });
      } finally {
        socket.close();
      }
    });
  });

  describe('canal arquivado', () => {
    it('arquivar recusa novas mensagens', async () => {
      const archived = await request(app.getHttpServer())
        .patch(`/chat/channels/${channelId}`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ archived: true });
      expect(archived.status).toBe(200);
      expect(archived.body.archived).toBe(true);

      const blocked = await request(app.getHttpServer())
        .post(`/chat/channels/${channelId}/messages`)
        .set('Authorization', `Bearer ${playerToken}`)
        .send({ body: 'ainda dá?' });
      expect(blocked.status).toBe(409);

      // Volta ao normal para não deixar o canal arquivado para outros testes.
      await request(app.getHttpServer())
        .patch(`/chat/channels/${channelId}`)
        .set('Authorization', `Bearer ${studioToken}`)
        .send({ archived: false });
    });
  });

  describe('flood control', () => {
    it('corta o usuário que passa do limite por janela', async () => {
      const limit = Number(process.env.CHAT_MESSAGE_THROTTLE_LIMIT);
      let throttled = false;

      // Usuário dedicado: o contador é por usuário, então isso não gasta a
      // cota dos outros testes deste arquivo.
      for (let i = 0; i <= limit; i++) {
        const res = await request(app.getHttpServer())
          .post(`/chat/channels/${channelId}/messages`)
          .set('Authorization', `Bearer ${rivalToken}`)
          .send({ body: `flood ${i}` });
        if (res.status === 429) {
          throttled = true;
          expect(res.body.code).toBe('TOO_MANY_REQUESTS');
          break;
        }
      }

      expect(throttled).toBe(true);
    });
  });
});
