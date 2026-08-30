import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameRow } from '../../infra/database/schema/games';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import { GamesService } from './games.service';
import type { GamesRepository } from './games.repository';

const ORG = '01920000-0000-7000-8000-0000000000a1';

function makeRow(overrides: Partial<GameRow> = {}): GameRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: '01920000-0000-7000-8000-0000000000d1',
    organizationId: ORG,
    title: 'Nebula Drift',
    slug: 'nebula-drift',
    description: null,
    genre: null,
    platform: null,
    status: 'draft',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

describe('GamesService', () => {
  let repo: {
    listInOrg: ReturnType<typeof vi.fn>;
    getByIdInOrgOrThrow: ReturnType<typeof vi.fn>;
    findBySlugInOrg: ReturnType<typeof vi.fn>;
    createInOrg: ReturnType<typeof vi.fn>;
    updateByIdInOrg: ReturnType<typeof vi.fn>;
    softDeleteByIdInOrg: ReturnType<typeof vi.fn>;
  };
  let service: GamesService;
  let req: Request;

  beforeEach(() => {
    repo = {
      listInOrg: vi.fn(),
      getByIdInOrgOrThrow: vi.fn(),
      findBySlugInOrg: vi.fn(),
      createInOrg: vi.fn(),
      updateByIdInOrg: vi.fn(),
      softDeleteByIdInOrg: vi.fn(),
    };
    service = new GamesService(repo as unknown as GamesRepository);
    req = {} as Request;
  });

  it('derives a kebab-case slug from the title when none is given', async () => {
    repo.findBySlugInOrg.mockResolvedValue(null);
    repo.createInOrg.mockImplementation((_org: string, values: Partial<GameRow>) =>
      Promise.resolve(makeRow({ ...values, id: 'x' } as Partial<GameRow>)),
    );

    await service.create(ORG, { title: 'Hollow Keep II' }, req);

    expect(repo.createInOrg).toHaveBeenCalledWith(
      ORG,
      expect.objectContaining({ slug: 'hollow-keep-ii' }),
    );
  });

  it('rejects a duplicate slug with a conflict', async () => {
    repo.findBySlugInOrg.mockResolvedValue(makeRow());
    await expect(service.create(ORG, { title: 'Nebula Drift' }, req)).rejects.toMatchObject({
      status: 409,
    });
    expect(repo.createInOrg).not.toHaveBeenCalled();
  });

  it('records a game.created audit intent on creation (Tela 20)', async () => {
    repo.findBySlugInOrg.mockResolvedValue(null);
    repo.createInOrg.mockResolvedValue(makeRow({ id: 'new-id', slug: 'aurora' }));

    await service.create(ORG, { title: 'Aurora', slug: 'aurora' }, req);

    const drafts = drainAuditDrafts(req);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      action: 'game.created',
      entity: 'games',
      entityId: 'new-id',
    });
  });

  it('propagates the repository 404 for a missing game', async () => {
    repo.getByIdInOrgOrThrow.mockRejectedValue(Object.assign(new Error('nf'), { status: 404 }));
    await expect(service.get(ORG, 'missing')).rejects.toMatchObject({ status: 404 });
  });

  it('maps a row to the public view with ISO timestamps', async () => {
    repo.getByIdInOrgOrThrow.mockResolvedValue(makeRow());
    const view = await service.get(ORG, 'id');
    expect(view.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(view).not.toHaveProperty('deletedAt');
  });
});
