import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../shared/errors/app.exception';
import type { GameView } from '../games/dto/game.dto';
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
    let snapshot = query.seed ? await this.feedRepo.findValidSnapshot(userId, query.seed) : null;

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

    const games = await Promise.all(pageIds.map((id) => this.getGameOrNull(id)));
    const data = games.filter((game): game is GameView => game !== null);

    return { data, nextCursor, seed: snapshot.seed };
  }

  /**
   * A game deleted after the snapshot was frozen is skipped, not a 404 for
   * the whole page — the snapshot outlives it by up to the TTL.
   */
  private async getGameOrNull(id: string): Promise<GameView | null> {
    try {
      return await this.gamesService.getAnyOrg(id);
    } catch (err) {
      if (err instanceof AppException && err.getStatus() === HttpStatus.NOT_FOUND) return null;
      throw err;
    }
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
