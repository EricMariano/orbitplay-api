import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { GameAccessRow } from '../../infra/database/schema/game-access';
import { recordAudit } from '../../shared/audit/audit-context';
import { STUDIO_ROLES } from '../../shared/auth/roles';
import { AppException } from '../../shared/errors/app.exception';
import { GamesService } from '../games/games.service';
import type { MemberView } from '../orgs/dto/org.dto';
import { OrgsService } from '../orgs/orgs.service';
import { AccessRepository, type GroupRecord } from './access.repository';
import type {
  CreateGroupInput,
  GameAccessEntryView,
  GameAccessListView,
  GroupView,
  SetGameAccessInput,
  UpdateGroupInput,
} from './dto/access.dto';

/**
 * Grupos de membros e permissões por jogo (Tela 04 — "Responsáveis e
 * permissões"). Os dados são persistidos e lidos aqui; os demais módulos ainda
 * não consultam estas permissões (ver DECISIONS.md).
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly repo: AccessRepository,
    private readonly orgs: OrgsService,
    private readonly games: GamesService,
  ) {}

  async listGroups(organizationId: string): Promise<{ data: GroupView[] }> {
    const groups = await this.repo.listGroups(organizationId);
    return { data: groups.map(toGroupView) };
  }

  async createGroup(
    organizationId: string,
    dto: CreateGroupInput,
    req: Request,
  ): Promise<GroupView> {
    const memberUserIds = unique(dto.memberUserIds);
    await this.assertEligibleMembers(organizationId, memberUserIds, 'memberUserIds');
    await this.assertNameFree(organizationId, dto.name);

    const group = await this.repo.createGroup(organizationId, dto.name, memberUserIds);
    const view = toGroupView(group);
    recordAudit(req, {
      action: 'org.group.created',
      entity: 'org_groups',
      entityId: group.id,
      before: null,
      after: view,
    });
    return view;
  }

  async updateGroup(
    organizationId: string,
    id: string,
    dto: UpdateGroupInput,
    req: Request,
  ): Promise<GroupView> {
    const [before] = await this.repo.findGroupsByIds(organizationId, [id]);
    if (!before) throw AppException.notFound('Grupo não encontrado');

    const memberUserIds = dto.memberUserIds ? unique(dto.memberUserIds) : undefined;
    if (memberUserIds)
      await this.assertEligibleMembers(organizationId, memberUserIds, 'memberUserIds');
    if (dto.name !== undefined && dto.name !== before.name) {
      await this.assertNameFree(organizationId, dto.name);
    }

    const updated = await this.repo.updateGroup(organizationId, id, {
      name: dto.name,
      memberUserIds,
    });
    const view = toGroupView(updated);
    recordAudit(req, {
      action: 'org.group.updated',
      entity: 'org_groups',
      entityId: id,
      before: toGroupView(before),
      after: view,
    });
    return view;
  }

  async removeGroup(organizationId: string, id: string, req: Request): Promise<void> {
    const [before] = await this.repo.findGroupsByIds(organizationId, [id]);
    if (!before) throw AppException.notFound('Grupo não encontrado');
    await this.repo.softDeleteGroup(organizationId, id);
    recordAudit(req, {
      action: 'org.group.deleted',
      entity: 'org_groups',
      entityId: id,
      before: toGroupView(before),
      after: null,
    });
  }

  async getGameAccess(organizationId: string, gameId: string): Promise<GameAccessListView> {
    await this.assertGameInOrg(organizationId, gameId);
    return this.toList(organizationId, await this.repo.listGameAccess(organizationId, gameId));
  }

  async setGameAccess(
    organizationId: string,
    gameId: string,
    dto: SetGameAccessInput,
    req: Request,
  ): Promise<GameAccessListView> {
    await this.assertGameInOrg(organizationId, gameId);

    const keys = dto.entries.map((e) => `${e.subjectType}:${e.subjectId}`);
    if (new Set(keys).size !== keys.length) {
      throw AppException.validation('Destinatário repetido', {
        entries: 'Cada grupo ou membro pode aparecer uma única vez',
      });
    }
    const groupIds = dto.entries.filter((e) => e.subjectType === 'group').map((e) => e.subjectId);
    const userIds = dto.entries.filter((e) => e.subjectType === 'member').map((e) => e.subjectId);

    const groups = await this.repo.findGroupsByIds(organizationId, groupIds);
    if (groups.length !== groupIds.length) {
      throw AppException.validation('Grupo inexistente', {
        entries: 'Um dos grupos não existe nesta organização',
      });
    }
    await this.assertEligibleMembers(organizationId, userIds, 'entries');

    const before = await this.getGameAccess(organizationId, gameId);
    await this.repo.replaceGameAccess(
      organizationId,
      gameId,
      dto.entries.map((entry) => ({
        groupId: entry.subjectType === 'group' ? entry.subjectId : null,
        userId: entry.subjectType === 'member' ? entry.subjectId : null,
        canManageAccess: entry.permissions.manageAccess,
        canEditInfo: entry.permissions.editInfo,
        canManageTests: entry.permissions.manageTests,
        canViewReports: entry.permissions.viewReports,
      })),
    );
    const after = await this.getGameAccess(organizationId, gameId);

    recordAudit(req, {
      action: 'game.access.updated',
      entity: 'game_access',
      entityId: gameId,
      before,
      after,
    });
    return after;
  }

  private async assertGameInOrg(organizationId: string, gameId: string): Promise<void> {
    if (!(await this.games.existsInOrg(organizationId, gameId))) throw AppException.notFound();
  }

  private async assertNameFree(organizationId: string, name: string): Promise<void> {
    if (await this.repo.findGroupByName(organizationId, name)) {
      throw AppException.conflict(`Já existe um grupo chamado "${name}"`);
    }
  }

  /** Membros precisam existir na org, não estar desativados e ter papel de estúdio. */
  private async assertEligibleMembers(
    organizationId: string,
    userIds: string[],
    field: string,
  ): Promise<MemberView[]> {
    if (userIds.length === 0) return [];
    const members = await this.orgs.findMembersByIds(organizationId, userIds);
    const eligible = members.filter(
      (m) => m.status !== 'disabled' && STUDIO_ROLES.includes(m.role),
    );
    if (eligible.length !== userIds.length) {
      throw AppException.validation('Membro inválido', {
        [field]: 'Todos os membros devem ser da organização, ativos e de papel de estúdio',
      });
    }
    return eligible;
  }

  private async toList(organizationId: string, rows: GameAccessRow[]): Promise<GameAccessListView> {
    const groupIds = rows.flatMap((r) => (r.groupId ? [r.groupId] : []));
    const userIds = rows.flatMap((r) => (r.userId ? [r.userId] : []));
    const [groups, members] = await Promise.all([
      this.repo.findGroupsByIds(organizationId, groupIds),
      this.orgs.findMembersByIds(organizationId, userIds),
    ]);
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const memberById = new Map(members.map((m) => [m.userId, m]));

    const data: GameAccessEntryView[] = [];
    for (const row of rows) {
      const permissions = {
        manageAccess: row.canManageAccess,
        editInfo: row.canEditInfo,
        manageTests: row.canManageTests,
        viewReports: row.canViewReports,
      };
      const group = row.groupId ? groupById.get(row.groupId) : undefined;
      const member = row.userId ? memberById.get(row.userId) : undefined;
      if (group) {
        data.push({
          subjectType: 'group',
          subjectId: group.id,
          name: group.name,
          email: null,
          memberCount: group.memberUserIds.length,
          permissions,
        });
      } else if (member) {
        data.push({
          subjectType: 'member',
          subjectId: member.userId,
          name: member.displayName,
          email: member.email,
          memberCount: null,
          permissions,
        });
      }
    }
    return { data };
  }
}

function toGroupView(group: GroupRecord): GroupView {
  return {
    id: group.id,
    name: group.name,
    memberCount: group.memberUserIds.length,
    memberUserIds: group.memberUserIds,
    createdAt: group.createdAt.toISOString(),
  };
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}
