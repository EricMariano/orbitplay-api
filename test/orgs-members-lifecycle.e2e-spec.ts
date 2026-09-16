import type { INestApplication } from '@nestjs/common';
import postgres from 'postgres';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_EMAILS, SEED_PASSWORD } from '../src/infra/database/seed';
import { CapturingMailAdapter, createE2EApp } from './helpers/e2e-app';
import { TEST_DATABASE_URL } from './helpers/test-db';

async function bearer(app: INestApplication, email: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: SEED_PASSWORD });
  return res.body.accessToken as string;
}

/** A dedicated org (one owner, one admin, one studio member) so the last-owner
 * rule and the owner/admin split can be exercised without touching the
 * seeded org other specs rely on. */
const STATUS_ORG = {
  orgId: '01960000-0000-7000-8000-0000000000f1',
  owner: { id: '01960000-0000-7000-8000-0000000000a1', email: 'owner@status-org.dev' },
  admin: { id: '01960000-0000-7000-8000-0000000000a2', email: 'admin@status-org.dev' },
  member: { id: '01960000-0000-7000-8000-0000000000a3', email: 'membro@status-org.dev' },
};

/** A separate org (single owner + one member) for the DELETE tests. */
const REMOVE_ORG = {
  orgId: '01970000-0000-7000-8000-0000000000f1',
  owner: { id: '01970000-0000-7000-8000-0000000000a1', email: 'owner@remove-org.dev' },
  member: { id: '01970000-0000-7000-8000-0000000000a2', email: 'membro@remove-org.dev' },
};

async function seedOrg(
  sql: postgres.Sql,
  org: { orgId: string; name: string; slug: string },
  people: { id: string; email: string; role: 'owner' | 'admin' | 'studio' }[],
): Promise<void> {
  const ownerId = people.find((p) => p.role === 'owner')!.id;
  for (const person of people) {
    await sql`
      INSERT INTO users (id, email, password_hash, display_name)
      SELECT ${person.id}, ${person.email}, password_hash, ${person.email}
      FROM users WHERE email = ${SEED_EMAILS.studio}
      ON CONFLICT DO NOTHING`;
  }
  await sql`
    INSERT INTO organizations (id, name, slug, owner_user_id)
    VALUES (${org.orgId}, ${org.name}, ${org.slug}, ${ownerId})
    ON CONFLICT DO NOTHING`;
  for (const person of people) {
    await sql`
      INSERT INTO memberships (id, organization_id, user_id, role_id, status)
      VALUES (gen_random_uuid(), ${org.orgId}, ${person.id},
              (SELECT id FROM roles WHERE key = ${person.role}), 'active')
      ON CONFLICT DO NOTHING`;
  }
}

describe('Org members — change status (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let ownerToken: string;
  let adminToken: string;
  let seededAdminToken: string;
  let seededStudioToken: string;
  let seededPlayerToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await seedOrg(sql, { orgId: STATUS_ORG.orgId, name: 'Status Org', slug: 'status-org' }, [
      { ...STATUS_ORG.owner, role: 'owner' },
      { ...STATUS_ORG.admin, role: 'admin' },
      { ...STATUS_ORG.member, role: 'studio' },
    ]);

    ownerToken = await bearer(app, STATUS_ORG.owner.email);
    adminToken = await bearer(app, STATUS_ORG.admin.email);
    seededAdminToken = await bearer(app, SEED_EMAILS.admin);
    seededStudioToken = await bearer(app, SEED_EMAILS.studio);
    seededPlayerToken = await bearer(app, SEED_EMAILS.player);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  function patchStatus(token: string, userId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .patch(`/orgs/members/${userId}/status`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('owner disables a member', async () => {
    const res = await patchStatus(ownerToken, STATUS_ORG.member.id, {
      status: 'disabled',
      confirm: true,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: STATUS_ORG.member.id, status: 'disabled' });
  });

  it('the new status shows up in the members list', async () => {
    const res = await request(app.getHttpServer())
      .get('/orgs/members')
      .set('Authorization', `Bearer ${ownerToken}`);

    const member = (res.body.data as { userId: string; status: string }[]).find(
      (m) => m.userId === STATUS_ORG.member.id,
    );
    expect(member).toMatchObject({ status: 'disabled' });
  });

  it('records the change in audit_log (RN-05)', async () => {
    const rows = await sql<{ before: unknown; after: unknown }[]>`
      SELECT before, after FROM audit_log
      WHERE action = 'org.member_status_changed' AND entity_id = ${STATUS_ORG.member.id}
      ORDER BY created_at DESC LIMIT 1`;

    expect(rows[0]).toMatchObject({ before: { status: 'active' }, after: { status: 'disabled' } });
  });

  it('admin re-activates the member (owner/admin both allowed)', async () => {
    const res = await patchStatus(adminToken, STATUS_ORG.member.id, {
      status: 'active',
      confirm: true,
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'active' });
  });

  it('studio cannot change status: 403', async () => {
    const res = await patchStatus(seededStudioToken, STATUS_ORG.member.id, {
      status: 'disabled',
      confirm: true,
    });
    expect(res.status).toBe(403);
  });

  it('player cannot change status: 403', async () => {
    const res = await patchStatus(seededPlayerToken, STATUS_ORG.member.id, {
      status: 'disabled',
      confirm: true,
    });
    expect(res.status).toBe(403);
  });

  it('refuses to disable the last active owner with 409 (RN-03/RN-06)', async () => {
    const res = await patchStatus(ownerToken, STATUS_ORG.owner.id, {
      status: 'disabled',
      confirm: true,
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });

  it('404s for a user outside the caller organization', async () => {
    const res = await patchStatus(seededAdminToken, STATUS_ORG.member.id, {
      status: 'disabled',
      confirm: true,
    });
    expect(res.status).toBe(404);
  });

  it('rejects a missing confirm with 422', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/orgs/members/${STATUS_ORG.member.id}/status`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'disabled' });
    expect(res.status).toBe(422);
  });
});

describe('Org members — trigger password reset (e2e)', () => {
  let app: INestApplication;
  let mail: CapturingMailAdapter;
  let sql: postgres.Sql;
  let ownerToken: string;
  let adminToken: string;
  let seededStudioToken: string;

  beforeAll(async () => {
    mail = new CapturingMailAdapter();
    app = await createE2EApp({ mail });
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await seedOrg(sql, { orgId: STATUS_ORG.orgId, name: 'Status Org', slug: 'status-org' }, [
      { ...STATUS_ORG.owner, role: 'owner' },
      { ...STATUS_ORG.admin, role: 'admin' },
      { ...STATUS_ORG.member, role: 'studio' },
    ]);

    ownerToken = await bearer(app, STATUS_ORG.owner.email);
    adminToken = await bearer(app, STATUS_ORG.admin.email);
    seededStudioToken = await bearer(app, SEED_EMAILS.studio);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  it('owner triggers a reset e-mail for a member: 202', async () => {
    mail.clear();
    const res = await request(app.getHttpServer())
      .post(`/orgs/members/${STATUS_ORG.member.id}/password-reset`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send();

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ message: expect.any(String) });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toBe(STATUS_ORG.member.email);
    expect(mail.lastResetToken()).toBeTruthy();
  });

  it('the password is never returned or exposed (RN-04)', async () => {
    mail.clear();
    const res = await request(app.getHttpServer())
      .post(`/orgs/members/${STATUS_ORG.member.id}/password-reset`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send();

    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
  });

  it('admin may also trigger the reset', async () => {
    const res = await request(app.getHttpServer())
      .post(`/orgs/members/${STATUS_ORG.member.id}/password-reset`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send();
    expect(res.status).toBe(202);
  });

  it('studio cannot trigger a reset: 403', async () => {
    const res = await request(app.getHttpServer())
      .post(`/orgs/members/${STATUS_ORG.member.id}/password-reset`)
      .set('Authorization', `Bearer ${seededStudioToken}`)
      .send();
    expect(res.status).toBe(403);
  });

  it('404s for a user who is not a member of the caller organization', async () => {
    const res = await request(app.getHttpServer())
      .post('/orgs/members/00000000-0000-7000-8000-000000000000/password-reset')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send();
    expect(res.status).toBe(404);
  });

  it('records the trigger in audit_log (RN-05)', async () => {
    const rows = await sql<{ action: string }[]>`
      SELECT action FROM audit_log
      WHERE action = 'org.member_password_reset_triggered' AND entity_id = ${STATUS_ORG.member.id}
      ORDER BY created_at DESC LIMIT 1`;
    expect(rows).toHaveLength(1);
  });
});

describe('Org members — remove (e2e)', () => {
  let app: INestApplication;
  let sql: postgres.Sql;
  let ownerToken: string;
  let seededAdminToken: string;

  beforeAll(async () => {
    app = await createE2EApp();
    sql = postgres(TEST_DATABASE_URL, { max: 1 });

    await seedOrg(sql, { orgId: REMOVE_ORG.orgId, name: 'Remove Org', slug: 'remove-org' }, [
      { ...REMOVE_ORG.owner, role: 'owner' },
      { ...REMOVE_ORG.member, role: 'studio' },
    ]);

    ownerToken = await bearer(app, REMOVE_ORG.owner.email);
    seededAdminToken = await bearer(app, SEED_EMAILS.admin);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
    await app.close();
  });

  it('admin cannot remove a member: 403 (owner-only)', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/orgs/members/${REMOVE_ORG.member.id}`)
      .set('Authorization', `Bearer ${seededAdminToken}`);
    expect(res.status).toBe(403);
  });

  it('owner removes a member: 204', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/orgs/members/${REMOVE_ORG.member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(204);
  });

  it('the removed member no longer shows up in the members list', async () => {
    const res = await request(app.getHttpServer())
      .get('/orgs/members')
      .set('Authorization', `Bearer ${ownerToken}`);

    const member = (res.body.data as { userId: string }[]).find(
      (m) => m.userId === REMOVE_ORG.member.id,
    );
    expect(member).toBeUndefined();
  });

  it('records a logical-deactivation audit entry (RN-05/RN-06)', async () => {
    const rows = await sql<{ before: unknown; after: unknown }[]>`
      SELECT before, after FROM audit_log
      WHERE action = 'org.member_removed' AND entity_id = ${REMOVE_ORG.member.id}
      ORDER BY created_at DESC LIMIT 1`;

    expect(rows[0]).toMatchObject({
      before: { status: 'active' },
      after: { status: 'disabled', deletedAt: true },
    });
  });

  it('404s when removing the same member again', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/orgs/members/${REMOVE_ORG.member.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it('refuses to remove the last active owner with 409 (RN-03)', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/orgs/members/${REMOVE_ORG.owner.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
  });
});
