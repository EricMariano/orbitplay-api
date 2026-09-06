import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import { NOTIFICATION_PORT, type NotificationPort } from '../../shared/ports/notification.port';
import { Role, type RoleValue } from '../../shared/auth/roles';
import { PasswordService } from '../auth/password.service';
import type { OrganizationRow } from '../../infra/database/schema/organizations';
import type { InviteMemberInput, MemberView, OrgView, UpdateOrgInput } from './dto/org.dto';
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

    const updated = await this.repo.updateById(organizationId, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
    });

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
}

function toOrgView(org: OrganizationRow): OrgView {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    createdAt: org.createdAt.toISOString(),
  };
}
