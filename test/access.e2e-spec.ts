import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GAME_IDS, SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

const RIVAL = {
  userId: '01930000-0000-7000-8000-0000000000e2',
  orgId: '01930000-0000-7000-8000-0000000000f2',
  membershipId: '01930000-0000-7000-8000-0000000000ea',
  gameId: '01930000-0000-7000-8000-0000000000d2',
  email: 'rival-access@rival.dev',
};

const ALL = { manageAccess: true, editInfo: true, manageTests: true, viewReports: true };
const NONE = { manageAccess: false, editInfo: false, manageTests: false, viewReports: false };

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

describe('Groups and per-game access (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let ownerToken: string;
  let studioToken: string;
  let playerToken: string;
  let rivalToken: string;
  let studioUserId: string;
  let adminUserId: string;
  let playerUserId: string;
  let groupId: string;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${RIVAL.userId}, ${RIVAL.email}, password_hash, 'Rival Access'
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO organizations (id, name, slug, owner_user_id)
      VALUES (${RIVAL.orgId}, 'Rival Access Studio', 'rival-access-studio', ${RIVAL.userId})
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id)
      VALUES (${RIVAL.membershipId}, ${RIVAL.orgId}, ${RIVAL.userId},
              (SELECT id FROM roles WHERE key = 'owner'))
      ON CONFLICT DO NOTHING`;
    await sql`
      INSERT INTO games (id, organization_id, title, slug, status)
      VALUES (${RIVAL.gameId}, ${RIVAL.orgId}, 'Rival Access Game', 'rival-access-game', 'active')
      ON CONFLICT DO NOTHING`;

    const ids = await sql<{ email: string; id: string }[]>`
      SELECT email, id FROM users
      WHERE email IN (${SEED_EMAILS.studio}, ${SEED_EMAILS.admin}, ${SEED_EMAILS.player})`;
    const idOf = (email: string) => ids.find((u) => u.email === email)!.id;
    studioUserId = idOf(SEED_EMAILS.studio);
    adminUserId = idOf(SEED_EMAILS.admin);
    playerUserId = idOf(SEED_EMAILS.player);

    ownerToken = await bearer(app, SEED_EMAILS.owner);
    studioToken = await bearer(app, SEED_EMAILS.studio);
    playerToken = await bearer(app, SEED_EMAILS.player);
    rivalToken = await bearer(app, RIVAL.email);
  });

  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  it('lets owner/admin create a group and lists it with its members', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/groups')
      .set(auth(ownerToken))
      .send({ name: 'Diretores', memberUserIds: [studioUserId, adminUserId] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Diretores', memberCount: 2 });
    expect(res.body.memberUserIds).toEqual(expect.arrayContaining([studioUserId, adminUserId]));
    groupId = res.body.id as string;

    const list = await request(app.getHttpServer()).get('/orgs/groups').set(auth(studioToken));
    expect(list.status).toBe(200);
    expect(list.body.data.map((g: { name: string }) => g.name)).toContain('Diretores');
  });

  it('rejects duplicate names (409), player members (422) and non-managers (403)', async () => {
    const dup = await request(app.getHttpServer())
      .post('/orgs/groups')
      .set(auth(ownerToken))
      .send({ name: 'Diretores' });
    expect(dup.status).toBe(409);

    const player = await request(app.getHttpServer())
      .post('/orgs/groups')
      .set(auth(ownerToken))
      .send({ name: 'Com jogador', memberUserIds: [playerUserId] });
    expect(player.status).toBe(422);
    expect(player.body.fieldErrors).toHaveProperty('memberUserIds');

    const forbidden = await request(app.getHttpServer())
      .post('/orgs/groups')
      .set(auth(studioToken))
      .send({ name: 'Sem permissão' });
    expect(forbidden.status).toBe(403);

    const asPlayer = await request(app.getHttpServer()).get('/orgs/groups').set(auth(playerToken));
    expect(asPlayer.status).toBe(403);
  });

  it('keeps groups private to their organization', async () => {
    const rivalList = await request(app.getHttpServer()).get('/orgs/groups').set(auth(rivalToken));
    expect(rivalList.body.data).toEqual([]);

    const rivalPatch = await request(app.getHttpServer())
      .patch(`/orgs/groups/${groupId}`)
      .set(auth(rivalToken))
      .send({ name: 'Invadido' });
    expect(rivalPatch.status).toBe(404);
  });

  it('sets, reads and replaces the per-game permission matrix', async () => {
    const put = await request(app.getHttpServer())
      .put(`/games/${GAME_IDS.one}/access`)
      .set(auth(studioToken))
      .send({
        entries: [
          { subjectType: 'group', subjectId: groupId, permissions: ALL },
          {
            subjectType: 'member',
            subjectId: studioUserId,
            permissions: { ...NONE, viewReports: true },
          },
        ],
      });
    expect(put.status).toBe(200);
    expect(put.body.data).toHaveLength(2);

    const get = await request(app.getHttpServer())
      .get(`/games/${GAME_IDS.one}/access`)
      .set(auth(studioToken));
    expect(get.status).toBe(200);
    const group = get.body.data.find((e: { subjectType: string }) => e.subjectType === 'group');
    const member = get.body.data.find((e: { subjectType: string }) => e.subjectType === 'member');
    expect(group).toMatchObject({
      subjectId: groupId,
      name: 'Diretores',
      memberCount: 2,
      permissions: ALL,
    });
    expect(member).toMatchObject({
      subjectId: studioUserId,
      email: SEED_EMAILS.studio,
      permissions: { ...NONE, viewReports: true },
    });

    const audit = await sql`
      SELECT action FROM audit_log WHERE entity = 'game_access' AND entity_id = ${GAME_IDS.one}`;
    expect(audit.map((r) => r.action)).toContain('game.access.updated');

    const replaced = await request(app.getHttpServer())
      .put(`/games/${GAME_IDS.one}/access`)
      .set(auth(studioToken))
      .send({ entries: [] });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data).toEqual([]);
  });

  it('validates the matrix: duplicates, unknown groups, foreign games and roles', async () => {
    const duplicate = await request(app.getHttpServer())
      .put(`/games/${GAME_IDS.one}/access`)
      .set(auth(studioToken))
      .send({
        entries: [
          { subjectType: 'member', subjectId: studioUserId, permissions: ALL },
          { subjectType: 'member', subjectId: studioUserId, permissions: NONE },
        ],
      });
    expect(duplicate.status).toBe(422);

    const unknownGroup = await request(app.getHttpServer())
      .put(`/games/${GAME_IDS.one}/access`)
      .set(auth(studioToken))
      .send({
        entries: [
          {
            subjectType: 'group',
            subjectId: '01930000-0000-7000-8000-00000000ffff',
            permissions: ALL,
          },
        ],
      });
    expect(unknownGroup.status).toBe(422);

    const playerSubject = await request(app.getHttpServer())
      .put(`/games/${GAME_IDS.one}/access`)
      .set(auth(studioToken))
      .send({ entries: [{ subjectType: 'member', subjectId: playerUserId, permissions: ALL }] });
    expect(playerSubject.status).toBe(422);

    const rivalGame = await request(app.getHttpServer())
      .get(`/games/${RIVAL.gameId}/access`)
      .set(auth(studioToken));
    expect(rivalGame.status).toBe(404);

    const asPlayer = await request(app.getHttpServer())
      .get(`/games/${GAME_IDS.one}/access`)
      .set(auth(playerToken));
    expect(asPlayer.status).toBe(403);

    const malformed = await request(app.getHttpServer())
      .get('/games/not-a-uuid/access')
      .set(auth(studioToken));
    expect(malformed.status).toBe(404);
  });

  it('updates a group and drops its permissions when it is deleted', async () => {
    await request(app.getHttpServer())
      .put(`/games/${GAME_IDS.two}/access`)
      .set(auth(studioToken))
      .send({ entries: [{ subjectType: 'group', subjectId: groupId, permissions: ALL }] });

    const patched = await request(app.getHttpServer())
      .patch(`/orgs/groups/${groupId}`)
      .set(auth(ownerToken))
      .send({ name: 'Diretoria', memberUserIds: [studioUserId] });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: 'Diretoria', memberCount: 1 });

    const removed = await request(app.getHttpServer())
      .delete(`/orgs/groups/${groupId}`)
      .set(auth(ownerToken));
    expect(removed.status).toBe(204);

    const access = await request(app.getHttpServer())
      .get(`/games/${GAME_IDS.two}/access`)
      .set(auth(studioToken));
    expect(access.body.data).toEqual([]);

    const again = await request(app.getHttpServer())
      .delete(`/orgs/groups/${groupId}`)
      .set(auth(ownerToken));
    expect(again.status).toBe(404);
  });
});
