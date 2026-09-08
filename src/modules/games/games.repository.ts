import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  count,
  countDistinct,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { gameReviews } from '../../infra/database/schema/community';
import {
  gameAssets,
  type GameAssetRow,
  type NewGameAssetRow,
} from '../../infra/database/schema/game-assets';
import { games, type GameRow, type NewGameRow } from '../../infra/database/schema/games';
import {
  participations,
  sessions,
  sessionValidations,
} from '../../infra/database/schema/participations';
import { tests } from '../../infra/database/schema/tests';
import { OrgScopedRepository } from '../../infra/database/base.repository';
import { AppException } from '../../shared/errors/app.exception';
import { buildPage, decodeCursor, type Page } from '../../shared/pagination/pagination';
import { isUuid } from '../../shared/util/uuid';
import type { AssetKind, GameListQuery, GameMetricsView } from './dto/game.dto';
import { EMPTY_GAME_METRICS } from './dto/game.dto';

export interface GameCoverBanner {
  cover: GameAssetRow | null;
  banner: GameAssetRow | null;
}

/**
 * Games repository. Extends OrgScopedRepository so every read/write is
 * automatically filtered by organization_id (RN-01) and cross-org access
 * yields 404. Domain-specific queries (like slug lookup) are added here and
 * still route through the org scope.
 */
@Injectable()
export class GamesRepository extends OrgScopedRepository<GameRow, NewGameRow> {
  constructor(@Inject(DRIZZLE) db: Database) {
    super(db, games);
  }

  /** Slug uniqueness check within the org (excludes soft-deleted). */
  async findBySlugInOrg(organizationId: string, slug: string): Promise<GameRow | null> {
    const rows = await this.db
      .select()
      .from(games)
      .where(
        and(
          eq(games.organizationId, organizationId),
          eq(games.slug, slug),
          isNull(games.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Cursor page with optional `q` (title/slug) and `status`. Extra filters
   * stay here — the base list has no search/status (Tela 03).
   */
  async listFilteredInOrg(organizationId: string, query: GameListQuery): Promise<Page<GameRow>> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [this.orgScope(organizationId)];
    if (cursorId) filters.push(lt(games.id, cursorId));
    if (query.status) filters.push(eq(games.status, query.status));
    const term = query.q?.trim();
    if (term) {
      const pattern = `%${escapeIlike(term)}%`;
      filters.push(or(ilike(games.title, pattern), ilike(games.slug, pattern))!);
    }

    const rows = await this.db
      .select()
      .from(games)
      .where(and(...filters))
      .orderBy(desc(games.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
  }

  /**
   * Card metrics (RN-03) for a set of games. Test-dependent numbers come from
   * existing tables; they stay at zero until M5/M8 write rows.
   */
  async metricsByGameIds(
    organizationId: string,
    gameIds: string[],
  ): Promise<Map<string, GameMetricsView>> {
    const result = new Map<string, GameMetricsView>();
    if (gameIds.length === 0) return result;
    for (const id of gameIds) result.set(id, { ...EMPTY_GAME_METRICS });

    const [testRows, sessionRows, playerRows, ratingRows] = await Promise.all([
      this.db
        .select({
          gameId: tests.gameId,
          testsTotal: count(),
          testsActive: sql<number>`count(*) filter (where ${tests.status} = 'published')`.mapWith(
            Number,
          ),
        })
        .from(tests)
        .where(and(eq(tests.organizationId, organizationId), inArray(tests.gameId, gameIds)))
        .groupBy(tests.gameId),
      this.db
        .select({
          gameId: tests.gameId,
          sessionsValid: count(),
        })
        .from(sessionValidations)
        .innerJoin(sessions, eq(sessions.id, sessionValidations.sessionId))
        .innerJoin(tests, eq(tests.id, sessions.testId))
        .where(
          and(
            eq(tests.organizationId, organizationId),
            inArray(tests.gameId, gameIds),
            eq(sessionValidations.valid, true),
          ),
        )
        .groupBy(tests.gameId),
      this.db
        .select({
          gameId: tests.gameId,
          playersTotal: countDistinct(participations.userId),
        })
        .from(participations)
        .innerJoin(tests, eq(tests.id, participations.testId))
        .where(and(eq(tests.organizationId, organizationId), inArray(tests.gameId, gameIds)))
        .groupBy(tests.gameId),
      this.db
        .select({
          gameId: gameReviews.gameId,
          averageRating: sql<number>`avg(${gameReviews.rating})::float`.mapWith(Number),
        })
        .from(gameReviews)
        .where(inArray(gameReviews.gameId, gameIds))
        .groupBy(gameReviews.gameId),
    ]);

    for (const row of testRows) {
      const current = result.get(row.gameId);
      if (current) {
        current.testsTotal = Number(row.testsTotal);
        current.testsActive = Number(row.testsActive);
      }
    }
    for (const row of sessionRows) {
      const current = result.get(row.gameId);
      if (current) current.sessionsValid = Number(row.sessionsValid);
    }
    for (const row of playerRows) {
      const current = result.get(row.gameId);
      if (current) current.playersTotal = Number(row.playersTotal);
    }
    for (const row of ratingRows) {
      const current = result.get(row.gameId);
      if (current) {
        current.averageRating =
          row.averageRating === null || Number.isNaN(row.averageRating)
            ? null
            : Number(row.averageRating);
      }
    }

    return result;
  }

  async findCoverAndBannerByGameIds(
    organizationId: string,
    gameIds: string[],
  ): Promise<Map<string, GameCoverBanner>> {
    const result = new Map<string, GameCoverBanner>();
    if (gameIds.length === 0) return result;
    for (const id of gameIds) result.set(id, { cover: null, banner: null });

    const rows = await this.db
      .select()
      .from(gameAssets)
      .where(
        and(
          eq(gameAssets.organizationId, organizationId),
          isNull(gameAssets.deletedAt),
          inArray(gameAssets.gameId, gameIds),
          inArray(gameAssets.kind, ['cover', 'banner']),
        ),
      )
      .orderBy(desc(gameAssets.id));

    for (const row of rows) {
      const slot = result.get(row.gameId);
      if (!slot) continue;
      if (row.kind === 'cover' && !slot.cover) slot.cover = row;
      if (row.kind === 'banner' && !slot.banner) slot.banner = row;
    }
    return result;
  }

  async findAssetByStorageKeyInOrg(
    organizationId: string,
    storageKey: string,
  ): Promise<GameAssetRow | null> {
    const rows = await this.db
      .select()
      .from(gameAssets)
      .where(
        and(
          eq(gameAssets.organizationId, organizationId),
          eq(gameAssets.storageKey, storageKey),
          isNull(gameAssets.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async findAssetByIdInOrg(
    organizationId: string,
    gameId: string,
    assetId: string,
  ): Promise<GameAssetRow | null> {
    if (!isUuid(assetId)) return null;
    const rows = await this.db
      .select()
      .from(gameAssets)
      .where(
        and(
          eq(gameAssets.organizationId, organizationId),
          eq(gameAssets.gameId, gameId),
          eq(gameAssets.id, assetId),
          isNull(gameAssets.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async createAssetInOrg(
    organizationId: string,
    values: Omit<NewGameAssetRow, 'organizationId'>,
  ): Promise<GameAssetRow> {
    const rows = await this.db
      .insert(gameAssets)
      .values({ ...values, organizationId })
      .returning();
    return rows[0];
  }

  /**
   * Soft-deletes previous cover/banner of the same kind so the card always
   * has a single current image. Screenshots accumulate.
   */
  async retirePreviousUniqueAssets(
    organizationId: string,
    gameId: string,
    kind: AssetKind,
    keepAssetId: string,
  ): Promise<GameAssetRow[]> {
    if (kind === 'screenshot') return [];
    const retired = await this.db
      .update(gameAssets)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(gameAssets.organizationId, organizationId),
          eq(gameAssets.gameId, gameId),
          eq(gameAssets.kind, kind),
          isNull(gameAssets.deletedAt),
          ne(gameAssets.id, keepAssetId),
        ),
      )
      .returning();
    return retired;
  }

  async softDeleteAssetInOrg(
    organizationId: string,
    gameId: string,
    assetId: string,
  ): Promise<GameAssetRow> {
    const rows = await this.db
      .update(gameAssets)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(gameAssets.organizationId, organizationId),
          eq(gameAssets.gameId, gameId),
          eq(gameAssets.id, assetId),
          isNull(gameAssets.deletedAt),
        ),
      )
      .returning();
    if (rows.length === 0) throw AppException.notFound();
    return rows[0];
  }
}

/** Escape `\`, `%` and `_` so user search cannot broaden an ILIKE pattern. */
function escapeIlike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
