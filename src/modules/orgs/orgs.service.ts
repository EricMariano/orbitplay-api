import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import { NOTIFICATION_PORT, type NotificationPort } from '../../shared/ports/notification.port';
import { Role, type RoleValue } from '../../shared/auth/roles';
import { PasswordService } from '../auth/password.service';
import type {
  InviteMemberInput,
  MemberView,
  OrgView,
  UpdateMemberStatusInput,
} from './dto/org.dto';
import { MemberAlreadyExistsError, OrgsRepository } from './orgs.repository';

@Injectable()
export class OrgsService {
  constructor(
    private readonly repo: OrgsRepository,
    private readonly password: PasswordService,
    private readonly config: ConfigService,
    @Inject(NOTIFICATION_PORT) private readonly mail: NotificationPort,
  ) {}

  async getCurrent(organizationId: string): Promise<OrgView> {
    const org = await this.repo.findById(organizationId);
    if (!org) throw AppException.notFound('Organização não encontrada');
    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      createdAt: org.createdAt.toISOString(),
    };
  }

  async listMembers(organizationId: string): Promise<{ data: MemberView[] }> {
    const members = await this.repo.listMembers(organizationId);
    return {
      data: members.map((m) => ({
        userId: m.userId,
        email: m.email,
        displayName: m.displayName,
        role: m.role as MemberView['role'],
        status: m.status as MemberView['status'],
      })),
    };
  }

  /**
   * Invite a member (ORB-M2-03, Tela 20): creates the `invited` membership and
   * sends the invitation e-mail. No password is set here — the invitee defines
   * theirs through the recovery flow, so an admin never knows it (RN-04).
   */
  async inviteMember(
    organizationId: string,
    callerRole: RoleValue,
    dto: InviteMemberInput,
    req: Request,
  ): Promise<MemberView> {
    // Granting `owner` is the Owner's alone: an admin could otherwise invite an
    // address they control as owner, and activating that membership later
    // (M2-05) would hand them the organization.
    if (dto.role === Role.OWNER && callerRole !== Role.OWNER) {
      throw AppException.forbidden('Somente owners podem convidar owners');
    }

    const org = await this.repo.findById(organizationId);
    if (!org) throw AppException.notFound('Organização não encontrada');

    const email = dto.email.toLowerCase().trim();
    // users.display_name is NOT NULL while the contract leaves displayName
    // optional — fall back to the address so the list never shows a blank name.
    const displayName = dto.displayName ?? email;

    // The invitee has no password yet. Store the hash of random bytes nobody
    // holds: login then fails on its own, with no change to the login path.
    const passwordHash = await this.password.hash(randomBytes(32).toString('base64url'));

    let created;
    try {
      created = await this.repo.createInvitedMember({
        organizationId,
        email,
        displayName,
        role: dto.role,
        passwordHash,
      });
    } catch (err) {
      if (err instanceof MemberAlreadyExistsError) {
        throw AppException.conflict(err.message);
      }
      throw err;
    }

    recordAudit(req, {
      action: 'org.member_invited',
      entity: 'memberships',
      entityId: created.userId,
      before: null,
      after: created,
    });

    const origin = this.config.get<string>('web.origin')!;
    await this.mail.sendEmail({
      to: created.email,
      subject: `Convite para ${org.name} — OrbitPlay`,
      text: [
        `Você foi convidado para a organização ${org.name} no OrbitPlay.`,
        '',
        `Acesse ${origin} e use a opção "Esqueci minha senha" com este e-mail`,
        'para definir sua senha e ativar o acesso.',
      ].join('\n'),
    });

    return created;
  }

  /**
   * Update a member's status (ORB-M2-05, Tela 20). Only owner/admin may call
   * this (enforced by @Roles at the controller). Two extra guards beyond the
   * schema's active/disabled restriction:
   *  - a caller can never change their OWN status (no accidental self-lockout);
   *  - the organization can never end up with zero active owners.
   * Cross-org `userId` and unknown `userId` both surface as 404 from the
   * repository (RN-01) — this method never inspects organizationId itself.
   */
  async updateMemberStatus(
    organizationId: string,
    callerUserId: string,
    targetUserId: string,
    dto: UpdateMemberStatusInput,
    req: Request,
  ): Promise<MemberView> {
    if (targetUserId === callerUserId) {
      throw AppException.forbidden('Você não pode alterar o status da sua própria membership');
    }

    const before = await this.repo.findMembershipInOrg(organizationId, targetUserId);
    if (!before) throw AppException.notFound();

    if (dto.status === 'disabled' && before.role === Role.OWNER && before.status === 'active') {
      const remainingOwners = await this.repo.countActiveOwners(organizationId, targetUserId);
      if (remainingOwners === 0) {
        throw AppException.conflict('A organização precisa de ao menos um owner ativo');
      }
    }

    await this.repo.updateMemberStatusInOrg(organizationId, targetUserId, dto.status);

    const after: MemberView = {
      userId: before.userId,
      email: before.email,
      displayName: before.displayName,
      role: before.role,
      status: dto.status,
    };

    recordAudit(req, {
      action: 'org.member_status_updated',
      entity: 'memberships',
      entityId: targetUserId,
      before: { status: before.status },
      after: { status: after.status },
    });

    return after;
  }

  /**
   * Remove (revoke) a member from the organization (ORB-M2-05, Tela 20).
   * Soft-delete — `memberships.deletedAt` — consistent with how every other
   * domain table in this project handles deletion (e.g. games.remove),
   * preserving history for the audit trail instead of losing the row.
   * Same self-protection and last-owner guards as updateMemberStatus.
   */
  async removeMember(
    organizationId: string,
    callerUserId: string,
    targetUserId: string,
    req: Request,
  ): Promise<void> {
    if (targetUserId === callerUserId) {
      throw AppException.forbidden('Você não pode remover sua própria membership');
    }

    const before = await this.repo.findMembershipInOrg(organizationId, targetUserId);
    if (!before) throw AppException.notFound();

    if (before.role === Role.OWNER && before.status === 'active') {
      const remainingOwners = await this.repo.countActiveOwners(organizationId, targetUserId);
      if (remainingOwners === 0) {
        throw AppException.conflict('A organização precisa de ao menos um owner ativo');
      }
    }

    await this.repo.softDeleteMembershipInOrg(organizationId, targetUserId);

    recordAudit(req, {
      action: 'org.member_removed',
      entity: 'memberships',
      entityId: targetUserId,
      before: { status: before.status, role: before.role },
      after: null,
    });
  }
}
