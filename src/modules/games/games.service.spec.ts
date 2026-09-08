import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameAssetRow } from '../../infra/database/schema/game-assets';
import type { GameRow } from '../../infra/database/schema/games';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import type { StoragePort } from '../../shared/ports/storage.port';
import { EMPTY_GAME_METRICS, MAX_GAME_ASSET_BYTES } from './dto/game.dto';
import { GamesService } from './games.service';
import type { GamesRepository } from './games.repository';

const ORG = '01920000-0000-7000-8000-0000000000a1';
const GAME_ID = '01920000-0000-7000-8000-0000000000d1';

function makeRow(overrides: Partial<GameRow> = {}): GameRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: GAME_ID,
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

function makeAsset(overrides: Partial<GameAssetRow> = {}): GameAssetRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: '01920000-0000-7000-8000-0000000000aa',
    organizationId: ORG,
    gameId: GAME_ID,
    kind: 'cover',
    storageKey: `orgs/${ORG}/games/${GAME_ID}/assets/cover/01920000-0000-7000-8000-0000000000aa.png`,
    contentType: 'image/png',
    sizeBytes: 128,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

describe('GamesService', () => {
  let repo: {
    listInOrg: ReturnType<typeof vi.fn>;
    listFilteredInOrg: ReturnType<typeof vi.fn>;
    getByIdInOrgOrThrow: ReturnType<typeof vi.fn>;
    findBySlugInOrg: ReturnType<typeof vi.fn>;
    createInOrg: ReturnType<typeof vi.fn>;
    updateByIdInOrg: ReturnType<typeof vi.fn>;
    softDeleteByIdInOrg: ReturnType<typeof vi.fn>;
    metricsByGameIds: ReturnType<typeof vi.fn>;
    findCoverAndBannerByGameIds: ReturnType<typeof vi.fn>;
    findAssetByStorageKeyInOrg: ReturnType<typeof vi.fn>;
    findAssetByIdInOrg: ReturnType<typeof vi.fn>;
    createAssetInOrg: ReturnType<typeof vi.fn>;
    retirePreviousUniqueAssets: ReturnType<typeof vi.fn>;
    softDeleteAssetInOrg: ReturnType<typeof vi.fn>;
  };
  let storage: {
    createUploadUrl: ReturnType<typeof vi.fn>;
    createDownloadUrl: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    healthCheck: ReturnType<typeof vi.fn>;
  };
  let service: GamesService;
  let req: Request;

  beforeEach(() => {
    repo = {
      listInOrg: vi.fn(),
      listFilteredInOrg: vi.fn(),
      getByIdInOrgOrThrow: vi.fn(),
      findBySlugInOrg: vi.fn(),
      createInOrg: vi.fn(),
      updateByIdInOrg: vi.fn(),
      softDeleteByIdInOrg: vi.fn(),
      metricsByGameIds: vi.fn().mockResolvedValue(new Map([[GAME_ID, { ...EMPTY_GAME_METRICS }]])),
      findCoverAndBannerByGameIds: vi
        .fn()
        .mockResolvedValue(new Map([[GAME_ID, { cover: null, banner: null }]])),
      findAssetByStorageKeyInOrg: vi.fn().mockResolvedValue(null),
      findAssetByIdInOrg: vi.fn(),
      createAssetInOrg: vi.fn(),
      retirePreviousUniqueAssets: vi.fn().mockResolvedValue([]),
      softDeleteAssetInOrg: vi.fn(),
    };
    storage = {
      createUploadUrl: vi.fn().mockResolvedValue('https://minio.local/put'),
      createDownloadUrl: vi.fn().mockResolvedValue('https://minio.local/get'),
      exists: vi.fn(),
      stat: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn(),
    };
    service = new GamesService(
      repo as unknown as GamesRepository,
      storage as unknown as StoragePort,
    );
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

  it('maps a row to the public view with ISO timestamps, metrics and image urls', async () => {
    repo.getByIdInOrgOrThrow.mockResolvedValue(makeRow());
    const view = await service.get(ORG, 'id');
    expect(view.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(view).not.toHaveProperty('deletedAt');
    expect(view.metrics).toEqual(EMPTY_GAME_METRICS);
    expect(view.coverUrl).toBeNull();
    expect(view.bannerUrl).toBeNull();
  });

  it('forwards q and status to the filtered list', async () => {
    repo.listFilteredInOrg.mockResolvedValue({ data: [makeRow()], nextCursor: null });
    const page = await service.list(ORG, { limit: 20, q: 'nebula', status: 'active' });
    expect(repo.listFilteredInOrg).toHaveBeenCalledWith(ORG, {
      limit: 20,
      q: 'nebula',
      status: 'active',
    });
    expect(page.data[0].metrics.testsTotal).toBe(0);
  });

  it('issues a scoped storage key and never proxies the file', async () => {
    repo.getByIdInOrgOrThrow.mockResolvedValue(makeRow());
    const result = await service.createAssetUploadUrl(ORG, GAME_ID, {
      kind: 'cover',
      contentType: 'image/png',
      sizeBytes: 1024,
      fileName: 'capa.png',
    });

    expect(result.uploadUrl).toBe('https://minio.local/put');
    expect(result.maxSizeBytes).toBe(MAX_GAME_ASSET_BYTES);
    expect(result.storageKey).toMatch(
      new RegExp(`^orgs/${ORG}/games/${GAME_ID}/assets/cover/[0-9a-f-]+\\.png$`),
    );
    expect(storage.createUploadUrl).toHaveBeenCalledWith(
      result.storageKey,
      'image/png',
      expect.any(Number),
    );
  });

  it('refuses to confirm when the object is missing from storage', async () => {
    repo.getByIdInOrgOrThrow.mockResolvedValue(makeRow());
    storage.stat.mockResolvedValue(null);
    const storageKey = `orgs/${ORG}/games/${GAME_ID}/assets/cover/01920000-0000-7000-8000-0000000000aa.png`;

    await expect(
      service.confirmAsset(ORG, GAME_ID, { kind: 'cover', storageKey }),
    ).rejects.toMatchObject({ status: 422 });
    expect(repo.createAssetInOrg).not.toHaveBeenCalled();
  });

  it('refuses a storageKey that does not belong to the game', async () => {
    repo.getByIdInOrgOrThrow.mockResolvedValue(makeRow());
    await expect(
      service.confirmAsset(ORG, GAME_ID, {
        kind: 'cover',
        storageKey: 'orgs/other/games/other/assets/cover/x.png',
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(storage.stat).not.toHaveBeenCalled();
  });

  it('confirms an uploaded object and retires the previous cover', async () => {
    const asset = makeAsset();
    const previous = makeAsset({
      id: '01920000-0000-7000-8000-0000000000ab',
      storageKey: `orgs/${ORG}/games/${GAME_ID}/assets/cover/old.png`,
    });
    repo.getByIdInOrgOrThrow.mockResolvedValue(makeRow());
    storage.stat.mockResolvedValue({ contentType: 'image/png', sizeBytes: 128 });
    repo.createAssetInOrg.mockResolvedValue(asset);
    repo.retirePreviousUniqueAssets.mockResolvedValue([previous]);

    const view = await service.confirmAsset(ORG, GAME_ID, {
      kind: 'cover',
      storageKey: asset.storageKey,
    });

    expect(view.id).toBe(asset.id);
    expect(view.url).toBe('https://minio.local/get');
    expect(repo.retirePreviousUniqueAssets).toHaveBeenCalledWith(ORG, GAME_ID, 'cover', asset.id);
    expect(storage.remove).toHaveBeenCalledWith(previous.storageKey);
  });

  it('returns the existing asset when confirm is repeated', async () => {
    const asset = makeAsset();
    repo.getByIdInOrgOrThrow.mockResolvedValue(makeRow());
    repo.findAssetByStorageKeyInOrg.mockResolvedValue(asset);

    const view = await service.confirmAsset(ORG, GAME_ID, {
      kind: 'cover',
      storageKey: asset.storageKey,
    });

    expect(view.id).toBe(asset.id);
    expect(repo.createAssetInOrg).not.toHaveBeenCalled();
  });
});
