import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import { NOTIFICATION_PORT, type NotificationPort } from '../../shared/ports/notification.port';
import { Role, type RoleValue } from '../../shared/auth/roles';
import type { Page } from '../../shared/pagination/pagination';
import { PasswordService } from '../auth/password.service';
import type { InviteMemberInput, MemberListQuery, MemberView, OrgView } from './dto/org.dto';
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
}
