import { Injectable } from '@nestjs/common';
import { GamesService } from '../games/games.service';
import { FEED_MAX_ITEMS, type FeedList, type FeedQuery } from './dto/feed.dto';
import { FeedRepository } from './feed.repository';

@Injectable()
export class FeedService {
  constructor(
    private readonly feedRepo: FeedRepository,
    private readonly gamesService: GamesService,
  ) {}

  async getFeed(userId: string, query: FeedQuery): Promise<FeedList> {
    let snapshot = query.seed ? await this.feedRepo.findValidSnapshot(query.seed) : null;

    if (!snapshot) {
      const games = await this.gamesService.listActiveAnyOrg(FEED_MAX_ITEMS);
      snapshot = await this.feedRepo.createSnapshot(
        userId,
        games.map((g) => g.id),
      );
    }

    const offset = decodeOffsetCursor(query.cursor);
    const pageIds = snapshot.itemIds.slice(offset, offset + query.limit);
    const nextCursor =
      offset + query.limit < snapshot.itemIds.length
        ? encodeOffsetCursor(offset + query.limit)
        : null;

    const data = await Promise.all(pageIds.map((id) => this.gamesService.getAnyOrg(id)));

    return { data, nextCursor, seed: snapshot.seed };
  }
}

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeOffsetCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const value = Number(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}
