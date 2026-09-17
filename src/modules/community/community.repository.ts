import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import {
  communityPosts,
  communityReports,
  gameReviews,
  type CommunityPostRow,
} from '../../infra/database/schema/community';
import { participations, sessions, sessionValidations } from '../../infra/database/schema/participations';
import { tests } from '../../infra/database/schema/tests';
import { users } from '../../infra/database/schema/users';
import { AppException } from '../../shared/errors/app.exception';
import { buildPage, decodeCursor, type Page, type PaginationQuery } from '../../shared/pagination/pagination';
import { isUuid } from '../../shared/util/uuid';
import type { PostStatus } from './dto/community.dto';

export interface PostRecord {
  id: string;
  gameId: string;
  authorUserId: string;
  authorDisplayName: string;
  body: string;
  status: PostStatus;
  createdAt: Date;
}

export interface ReviewRecord {
  id: string;
  gameId: string;
  authorUserId: string;
  authorDisplayName: string;
  rating: string;
  body: string | null;
  createdAt: Date;
}

@Injectable()
export class CommunityRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  private postSelect() {
    return {
      id: communityPosts.id,
      gameId: communityPosts.gameId,
      authorUserId: communityPosts.authorUserId,
      authorDisplayName: users.displayName,
      body: communityPosts.body,
      status: communityPosts.status,
      createdAt: communityPosts.createdAt,
    };
  }

  /** Only `visible` posts — hidden/removed drop off the public feed (moderation has to be effective). */
  async listVisiblePosts(gameId: string, query: PaginationQuery): Promise<Page<PostRecord>> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [eq(communityPosts.gameId, gameId), eq(communityPosts.status, 'visible')];
    if (cursorId) filters.push(lt(communityPosts.id, cursorId));

    const rows = await this.db
      .select(this.postSelect())
      .from(communityPosts)
      .innerJoin(users, eq(communityPosts.authorUserId, users.id))
      .where(and(...filters))
      .orderBy(desc(communityPosts.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
  }

  async createPost(gameId: string, authorUserId: string, body: string): Promise<PostRecord> {
    const [inserted] = await this.db
      .insert(communityPosts)
      .values({ gameId, authorUserId, body })
      .returning({ id: communityPosts.id });

    const created = await this.findPostById(inserted.id);
    if (!created) throw new Error('Post recém-criado não encontrado');
    return created;
  }

  async findPostById(id: string): Promise<PostRecord | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select(this.postSelect())
      .from(communityPosts)
      .innerJoin(users, eq(communityPosts.authorUserId, users.id))
      .where(eq(communityPosts.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Raw row (no author join) — used to resolve the owning game for moderation. */
  async findPostRowById(id: string): Promise<CommunityPostRow | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(communityPosts)
      .where(eq(communityPosts.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertReport(
    postId: string,
    reporterUserId: string,
    reason: string,
    detail: string | null,
  ): Promise<void> {
    await this.db.insert(communityReports).values({ postId, reporterUserId, reason, detail });
  }

  async moderatePost(id: string, moderatorUserId: string, status: PostStatus): Promise<PostRecord> {
    const rows = await this.db
      .update(communityPosts)
      .set({ status, moderatedBy: moderatorUserId, moderatedAt: new Date() })
      .where(eq(communityPosts.id, id))
      .returning({ id: communityPosts.id });
    if (rows.length === 0) throw AppException.notFound();

    const updated = await this.findPostById(id);
    if (!updated) throw AppException.notFound();
    return updated;
  }

  private reviewSelect() {
    return {
      id: gameReviews.id,
      gameId: gameReviews.gameId,
      authorUserId: gameReviews.userId,
      authorDisplayName: users.displayName,
      rating: gameReviews.rating,
      body: gameReviews.body,
      createdAt: gameReviews.createdAt,
    };
  }

  async listReviews(
    gameId: string,
    query: PaginationQuery,
  ): Promise<{ page: Page<ReviewRecord>; averageRating: number | null }> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [eq(gameReviews.gameId, gameId)];
    if (cursorId) filters.push(lt(gameReviews.id, cursorId));

    const [rows, avgRows] = await Promise.all([
      this.db
        .select(this.reviewSelect())
        .from(gameReviews)
        .innerJoin(users, eq(gameReviews.userId, users.id))
        .where(and(...filters))
        .orderBy(desc(gameReviews.id))
        .limit(query.limit + 1),
      this.db
        .select({ avg: sql<number | null>`avg(${gameReviews.rating})::float` })
        .from(gameReviews)
        .where(eq(gameReviews.gameId, gameId)),
    ]);

    return { page: buildPage(rows, query.limit), averageRating: avgRows[0]?.avg ?? null };
  }

  /** Tela 15: only a player who completed >=1 valid session of a test of this game may review it. */
  async hasValidSessionForGame(userId: string, gameId: string): Promise<boolean> {
    const rows = await this.db
      .select({ one: sql`1` })
      .from(sessions)
      .innerJoin(sessionValidations, eq(sessionValidations.sessionId, sessions.id))
      .innerJoin(participations, eq(participations.id, sessions.participationId))
      .innerJoin(tests, eq(tests.id, sessions.testId))
      .where(
        and(
          eq(participations.userId, userId),
          eq(tests.gameId, gameId),
          eq(sessionValidations.valid, true),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async createReview(
    gameId: string,
    userId: string,
    rating: number,
    body: string | null,
  ): Promise<ReviewRecord> {
    const [inserted] = await this.db
      .insert(gameReviews)
      .values({ gameId, userId, rating: String(rating), body })
      .returning({ id: gameReviews.id });

    const rows = await this.db
      .select(this.reviewSelect())
      .from(gameReviews)
      .innerJoin(users, eq(gameReviews.userId, users.id))
      .where(eq(gameReviews.id, inserted.id))
      .limit(1);
    return rows[0];
  }
}
