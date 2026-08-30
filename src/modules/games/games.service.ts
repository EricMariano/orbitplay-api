import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { GameRow } from '../../infra/database/schema/games';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import type { Page, PaginationQuery } from '../../shared/pagination/pagination';
import type { CreateGameDto, GameView, UpdateGameDto } from './dto/game.dto';
import { GamesRepository } from './games.repository';

@Injectable()
export class GamesService {
  constructor(private readonly repo: GamesRepository) {}

  async list(organizationId: string, query: PaginationQuery): Promise<Page<GameView>> {
    const page = await this.repo.listInOrg(organizationId, query);
    return { data: page.data.map(toView), nextCursor: page.nextCursor };
  }

  async get(organizationId: string, id: string): Promise<GameView> {
    const row = await this.repo.getByIdInOrgOrThrow(organizationId, id);
    return toView(row);
  }

  async create(organizationId: string, dto: CreateGameDto, req: Request): Promise<GameView> {
    const slug = dto.slug ?? slugify(dto.title);
    const existing = await this.repo.findBySlugInOrg(organizationId, slug);
    if (existing) {
      throw AppException.conflict(`Já existe um jogo com o slug "${slug}"`);
    }

    const row = await this.repo.createInOrg(organizationId, {
      title: dto.title,
      slug,
      description: dto.description ?? null,
      genre: dto.genre ?? null,
      platform: dto.platform ?? null,
      status: dto.status ?? 'draft',
    });

    recordAudit(req, {
      action: 'game.created',
      entity: 'games',
      entityId: row.id,
      before: null,
      after: toView(row),
    });
    return toView(row);
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpdateGameDto,
    req: Request,
  ): Promise<GameView> {
    const before = await this.repo.getByIdInOrgOrThrow(organizationId, id);

    if (dto.slug && dto.slug !== before.slug) {
      const clash = await this.repo.findBySlugInOrg(organizationId, dto.slug);
      if (clash && clash.id !== id) {
        throw AppException.conflict(`Já existe um jogo com o slug "${dto.slug}"`);
      }
    }

    const updated = await this.repo.updateByIdInOrg(organizationId, id, {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
      ...(dto.description !== undefined ? { description: dto.description } : {}),
      ...(dto.genre !== undefined ? { genre: dto.genre } : {}),
      ...(dto.platform !== undefined ? { platform: dto.platform } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
    });

    recordAudit(req, {
      action: 'game.updated',
      entity: 'games',
      entityId: id,
      before: toView(before),
      after: toView(updated),
    });
    return toView(updated);
  }

  async remove(organizationId: string, id: string, req: Request): Promise<void> {
    const before = await this.repo.getByIdInOrgOrThrow(organizationId, id);
    await this.repo.softDeleteByIdInOrg(organizationId, id);
    recordAudit(req, {
      action: 'game.deleted',
      entity: 'games',
      entityId: id,
      before: toView(before),
      after: null,
    });
  }
}

function toView(row: GameRow): GameView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    slug: row.slug,
    description: row.description,
    genre: row.genre,
    platform: row.platform,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function slugify(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 200);
}
