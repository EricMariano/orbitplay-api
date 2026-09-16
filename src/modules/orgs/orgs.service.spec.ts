import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationRow } from '../../infra/database/schema/organizations';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import type { NotificationPort } from '../../shared/ports/notification.port';
import { Role } from '../../shared/auth/roles';
import type { AuthService } from '../auth/auth.service';
import type { PasswordService } from '../auth/password.service';
import { LastOwnerError, MemberAlreadyExistsError, type OrgsRepository } from './orgs.repository';
import { OrgsService } from './orgs.service';

const ORG = '01920000-0000-7000-8000-0000000000a1';
const INVITED_USER = '01920000-0000-7000-8000-0000000000c9';

function makeOrg(overrides: Partial<OrganizationRow> = {}): OrganizationRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: ORG,
    name: 'OrbitPlay Studio Demo',
    slug: 'orbitplay-studio-demo',
    ownerUserId: '01920000-0000-7000-8000-0000000000c1',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

describe('OrgsService inviteMember', () => {
  let repo: {
    findById: ReturnType<typeof vi.fn>;
    findBySlug: ReturnType<typeof vi.fn>;
    updateById: ReturnType<typeof vi.fn>;
    listMembers: ReturnType<typeof vi.fn>;
    findRoleIdByKey: ReturnType<typeof vi.fn>;
    createInvitedMember: ReturnType<typeof vi.fn>;
  };
  let password: { hash: ReturnType<typeof vi.fn> };
  let config: { get: ReturnType<typeof vi.fn> };
  let auth: { triggerPasswordReset: ReturnType<typeof vi.fn> };
  let mail: { sendEmail: ReturnType<typeof vi.fn> };
  let service: OrgsService;
  let req: Request;

  beforeEach(() => {
    repo = {
      findById: vi.fn().mockResolvedValue(makeOrg()),
      findBySlug: vi.fn().mockResolvedValue(null),
      updateById: vi
        .fn()
        .mockImplementation((_organizationId: string, patch: Record<string, unknown>) =>
          Promise.resolve(makeOrg(patch)),
        ),
      listMembers: vi.fn(),
      findRoleIdByKey: vi.fn(),
      createInvitedMember: vi.fn().mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve({
          userId: INVITED_USER,
          email: input.email,
          displayName: input.displayName,
          role: input.role,
          status: 'invited',
        }),
      ),
    };
    password = { hash: vi.fn().mockResolvedValue('argon2-placeholder') };
    config = { get: vi.fn().mockReturnValue('http://localhost:5173') };
    auth = { triggerPasswordReset: vi.fn().mockResolvedValue(undefined) };
    mail = { sendEmail: vi.fn().mockResolvedValue(undefined) };

    service = new OrgsService(
      repo as unknown as OrgsRepository,
      password as unknown as PasswordService,
      config as unknown as ConfigService,
      auth as unknown as AuthService,
      mail as unknown as NotificationPort,
    );
    req = {} as Request;
  });

  it('creates the membership as invited, never active', async () => {
    const view = await service.inviteMember(
      ORG,
      Role.OWNER,
      { email: 'novo@estudio.dev', role: 'studio' },
      req,
    );

    expect(view.status).toBe('invited');
    expect(repo.createInvitedMember).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, role: 'studio' }),
    );
  });

  it('never stores a caller-supplied password — the hash comes from random bytes', async () => {
    await service.inviteMember(ORG, Role.OWNER, { email: 'novo@estudio.dev', role: 'admin' }, req);

    expect(password.hash).toHaveBeenCalledTimes(1);
    const hashed = password.hash.mock.calls[0][0] as string;
    // base64url of 32 random bytes — never anything the request could control.
    expect(hashed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(repo.createInvitedMember).toHaveBeenCalledWith(
      expect.objectContaining({ passwordHash: 'argon2-placeholder' }),
    );
  });

  it('normalizes the e-mail and falls back to it when displayName is omitted', async () => {
    const view = await service.inviteMember(
      ORG,
      Role.OWNER,
      { email: '  Novo@Estudio.DEV ', role: 'studio' },
      req,
    );

    expect(view.email).toBe('novo@estudio.dev');
    expect(view.displayName).toBe('novo@estudio.dev');
  });

  it('keeps the given displayName when provided', async () => {
    const view = await service.inviteMember(
      ORG,
      Role.OWNER,
      { email: 'novo@estudio.dev', displayName: 'Ana Souza', role: 'studio' },
      req,
    );

    expect(view.displayName).toBe('Ana Souza');
  });

  it('refuses an admin granting the owner role (privilege escalation)', async () => {
    await expect(
      service.inviteMember(ORG, Role.ADMIN, { email: 'meu@email.dev', role: 'owner' }, req),
    ).rejects.toMatchObject({ status: 403 });

    expect(repo.createInvitedMember).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it('lets an owner grant the owner role', async () => {
    const view = await service.inviteMember(
      ORG,
      Role.OWNER,
      { email: 'socio@estudio.dev', role: 'owner' },
      req,
    );

    expect(view.role).toBe('owner');
  });

  it('lets an admin grant the non-owner roles', async () => {
    const view = await service.inviteMember(
      ORG,
      Role.ADMIN,
      { email: 'novo@estudio.dev', role: 'admin' },
      req,
    );

    expect(view.role).toBe('admin');
  });

  it('maps an existing membership to a 409 conflict', async () => {
    repo.createInvitedMember.mockRejectedValue(new MemberAlreadyExistsError());

    await expect(
      service.inviteMember(ORG, Role.OWNER, { email: 'ja@membro.dev', role: 'studio' }, req),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('records an org.member_invited audit intent (Tela 20 RN-05)', async () => {
    await service.inviteMember(ORG, Role.OWNER, { email: 'novo@estudio.dev', role: 'studio' }, req);

    const drafts = drainAuditDrafts(req);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'org.member_invited',
      entity: 'memberships',
      entityId: INVITED_USER,
    });
  });

  it('sends the invitation e-mail without any token or password', async () => {
    await service.inviteMember(ORG, Role.OWNER, { email: 'novo@estudio.dev', role: 'studio' }, req);

    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    const message = mail.sendEmail.mock.calls[0][0] as {
      to: string;
      subject: string;
      text: string;
    };
    expect(message.to).toBe('novo@estudio.dev');
    expect(message.subject).toContain('OrbitPlay Studio Demo');
    expect(message.text).toContain('Esqueci minha senha');
    expect(message.text).not.toContain('token');
  });

  it('404s when the organization does not exist', async () => {
    repo.findById.mockResolvedValue(null);

    await expect(
      service.inviteMember(ORG, Role.OWNER, { email: 'novo@estudio.dev', role: 'studio' }, req),
    ).rejects.toMatchObject({ status: 404 });
    expect(repo.createInvitedMember).not.toHaveBeenCalled();
  });

  describe('updateCurrent (ORB-M2-02)', () => {
    it('updates the org name', async () => {
      const view = await service.updateCurrent(ORG, { name: 'Novo Nome' }, req);

      expect(view.name).toBe('Novo Nome');
      expect(repo.updateById).toHaveBeenCalledWith(ORG, { name: 'Novo Nome' });
    });

    it('updates the slug after checking uniqueness', async () => {
      const view = await service.updateCurrent(ORG, { slug: 'novo-slug' }, req);

      expect(view.slug).toBe('novo-slug');
      expect(repo.findBySlug).toHaveBeenCalledWith('novo-slug');
      expect(repo.updateById).toHaveBeenCalledWith(ORG, { slug: 'novo-slug' });
    });

    it('skips the uniqueness check when the slug is unchanged', async () => {
      await service.updateCurrent(ORG, { slug: 'orbitplay-studio-demo' }, req);

      expect(repo.findBySlug).not.toHaveBeenCalled();
    });

    it('409s when another organization already owns the slug', async () => {
      repo.findBySlug.mockResolvedValue(makeOrg({ id: 'outra-org', slug: 'ocupado' }));

      await expect(service.updateCurrent(ORG, { slug: 'ocupado' }, req)).rejects.toMatchObject({
        status: 409,
      });
      expect(repo.updateById).not.toHaveBeenCalled();
    });

    it('404s when the organization does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(service.updateCurrent(ORG, { name: 'X' }, req)).rejects.toMatchObject({
        status: 404,
      });
      expect(repo.updateById).not.toHaveBeenCalled();
    });

    it('records an org.updated audit intent with before/after', async () => {
      await service.updateCurrent(ORG, { name: 'Novo Nome' }, req);

      const drafts = drainAuditDrafts(req);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        action: 'org.updated',
        entity: 'organizations',
        entityId: ORG,
        before: { name: 'OrbitPlay Studio Demo' },
        after: { name: 'Novo Nome' },
      });
    });
  });
});

describe('OrgsService changeMemberRole', () => {
  const TARGET = '01920000-0000-7000-8000-0000000000c2';

  let repo: {
    findById: ReturnType<typeof vi.fn>;
    changeMemberRole: ReturnType<typeof vi.fn>;
  };
  let service: OrgsService;
  let req: Request;

  beforeEach(() => {
    repo = {
      findById: vi.fn().mockResolvedValue(makeOrg()),
      changeMemberRole: vi.fn().mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve({
          previousRole: 'studio',
          member: {
            userId: TARGET,
            email: 'admin@orbitplay.dev',
            displayName: 'Admin',
            role: input.role,
            status: 'active',
          },
        }),
      ),
    };

    service = new OrgsService(
      repo as unknown as OrgsRepository,
      { hash: vi.fn() } as unknown as PasswordService,
      { get: vi.fn() } as unknown as ConfigService,
      { triggerPasswordReset: vi.fn() } as unknown as AuthService,
      { sendEmail: vi.fn() } as unknown as NotificationPort,
    );
    req = {} as Request;
  });

  it('returns the member with the new role', async () => {
    const view = await service.changeMemberRole(ORG, TARGET, { role: 'admin', confirm: true }, req);

    expect(view).toMatchObject({ userId: TARGET, role: 'admin', status: 'active' });
    expect(repo.changeMemberRole).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: TARGET,
      role: 'admin',
    });
  });

  it('maps the last-owner rule to a 409 conflict (RN-03)', async () => {
    repo.changeMemberRole.mockRejectedValue(new LastOwnerError());

    await expect(
      service.changeMemberRole(ORG, TARGET, { role: 'studio', confirm: true }, req),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('404s when the user is not a member of this organization', async () => {
    repo.changeMemberRole.mockResolvedValue(null);

    await expect(
      service.changeMemberRole(ORG, TARGET, { role: 'admin', confirm: true }, req),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('records the role change with both roles in the audit trail (RN-05)', async () => {
    await service.changeMemberRole(ORG, TARGET, { role: 'admin', confirm: true }, req);

    const drafts = drainAuditDrafts(req);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'org.member_role_changed',
      entity: 'memberships',
      entityId: TARGET,
      before: { role: 'studio' },
      after: { role: 'admin' },
    });
  });

  it('records no audit when the change is refused', async () => {
    repo.changeMemberRole.mockRejectedValue(new LastOwnerError());

    await expect(
      service.changeMemberRole(ORG, TARGET, { role: 'studio', confirm: true }, req),
    ).rejects.toMatchObject({ status: 409 });
    expect(drainAuditDrafts(req)).toHaveLength(0);
  });
});

describe('OrgsService changeMemberStatus', () => {
  const TARGET = '01920000-0000-7000-8000-0000000000c3';

  let repo: { changeMemberStatus: ReturnType<typeof vi.fn> };
  let service: OrgsService;
  let req: Request;

  beforeEach(() => {
    repo = {
      changeMemberStatus: vi.fn().mockImplementation((input: Record<string, unknown>) =>
        Promise.resolve({
          previousStatus: 'active',
          member: {
            userId: TARGET,
            email: 'membro@orbitplay.dev',
            displayName: 'Membro',
            role: 'studio',
            status: input.status,
          },
        }),
      ),
    };

    service = new OrgsService(
      repo as unknown as OrgsRepository,
      { hash: vi.fn() } as unknown as PasswordService,
      { get: vi.fn() } as unknown as ConfigService,
      { triggerPasswordReset: vi.fn() } as unknown as AuthService,
      { sendEmail: vi.fn() } as unknown as NotificationPort,
    );
    req = {} as Request;
  });

  it('returns the member with the new status', async () => {
    const view = await service.changeMemberStatus(
      ORG,
      TARGET,
      { status: 'disabled', confirm: true },
      req,
    );

    expect(view).toMatchObject({ userId: TARGET, status: 'disabled' });
    expect(repo.changeMemberStatus).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: TARGET,
      status: 'disabled',
    });
  });

  it('maps the last-owner rule to a 409 conflict (RN-03/RN-06)', async () => {
    repo.changeMemberStatus.mockRejectedValue(new LastOwnerError());

    await expect(
      service.changeMemberStatus(ORG, TARGET, { status: 'disabled', confirm: true }, req),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('404s when the user is not a member of this organization', async () => {
    repo.changeMemberStatus.mockResolvedValue(null);

    await expect(
      service.changeMemberStatus(ORG, TARGET, { status: 'disabled', confirm: true }, req),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('records the status change in the audit trail (RN-05)', async () => {
    await service.changeMemberStatus(ORG, TARGET, { status: 'disabled', confirm: true }, req);

    const drafts = drainAuditDrafts(req);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'org.member_status_changed',
      entity: 'memberships',
      entityId: TARGET,
      before: { status: 'active' },
      after: { status: 'disabled' },
    });
  });
});

describe('OrgsService removeMember', () => {
  const TARGET = '01920000-0000-7000-8000-0000000000c4';

  let repo: { removeMember: ReturnType<typeof vi.fn> };
  let service: OrgsService;
  let req: Request;

  beforeEach(() => {
    repo = {
      removeMember: vi.fn().mockResolvedValue({ previousStatus: 'active' }),
    };

    service = new OrgsService(
      repo as unknown as OrgsRepository,
      { hash: vi.fn() } as unknown as PasswordService,
      { get: vi.fn() } as unknown as ConfigService,
      { triggerPasswordReset: vi.fn() } as unknown as AuthService,
      { sendEmail: vi.fn() } as unknown as NotificationPort,
    );
    req = {} as Request;
  });

  it('removes the member', async () => {
    await service.removeMember(ORG, TARGET, req);
    expect(repo.removeMember).toHaveBeenCalledWith(ORG, TARGET);
  });

  it('maps the last-owner rule to a 409 conflict (RN-03)', async () => {
    repo.removeMember.mockRejectedValue(new LastOwnerError());

    await expect(service.removeMember(ORG, TARGET, req)).rejects.toMatchObject({ status: 409 });
  });

  it('404s when the user is not a member of this organization', async () => {
    repo.removeMember.mockResolvedValue(null);

    await expect(service.removeMember(ORG, TARGET, req)).rejects.toMatchObject({ status: 404 });
  });

  it('records a logical-deactivation audit entry (RN-05/RN-06)', async () => {
    await service.removeMember(ORG, TARGET, req);

    const drafts = drainAuditDrafts(req);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'org.member_removed',
      entity: 'memberships',
      entityId: TARGET,
      before: { status: 'active' },
      after: { status: 'disabled', deletedAt: true },
    });
  });
});

describe('OrgsService triggerMemberPasswordReset', () => {
  const TARGET = '01920000-0000-7000-8000-0000000000c5';

  let repo: { findMembership: ReturnType<typeof vi.fn> };
  let auth: { triggerPasswordReset: ReturnType<typeof vi.fn> };
  let service: OrgsService;
  let req: Request;

  beforeEach(() => {
    repo = {
      findMembership: vi.fn().mockResolvedValue({
        userId: TARGET,
        email: 'membro@orbitplay.dev',
        displayName: 'Membro',
        role: 'studio',
        status: 'active',
      }),
    };
    auth = { triggerPasswordReset: vi.fn().mockResolvedValue(undefined) };

    service = new OrgsService(
      repo as unknown as OrgsRepository,
      { hash: vi.fn() } as unknown as PasswordService,
      { get: vi.fn() } as unknown as ConfigService,
      auth as unknown as AuthService,
      { sendEmail: vi.fn() } as unknown as NotificationPort,
    );
    req = {} as Request;
  });

  it('triggers the reset flow for a member of the organization', async () => {
    const result = await service.triggerMemberPasswordReset(ORG, TARGET, req);

    expect(result).toEqual({ message: expect.any(String) });
    expect(auth.triggerPasswordReset).toHaveBeenCalledWith(TARGET);
  });

  it('404s when the user is not a member of this organization', async () => {
    repo.findMembership.mockResolvedValue(null);

    await expect(service.triggerMemberPasswordReset(ORG, TARGET, req)).rejects.toMatchObject({
      status: 404,
    });
    expect(auth.triggerPasswordReset).not.toHaveBeenCalled();
  });

  it('records the trigger in the audit trail (RN-05)', async () => {
    await service.triggerMemberPasswordReset(ORG, TARGET, req);

    const drafts = drainAuditDrafts(req);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'org.member_password_reset_triggered',
      entity: 'users',
      entityId: TARGET,
    });
  });
});
