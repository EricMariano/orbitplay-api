import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import { NOTIFICATION_PORT, type NotificationPort } from '../../shared/ports/notification.port';
import { Role, type RoleValue } from '../../shared/auth/roles';
import type { Page } from '../../shared/pagination/pagination';
import { AuthService } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import type { OrganizationRow } from '../../infra/database/schema/organizations';
import type {
  ChangeRoleInput,
  ChangeStatusInput,
  InviteMemberInput,
  MemberListQuery,
  MemberView,
  OrgView,
  UpdateOrgInput,
} from './dto/org.dto';
import { LastOwnerError, MemberAlreadyExistsError, OrgsRepository } from './orgs.repository';

@Injectable()
export class OrgsService {
  constructor(
    private readonly repo: OrgsRepository,
    private readonly password: PasswordService,
    private readonly config: ConfigService,
    private readonly auth: AuthService,
    @Inject(NOTIFICATION_PORT) private readonly mail: NotificationPort,
  ) {}

  async getCurrent(organizationId: string): Promise<OrgView> {
    const org = await this.repo.findById(organizationId);
    if (!org) throw AppException.notFound('Organização não encontrada');
    return toOrgView(org);
  }

  /** ORB-M2-02 (Tela 20): owner/admin update the org's own name/slug. */
  async updateCurrent(organizationId: string, dto: UpdateOrgInput, req: Request): Promise<OrgView> {
    const before = await this.repo.findById(organizationId);
    if (!before) throw AppException.notFound('Organização não encontrada');

    if (dto.slug && dto.slug !== before.slug) {
      const clash = await this.repo.findBySlug(dto.slug);
      if (clash && clash.id !== organizationId) {
        throw AppException.conflict(`Já existe uma organização com o slug "${dto.slug}"`);
      }
    }

    const patch = {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
    };

    // Nothing to change (empty body): skip the write, an empty SET clause
    // would otherwise reach Postgres and fail.
    const updated =
      Object.keys(patch).length === 0 ? before : await this.repo.updateById(organizationId, patch);

    const beforeView = toOrgView(before);
    const afterView = toOrgView(updated);

    recordAudit(req, {
      action: 'org.updated',
      entity: 'organizations',
      entityId: organizationId,
      before: beforeView,
      after: afterView,
    });

    return afterView;
  }

  async listMembers(organizationId: string, query: MemberListQuery): Promise<Page<MemberView>> {
    const page = await this.repo.listMembers(organizationId, query);
    return {
      data: page.data.map((m) => ({
        userId: m.userId,
        email: m.email,
        displayName: m.displayName,
        role: m.role as MemberView['role'],
        status: m.status as MemberView['status'],
      })),
      nextCursor: page.nextCursor,
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
    if (dto.role === Role.OWNER && callerRole !== Role.OWNER) {
      throw AppException.forbidden('Somente owners podem convidar owners');
    }

    const org = await this.repo.findById(organizationId);
    if (!org) throw AppException.notFound('Organização não encontrada');

    const email = dto.email.toLowerCase().trim();
    const displayName = dto.displayName ?? email;

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
   * Change a member's role (ORB-M2-04, Tela 20). Owner-only: RN-01 reserves the
   * members area for the Owner, and "Admin com permissão específica" describes a
   * permission system the project does not have (see DECISIONS.md §3).
   *
   * Demoting the last active owner is refused with 409 (RN-03); the check and
   * the write share one transaction in the repository.
   */
  async changeMemberRole(
    organizationId: string,
    targetUserId: string,
    dto: ChangeRoleInput,
    req: Request,
  ): Promise<MemberView> {
    let result;
    try {
      result = await this.repo.changeMemberRole({
        organizationId,
        userId: targetUserId,
        role: dto.role,
      });
    } catch (err) {
      if (err instanceof LastOwnerError) {
        throw AppException.conflict(err.message);
      }
      throw err;
    }

    if (!result) throw AppException.notFound('Membro não encontrado');

    const view: MemberView = {
      userId: result.member.userId,
      email: result.member.email,
      displayName: result.member.displayName,
      role: result.member.role,
      status: result.member.status as MemberView['status'],
    };

    recordAudit(req, {
      action: 'org.member_role_changed',
      entity: 'memberships',
      entityId: view.userId,
      before: { role: result.previousRole },
      after: { role: view.role },
    });

    return view;
  }

  /**
   * Change a member's status (ORB-M2-05, Tela 20). Owner/admin. Two guards
   * beyond the schema's active/disabled/invited range:
   *  - a caller can never change their OWN status (no accidental
   *    self-lockout, and never a way to dodge the last-owner rule below by
   *    disabling yourself);
   *  - RN-03/RN-06: disabling the org's last active owner is refused with
   *    409 — same transactional guard as changeMemberRole, in the
   *    repository.
   */
  async changeMemberStatus(
    organizationId: string,
    callerUserId: string,
    targetUserId: string,
    dto: ChangeStatusInput,
    req: Request,
  ): Promise<MemberView> {
    if (targetUserId === callerUserId) {
      throw AppException.forbidden('Você não pode alterar o status da sua própria membership');
    }

    let result;
    try {
      result = await this.repo.changeMemberStatus({
        organizationId,
        userId: targetUserId,
        status: dto.status,
      });
    } catch (err) {
      if (err instanceof LastOwnerError) {
        throw AppException.conflict(err.message);
      }
      throw err;
    }

    if (!result) throw AppException.notFound('Membro não encontrado');

    const view: MemberView = {
      userId: result.member.userId,
      email: result.member.email,
      displayName: result.member.displayName,
      role: result.member.role,
      status: result.member.status as MemberView['status'],
    };

    recordAudit(req, {
      action: 'org.member_status_changed',
      entity: 'memberships',
      entityId: view.userId,
      before: { status: result.previousStatus },
      after: { status: view.status },
    });

    return view;
  }

  /**
   * Remove a member (ORB-M2-06, Tela 20). Owner/admin — same area as
   * status/invite, not owner-only: kept this way (deviating from the design
   * table's literal "papel: owner") because, combined with the
   * never-touch-yourself guard below, an owner-only restriction would make
   * the last-active-owner check on this route unreachable — an owner can
   * never legally be both the caller and the sole remaining owner being
   * removed. Letting an admin remove a lone owner keeps RN-03 a real,
   * testable guarantee instead of dead code.
   *
   * RN-06: always a logical deactivation, never a physical delete; RN-03:
   * refuses to remove the last active owner with 409. Self-removal is
   * refused regardless of role (no accidental self-lockout).
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

    let result;
    try {
      result = await this.repo.removeMember(organizationId, targetUserId);
    } catch (err) {
      if (err instanceof LastOwnerError) {
        throw AppException.conflict(err.message);
      }
      throw err;
    }

    if (!result) throw AppException.notFound('Membro não encontrado');

    recordAudit(req, {
      action: 'org.member_removed',
      entity: 'memberships',
      entityId: targetUserId,
      before: { status: result.previousStatus },
      after: { status: 'disabled', deletedAt: true },
    });
  }

  /**
   * Trigger a password reset e-mail for a member (ORB-M2-07, Tela 20 RN-04).
   * Owner/admin never sets or sees the password — only dispatches the same
   * recovery flow as the self-service "Esqueci minha senha".
   */
  async triggerMemberPasswordReset(
    organizationId: string,
    targetUserId: string,
    req: Request,
  ): Promise<{ message: string }> {
    const member = await this.repo.findMembership(organizationId, targetUserId);
    if (!member) throw AppException.notFound('Membro não encontrado');

    await this.auth.triggerPasswordReset(targetUserId);

    recordAudit(req, {
      action: 'org.member_password_reset_triggered',
      entity: 'users',
      entityId: targetUserId,
      before: null,
      after: null,
    });

    return { message: 'E-mail de redefinição enviado.' };
  }
}

function toOrgView(org: OrganizationRow): OrgView {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt.toISOString(),
  };
}
