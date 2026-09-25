import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gt } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { newId } from '../../infra/database/schema/_helpers';
import {
  feedRankingSnapshots,
  type FeedRankingSnapshotRow,
} from '../../infra/database/schema/player';
import { FEED_SNAPSHOT_TTL_SECONDS } from './dto/feed.dto';

@Injectable()
export class FeedRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Only a non-expired snapshot is usable — an expired seed is treated as if it didn't exist. */
  async findValidSnapshot(seed: string): Promise<FeedRankingSnapshotRow | null> {
    const rows = await this.db
      .select()
      .from(feedRankingSnapshots)
      .where(
        and(eq(feedRankingSnapshots.seed, seed), gt(feedRankingSnapshots.expiresAt, new Date())),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async createSnapshot(userId: string, itemIds: string[]): Promise<FeedRankingSnapshotRow> {
    const rows = await this.db
      .insert(feedRankingSnapshots)
      .values({
        seed: newId(),
        userId,
        filtersHash: null,
        itemIds,
        expiresAt: new Date(Date.now() + FEED_SNAPSHOT_TTL_SECONDS * 1000),
      })
      .returning();
    return rows[0];
  }
}
