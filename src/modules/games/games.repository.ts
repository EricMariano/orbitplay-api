import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { games, type GameRow, type NewGameRow } from '../../infra/database/schema/games';
import { OrgScopedRepository } from '../../infra/database/base.repository';

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
}
