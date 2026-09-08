import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { GameAssetRow } from '../../infra/database/schema/game-assets';
import type { GameRow } from '../../infra/database/schema/games';
import { newId } from '../../infra/database/schema/_helpers';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import type { Page } from '../../shared/pagination/pagination';
import { STORAGE_PORT, type StoragePort } from '../../shared/ports/storage.port';
import { slugify } from '../../shared/util/slugify';
import {
  ASSET_UPLOAD_TTL_SECONDS,
  EMPTY_GAME_METRICS,
  MAX_GAME_ASSET_BYTES,
  type AssetKind,
  type AssetUploadUrlRequest,
  type ConfirmAssetRequest,
  type CreateGameDto,
  type GameAssetView,
  type GameListQuery,
  type GameMetricsView,
  type GameView,
  type UpdateGameDto,
  type UploadUrlResponse,
} from './dto/game.dto';
import { GamesRepository } from './games.repository';

const ASSET_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

const ALLOWED_CONTENT_TYPES = new Set(Object.keys(ASSET_EXT));

@Injectable()
export class GamesService {
  constructor(
    private readonly repo: GamesRepository,
    @Inject(STORAGE_PORT) private readonly storage: StoragePort,
  ) {}

  async list(organizationId: string, query: GameListQuery): Promise<Page<GameView>> {
    const page = await this.repo.listFilteredInOrg(organizationId, query);
    const views = await this.toViews(organizationId, page.data);
    return { data: views, nextCursor: page.nextCursor };
  }

  async get(organizationId: string, id: string): Promise<GameView> {
    const row = await this.repo.getByIdInOrgOrThrow(organizationId, id);
    const [view] = await this.toViews(organizationId, [row]);
    return view;
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

    const view = toView(row, null, null, { ...EMPTY_GAME_METRICS });
    recordAudit(req, {
      action: 'game.created',
      entity: 'games',
      entityId: row.id,
      before: null,
      after: view,
    });
    return view;
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

    const [beforeView, afterView] = await Promise.all([
      this.toViews(organizationId, [before]),
      this.toViews(organizationId, [updated]),
    ]);

    recordAudit(req, {
      action: 'game.updated',
      entity: 'games',
      entityId: id,
      before: beforeView[0],
      after: afterView[0],
    });
    return afterView[0];
  }

  async remove(organizationId: string, id: string, req: Request): Promise<void> {
    const before = await this.repo.getByIdInOrgOrThrow(organizationId, id);
    await this.repo.softDeleteByIdInOrg(organizationId, id);
    const [beforeView] = await this.toViews(organizationId, [before]);
    recordAudit(req, {
      action: 'game.deleted',
      entity: 'games',
      entityId: id,
      before: beforeView,
      after: null,
    });
  }

  /**
   * RN-05 (Tela 04): validate type/size, then hand the client a presigned PUT.
   * The API never proxies the bytes.
   */
  async createAssetUploadUrl(
    organizationId: string,
    gameId: string,
    dto: AssetUploadUrlRequest,
  ): Promise<UploadUrlResponse> {
    await this.repo.getByIdInOrgOrThrow(organizationId, gameId);

    const ext = ASSET_EXT[dto.contentType];
    const assetId = newId();
    const storageKey = buildAssetStorageKey(organizationId, gameId, dto.kind, assetId, ext);
    const uploadUrl = await this.storage.createUploadUrl(
      storageKey,
      dto.contentType,
      ASSET_UPLOAD_TTL_SECONDS,
    );

    return {
      uploadUrl,
      storageKey,
      expiresAt: new Date(Date.now() + ASSET_UPLOAD_TTL_SECONDS * 1000).toISOString(),
      maxSizeBytes: MAX_GAME_ASSET_BYTES,
    };
  }

  /**
   * Confirm only after the object is actually in storage. A failed PUT must
   * not create a `game_assets` row.
   */
  async confirmAsset(
    organizationId: string,
    gameId: string,
    dto: ConfirmAssetRequest,
  ): Promise<GameAssetView> {
    await this.repo.getByIdInOrgOrThrow(organizationId, gameId);

    if (!storageKeyBelongsToGame(dto.storageKey, organizationId, gameId, dto.kind)) {
      throw AppException.validation('storageKey não pertence a este jogo', {
        storageKey: 'Chave de storage inválida para este jogo',
      });
    }

    const already = await this.repo.findAssetByStorageKeyInOrg(organizationId, dto.storageKey);
    if (already && already.gameId === gameId) {
      return this.toAssetView(already);
    }

    const meta = await this.storage.stat(dto.storageKey);
    if (!meta) {
      throw AppException.validation('Objeto ausente no storage', {
        storageKey: 'Upload não encontrado — envie o arquivo antes de confirmar',
      });
    }
    if (meta.contentType && !ALLOWED_CONTENT_TYPES.has(meta.contentType)) {
      throw AppException.validation('Formato de imagem inválido', {
        contentType: 'Use PNG, JPEG ou WebP',
      });
    }
    if (meta.sizeBytes < 1 || meta.sizeBytes > MAX_GAME_ASSET_BYTES) {
      throw AppException.validation('Tamanho de imagem inválido', {
        sizeBytes: `Tamanho deve ficar entre 1 e ${MAX_GAME_ASSET_BYTES} bytes`,
      });
    }

    const row = await this.repo.createAssetInOrg(organizationId, {
      gameId,
      kind: dto.kind,
      storageKey: dto.storageKey,
      contentType: meta.contentType ?? contentTypeFromKey(dto.storageKey),
      sizeBytes: meta.sizeBytes,
    });

    const retired = await this.repo.retirePreviousUniqueAssets(
      organizationId,
      gameId,
      dto.kind,
      row.id,
    );
    await Promise.all(
      retired.map((old) => this.storage.remove(old.storageKey).catch(() => undefined)),
    );

    return this.toAssetView(row);
  }

  async removeAsset(organizationId: string, gameId: string, assetId: string): Promise<void> {
    await this.repo.getByIdInOrgOrThrow(organizationId, gameId);
    const existing = await this.repo.findAssetByIdInOrg(organizationId, gameId, assetId);
    if (!existing) throw AppException.notFound();

    const deleted = await this.repo.softDeleteAssetInOrg(organizationId, gameId, assetId);
    await this.storage.remove(deleted.storageKey).catch(() => undefined);
  }

  private async toViews(organizationId: string, rows: GameRow[]): Promise<GameView[]> {
    const ids = rows.map((r) => r.id);
    const [metrics, assets] = await Promise.all([
      this.repo.metricsByGameIds(organizationId, ids),
      this.repo.findCoverAndBannerByGameIds(organizationId, ids),
    ]);

    return Promise.all(
      rows.map(async (row) => {
        const pair = assets.get(row.id) ?? { cover: null, banner: null };
        const [coverUrl, bannerUrl] = await Promise.all([
          this.signedOrNull(pair.cover),
          this.signedOrNull(pair.banner),
        ]);
        return toView(row, coverUrl, bannerUrl, metrics.get(row.id) ?? { ...EMPTY_GAME_METRICS });
      }),
    );
  }

  private async toAssetView(row: GameAssetRow): Promise<GameAssetView> {
    const url = await this.storage.createDownloadUrl(row.storageKey);
    return {
      id: row.id,
      kind: row.kind,
      url,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async signedOrNull(asset: GameAssetRow | null): Promise<string | null> {
    if (!asset) return null;
    try {
      return await this.storage.createDownloadUrl(asset.storageKey);
    } catch {
      return null;
    }
  }
}

function toView(
  row: GameRow,
  coverUrl: string | null,
  bannerUrl: string | null,
  metrics: GameMetricsView,
): GameView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    title: row.title,
    slug: row.slug,
    description: row.description,
    genre: row.genre,
    platform: row.platform,
    status: row.status,
    coverUrl,
    bannerUrl,
    metrics,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function buildAssetStorageKey(
  organizationId: string,
  gameId: string,
  kind: AssetKind,
  assetId: string,
  ext: string,
): string {
  return `orgs/${organizationId}/games/${gameId}/assets/${kind}/${assetId}.${ext}`;
}

const STORAGE_KEY_RE =
  /^orgs\/([0-9a-f-]{36})\/games\/([0-9a-f-]{36})\/assets\/(cover|banner|screenshot)\/([0-9a-f-]{36})\.(png|jpg|webp)$/i;

function storageKeyBelongsToGame(
  storageKey: string,
  organizationId: string,
  gameId: string,
  kind: AssetKind,
): boolean {
  const match = storageKey.match(STORAGE_KEY_RE);
  if (!match) return false;
  return match[1] === organizationId && match[2] === gameId && match[3] === kind;
}

function contentTypeFromKey(storageKey: string): string | null {
  if (storageKey.endsWith('.png')) return 'image/png';
  if (storageKey.endsWith('.jpg') || storageKey.endsWith('.jpeg')) return 'image/jpeg';
  if (storageKey.endsWith('.webp')) return 'image/webp';
  return null;
}
