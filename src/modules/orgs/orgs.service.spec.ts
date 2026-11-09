import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationRow } from '../../infra/database/schema/organizations';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import type { NotificationPort } from '../../shared/ports/notification.port';
import { Role } from '../../shared/auth/roles';
import type { AuthService } from '../auth/auth.service';
import type { PasswordService } from '../auth/password.service';
import {
  InviteEmailUnavailableError,
  LastOwnerError,
  MemberAlreadyExistsError,
  OwnerOnlyError,
  type OrgsRepository,
} from './orgs.repository';
import { OrgsService } from './orgs.service';

const ORG = '01920000-0000-7000-8000-0000000000a1';
const INVITED_USER = '01920000-0000-7000-8000-0000000000c9';
const INVITED_MEMBERSHIP = '01920000-0000-7000-8000-0000000000d9';

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
  let auth: {
    triggerPasswordReset: ReturnType<typeof vi.fn>;
    issueInviteToken: ReturnType<typeof vi.fn>;
  };
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
          membershipId: INVITED_MEMBERSHIP,
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
    auth = {
      triggerPasswordReset: vi.fn().mockResolvedValue(undefined),
      issueInviteToken: vi.fn().mockResolvedValue('raw-invite-token'),
    };
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

  it('answers a clear 409 (not "já é membro") when the e-mail belongs to a deleted account', async () => {
    repo.createInvitedMember.mockRejectedValue(new InviteEmailUnavailableError());

    const err: unknown = await service
      .inviteMember(ORG, Role.OWNER, { email: 'excluido@estudio.dev', role: 'studio' }, req)
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 409 });
    expect((err as Error).message).toContain('conta excluída');
    expect(mail.sendEmail).not.toHaveBeenCalled();
    expect(drainAuditDrafts(req)).toHaveLength(0);
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

  it('e-mails a single-use acceptance link (never a password) for the new membership', async () => {
    const view = await service.inviteMember(
      ORG,
      Role.OWNER,
      { email: 'novo@estudio.dev', role: 'studio' },
      req,
    );

    expect(auth.issueInviteToken).toHaveBeenCalledWith(INVITED_MEMBERSHIP, ORG);
    expect(mail.sendEmail).toHaveBeenCalledTimes(1);
    const message = mail.sendEmail.mock.calls[0][0] as {
      to: string;
      subject: string;
      text: string;
    };
    expect(message.to).toBe('novo@estudio.dev');
    expect(message.subject).toContain('OrbitPlay Studio Demo');
    expect(message.text).toContain('http://localhost:5173/accept-invite?token=raw-invite-token');
    expect(message.text).not.toContain('Esqueci minha senha');
    expect(message.text).not.toContain('argon2-placeholder');
    // The internal membership id never reaches the response.
    expect(view).not.toHaveProperty('membershipId');
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
  const CALLER = '01920000-0000-7000-8000-0000000000c6';

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
      CALLER,
      Role.OWNER,
      TARGET,
      { status: 'disabled', confirm: true },
      req,
    );

    expect(view).toMatchObject({ userId: TARGET, status: 'disabled' });
    expect(repo.changeMemberStatus).toHaveBeenCalledWith({
      organizationId: ORG,
      userId: TARGET,
      status: 'disabled',
      callerRole: Role.OWNER,
    });
  });

  it('refuses to let a caller change their own status: 403', async () => {
    await expect(
      service.changeMemberStatus(
        ORG,
        TARGET,
        Role.OWNER,
        TARGET,
        { status: 'disabled', confirm: true },
        req,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.changeMemberStatus).not.toHaveBeenCalled();
  });

  it('refuses it as well when the id comes in upper case', async () => {
    await expect(
      service.changeMemberStatus(
        ORG,
        TARGET,
        Role.OWNER,
        TARGET.toUpperCase(),
        { status: 'active', confirm: true },
        req,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.changeMemberStatus).not.toHaveBeenCalled();
  });

  it("maps an admin acting on an owner to 403 (role hierarchy), passing the caller's role", async () => {
    repo.changeMemberStatus.mockRejectedValue(new OwnerOnlyError());

    await expect(
      service.changeMemberStatus(
        ORG,
        CALLER,
        Role.ADMIN,
        TARGET,
        { status: 'disabled', confirm: true },
        req,
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.changeMemberStatus).toHaveBeenCalledWith(
      expect.objectContaining({ callerRole: Role.ADMIN }),
    );
    expect(drainAuditDrafts(req)).toHaveLength(0);
  });

  it('maps the last-owner rule to a 409 conflict (RN-03/RN-06)', async () => {
    repo.changeMemberStatus.mockRejectedValue(new LastOwnerError());

    await expect(
      service.changeMemberStatus(
        ORG,
        CALLER,
        Role.OWNER,
        TARGET,
        { status: 'disabled', confirm: true },
        req,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('404s when the user is not a member of this organization', async () => {
    repo.changeMemberStatus.mockResolvedValue(null);

    await expect(
      service.changeMemberStatus(
        ORG,
        CALLER,
        Role.OWNER,
        TARGET,
        { status: 'disabled', confirm: true },
        req,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('records the status change in the audit trail (RN-05)', async () => {
    await service.changeMemberStatus(
      ORG,
      CALLER,
      Role.OWNER,
      TARGET,
      { status: 'disabled', confirm: true },
      req,
    );

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
  const CALLER = '01920000-0000-7000-8000-0000000000c7';

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
    await service.removeMember(ORG, CALLER, Role.OWNER, TARGET, req);
    expect(repo.removeMember).toHaveBeenCalledWith(ORG, TARGET, Role.OWNER);
  });

  it('refuses to let a caller remove themselves: 403', async () => {
    await expect(service.removeMember(ORG, TARGET, Role.OWNER, TARGET, req)).rejects.toMatchObject({
      status: 403,
    });
    expect(repo.removeMember).not.toHaveBeenCalled();
  });

  it('refuses self-removal when the id comes in upper case', async () => {
    await expect(
      service.removeMember(ORG, TARGET, Role.OWNER, TARGET.toUpperCase(), req),
    ).rejects.toMatchObject({ status: 403 });
    expect(repo.removeMember).not.toHaveBeenCalled();
  });

  it('maps an admin removing an owner to 403 (role hierarchy)', async () => {
    repo.removeMember.mockRejectedValue(new OwnerOnlyError());

    await expect(service.removeMember(ORG, CALLER, Role.ADMIN, TARGET, req)).rejects.toMatchObject({
      status: 403,
    });
    expect(repo.removeMember).toHaveBeenCalledWith(ORG, TARGET, Role.ADMIN);
    expect(drainAuditDrafts(req)).toHaveLength(0);
  });

  it('maps the last-owner rule to a 409 conflict (RN-03)', async () => {
    repo.removeMember.mockRejectedValue(new LastOwnerError());

    await expect(service.removeMember(ORG, CALLER, Role.OWNER, TARGET, req)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('404s when the user is not a member of this organization', async () => {
    repo.removeMember.mockResolvedValue(null);

    await expect(service.removeMember(ORG, CALLER, Role.OWNER, TARGET, req)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('records a logical-deactivation audit entry (RN-05/RN-06)', async () => {
    await service.removeMember(ORG, CALLER, Role.OWNER, TARGET, req);

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
    const result = await service.triggerMemberPasswordReset(ORG, Role.OWNER, TARGET, req);

    expect(result).toEqual({ message: expect.any(String) });
    expect(auth.triggerPasswordReset).toHaveBeenCalledWith(TARGET);
  });

  it('404s when the user is not a member of this organization', async () => {
    repo.findMembership.mockResolvedValue(null);

    await expect(
      service.triggerMemberPasswordReset(ORG, Role.OWNER, TARGET, req),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(auth.triggerPasswordReset).not.toHaveBeenCalled();
  });

  it('refuses an admin acting on an owner: 403 (role hierarchy)', async () => {
    repo.findMembership.mockResolvedValue({
      userId: TARGET,
      email: 'dono@orbitplay.dev',
      displayName: 'Dono',
      role: 'owner',
      status: 'active',
    });

    await expect(
      service.triggerMemberPasswordReset(ORG, Role.ADMIN, TARGET, req),
    ).rejects.toMatchObject({ status: 403 });
    expect(auth.triggerPasswordReset).not.toHaveBeenCalled();
  });

  it('lets an owner act on another owner', async () => {
    repo.findMembership.mockResolvedValue({
      userId: TARGET,
      email: 'dono@orbitplay.dev',
      displayName: 'Dono',
      role: 'owner',
      status: 'active',
    });

    await service.triggerMemberPasswordReset(ORG, Role.OWNER, TARGET, req);
    expect(auth.triggerPasswordReset).toHaveBeenCalledWith(TARGET);
  });

  it('answers 409 for a pending invite — a reset never accepts it (use resend)', async () => {
    repo.findMembership.mockResolvedValue({
      userId: TARGET,
      email: 'convidado@orbitplay.dev',
      displayName: 'convidado@orbitplay.dev',
      role: 'studio',
      status: 'invited',
    });

    await expect(
      service.triggerMemberPasswordReset(ORG, Role.OWNER, TARGET, req),
    ).rejects.toMatchObject({ status: 409 });
    expect(auth.triggerPasswordReset).not.toHaveBeenCalled();
    expect(drainAuditDrafts(req)).toHaveLength(0);
  });

  it('records the trigger in the audit trail (RN-05)', async () => {
    await service.triggerMemberPasswordReset(ORG, Role.OWNER, TARGET, req);

    const drafts = drainAuditDrafts(req);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'org.member_password_reset_triggered',
      entity: 'users',
      entityId: TARGET,
    });
  });
});

describe('OrgsService resendInvite', () => {
  const TARGET = '01920000-0000-7000-8000-0000000000ca';
  const MEMBERSHIP = '01920000-0000-7000-8000-0000000000da';

  let repo: {
    findMembership: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
  };
  let auth: { reissueInviteToken: ReturnType<typeof vi.fn> };
  let mail: { sendEmail: ReturnType<typeof vi.fn> };
  let service: OrgsService;
  let req: Request;

  const invitedMember = (overrides: Record<string, unknown> = {}) => ({
    membershipId: MEMBERSHIP,
    userId: TARGET,
    email: 'convidado@estudio.dev',
    displayName: 'convidado@estudio.dev',
    role: 'studio',
    status: 'invited',
    ...overrides,
  });

  beforeEach(() => {
    repo = {
      findMembership: vi.fn().mockResolvedValue(invitedMember()),
      findById: vi.fn().mockResolvedValue(makeOrg()),
    };
    auth = { reissueInviteToken: vi.fn().mockResolvedValue('fresh-token') };
    mail = { sendEmail: vi.fn().mockResolvedValue(undefined) };
    service = new OrgsService(
      repo as unknown as OrgsRepository,
      { hash: vi.fn() } as unknown as PasswordService,
      { get: vi.fn().mockReturnValue('http://localhost:5173') } as unknown as ConfigService,
      auth as unknown as AuthService,
      mail as unknown as NotificationPort,
    );
    req = {} as Request;
  });

  it('issues a fresh token (voiding the old one) and e-mails the new link', async () => {
    const result = await service.resendInvite(ORG, Role.ADMIN, TARGET, req);

    expect(result).toEqual({ message: 'Convite reenviado.' });
    expect(auth.reissueInviteToken).toHaveBeenCalledWith(MEMBERSHIP, ORG, 'convidado@estudio.dev');
    const message = mail.sendEmail.mock.calls[0][0] as { to: string; text: string };
    expect(message.to).toBe('convidado@estudio.dev');
    expect(message.text).toContain('/accept-invite?token=fresh-token');
    expect(drainAuditDrafts(req)[0]).toMatchObject({
      action: 'org.member_invite_resent',
      entityId: TARGET,
    });
  });

  it('409s for a member who already accepted', async () => {
    repo.findMembership.mockResolvedValue(invitedMember({ status: 'active' }));

    await expect(service.resendInvite(ORG, Role.OWNER, TARGET, req)).rejects.toMatchObject({
      status: 409,
    });
    expect(auth.reissueInviteToken).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  it("refuses an admin resending an owner's invite: 403", async () => {
    repo.findMembership.mockResolvedValue(invitedMember({ role: 'owner' }));

    await expect(service.resendInvite(ORG, Role.ADMIN, TARGET, req)).rejects.toMatchObject({
      status: 403,
    });
    expect(auth.reissueInviteToken).not.toHaveBeenCalled();
  });

  it('404s when the user is not a member of this organization', async () => {
    repo.findMembership.mockResolvedValue(null);

    await expect(service.resendInvite(ORG, Role.OWNER, TARGET, req)).rejects.toMatchObject({
      status: 404,
    });
  });
});
