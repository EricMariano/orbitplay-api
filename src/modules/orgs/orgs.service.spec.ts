import type { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrganizationRow } from '../../infra/database/schema/organizations';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import type { NotificationPort } from '../../shared/ports/notification.port';
import { Role } from '../../shared/auth/roles';
import type { PasswordService } from '../auth/password.service';
import { MemberAlreadyExistsError, type OrgsRepository } from './orgs.repository';
import { OrgsService } from './orgs.service';

const ORG = '01920000-0000-7000-8000-0000000000a1';
const INVITED_USER = '01920000-0000-7000-8000-0000000000c9';
const TARGET_USER = '01920000-0000-7000-8000-0000000000d1';
const CALLER_USER = '01920000-0000-7000-8000-0000000000d2';

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

function makeMembership(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    membershipId: '01920000-0000-7000-8000-0000000000e1',
    userId: TARGET_USER,
    email: 'membro@estudio.dev',
    displayName: 'Membro Estúdio',
    role: 'studio',
    status: 'active' as const,
    ...overrides,
  };
}

type RepoMock = {
  findById: ReturnType<typeof vi.fn>;
  listMembers: ReturnType<typeof vi.fn>;
  findRoleIdByKey: ReturnType<typeof vi.fn>;
  createInvitedMember: ReturnType<typeof vi.fn>;
  findMembershipInOrg: ReturnType<typeof vi.fn>;
  countActiveOwners: ReturnType<typeof vi.fn>;
  updateMemberStatusInOrg: ReturnType<typeof vi.fn>;
  softDeleteMembershipInOrg: ReturnType<typeof vi.fn>;
};

describe('OrgsService', () => {
  let repo: RepoMock;
  let password: { hash: ReturnType<typeof vi.fn> };
  let config: { get: ReturnType<typeof vi.fn> };
  let mail: { sendEmail: ReturnType<typeof vi.fn> };
  let service: OrgsService;
  let req: Request;

  beforeEach(() => {
    repo = {
      findById: vi.fn().mockResolvedValue(makeOrg()),
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
      findMembershipInOrg: vi.fn().mockResolvedValue(makeMembership()),
      countActiveOwners: vi.fn().mockResolvedValue(1),
      updateMemberStatusInOrg: vi.fn().mockResolvedValue(undefined),
      softDeleteMembershipInOrg: vi.fn().mockResolvedValue(undefined),
    };
    password = { hash: vi.fn().mockResolvedValue('argon2-placeholder') };
    config = { get: vi.fn().mockReturnValue('http://localhost:5173') };
    mail = { sendEmail: vi.fn().mockResolvedValue(undefined) };

    service = new OrgsService(
      repo as unknown as OrgsRepository,
      password as unknown as PasswordService,
      config as unknown as ConfigService,
      mail as unknown as NotificationPort,
    );
    req = {} as Request;
  });

  describe('inviteMember', () => {
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
      await service.inviteMember(
        ORG,
        Role.OWNER,
        { email: 'novo@estudio.dev', role: 'admin' },
        req,
      );

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
      await service.inviteMember(
        ORG,
        Role.OWNER,
        { email: 'novo@estudio.dev', role: 'studio' },
        req,
      );

      const drafts = drainAuditDrafts(req);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        action: 'org.member_invited',
        entity: 'memberships',
        entityId: INVITED_USER,
      });
    });

    it('sends the invitation e-mail without any token or password', async () => {
      await service.inviteMember(
        ORG,
        Role.OWNER,
        { email: 'novo@estudio.dev', role: 'studio' },
        req,
      );

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
  });

  describe('updateMemberStatus', () => {
    it('disables an active studio member', async () => {
      const view = await service.updateMemberStatus(
        ORG,
        CALLER_USER,
        TARGET_USER,
        { status: 'disabled' },
        req,
      );

      expect(view.status).toBe('disabled');
      expect(repo.updateMemberStatusInOrg).toHaveBeenCalledWith(ORG, TARGET_USER, 'disabled');
    });

    it('re-activates a disabled member', async () => {
      repo.findMembershipInOrg.mockResolvedValue(makeMembership({ status: 'disabled' }));

      const view = await service.updateMemberStatus(
        ORG,
        CALLER_USER,
        TARGET_USER,
        { status: 'active' },
        req,
      );

      expect(view.status).toBe('active');
    });

    it('404s when the userId does not belong to the caller organization (RN-01)', async () => {
      repo.findMembershipInOrg.mockResolvedValue(null);

      await expect(
        service.updateMemberStatus(ORG, CALLER_USER, TARGET_USER, { status: 'disabled' }, req),
      ).rejects.toMatchObject({ status: 404 });
      expect(repo.updateMemberStatusInOrg).not.toHaveBeenCalled();
    });

    it('403s when the caller tries to change their own status', async () => {
      await expect(
        service.updateMemberStatus(ORG, CALLER_USER, CALLER_USER, { status: 'disabled' }, req),
      ).rejects.toMatchObject({ status: 403 });
      expect(repo.updateMemberStatusInOrg).not.toHaveBeenCalled();
    });

    it('409s when disabling the last active owner', async () => {
      repo.findMembershipInOrg.mockResolvedValue(
        makeMembership({ role: 'owner', status: 'active' }),
      );
      repo.countActiveOwners.mockResolvedValue(0);

      await expect(
        service.updateMemberStatus(ORG, CALLER_USER, TARGET_USER, { status: 'disabled' }, req),
      ).rejects.toMatchObject({ status: 409 });
      expect(repo.updateMemberStatusInOrg).not.toHaveBeenCalled();
    });

    it('allows disabling an owner when another active owner remains', async () => {
      repo.findMembershipInOrg.mockResolvedValue(
        makeMembership({ role: 'owner', status: 'active' }),
      );
      repo.countActiveOwners.mockResolvedValue(1);

      const view = await service.updateMemberStatus(
        ORG,
        CALLER_USER,
        TARGET_USER,
        { status: 'disabled' },
        req,
      );

      expect(view.status).toBe('disabled');
    });

    it('records an org.member_status_updated audit intent', async () => {
      await service.updateMemberStatus(ORG, CALLER_USER, TARGET_USER, { status: 'disabled' }, req);

      const drafts = drainAuditDrafts(req);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        action: 'org.member_status_updated',
        entity: 'memberships',
        entityId: TARGET_USER,
        before: { status: 'active' },
        after: { status: 'disabled' },
      });
    });
  });

  describe('removeMember', () => {
    it('soft-deletes a member', async () => {
      await service.removeMember(ORG, CALLER_USER, TARGET_USER, req);

      expect(repo.softDeleteMembershipInOrg).toHaveBeenCalledWith(ORG, TARGET_USER);
    });

    it('404s when the userId does not belong to the caller organization (RN-01)', async () => {
      repo.findMembershipInOrg.mockResolvedValue(null);

      await expect(service.removeMember(ORG, CALLER_USER, TARGET_USER, req)).rejects.toMatchObject({
        status: 404,
      });
      expect(repo.softDeleteMembershipInOrg).not.toHaveBeenCalled();
    });

    it('403s when the caller tries to remove themselves', async () => {
      await expect(service.removeMember(ORG, CALLER_USER, CALLER_USER, req)).rejects.toMatchObject({
        status: 403,
      });
      expect(repo.softDeleteMembershipInOrg).not.toHaveBeenCalled();
    });

    it('409s when removing the last active owner', async () => {
      repo.findMembershipInOrg.mockResolvedValue(
        makeMembership({ role: 'owner', status: 'active' }),
      );
      repo.countActiveOwners.mockResolvedValue(0);

      await expect(service.removeMember(ORG, CALLER_USER, TARGET_USER, req)).rejects.toMatchObject({
        status: 409,
      });
      expect(repo.softDeleteMembershipInOrg).not.toHaveBeenCalled();
    });

    it('allows removing a non-owner even if they are the only member left', async () => {
      repo.countActiveOwners.mockResolvedValue(1);

      await service.removeMember(ORG, CALLER_USER, TARGET_USER, req);

      expect(repo.softDeleteMembershipInOrg).toHaveBeenCalledWith(ORG, TARGET_USER);
    });

    it('records an org.member_removed audit intent', async () => {
      await service.removeMember(ORG, CALLER_USER, TARGET_USER, req);

      const drafts = drainAuditDrafts(req);
      expect(drafts).toHaveLength(1);
      expect(drafts[0]).toMatchObject({
        action: 'org.member_removed',
        entity: 'memberships',
        entityId: TARGET_USER,
        after: null,
      });
    });
  });
});
