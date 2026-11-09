import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import { recordAudit } from '../../shared/audit/audit-context';
import { AppException } from '../../shared/errors/app.exception';
import { ErrorCode } from '../../shared/errors/error-envelope';
import type { AuthUser } from '../../shared/auth/roles';
import type { Page, PaginationQuery } from '../../shared/pagination/pagination';
import { GamesService } from '../games/games.service';
import { CommunityRepository, type PostRecord, type ReviewRecord } from './community.repository';
import type {
  CommunityPostView,
  CreateCommunityPostDto,
  CreateReviewDto,
  ModeratePostDto,
  PostStatus,
  ReportPostDto,
  ReviewView,
} from './dto/community.dto';

/**
 * Flood control per user, counted in Redis like the chat's: the mural took
 * any number of 5000-character posts — and of reports — from a single
 * account. Generous for a person, tight for a script.
 */
const POST_LIMIT = { limit: 30, windowSeconds: 10 * 60 };
const REPORT_LIMIT = { limit: 60, windowSeconds: 60 * 60 };

const MODERATE_ACTION_TO_STATUS: Record<ModeratePostDto['action'], PostStatus> = {
  hide: 'hidden',
  restore: 'visible',
  remove: 'removed',
};

@Injectable()
export class CommunityService {
  constructor(
    private readonly repo: CommunityRepository,
    private readonly games: GamesService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async listPosts(
    gameId: string,
    viewer: AuthUser,
    query: PaginationQuery,
  ): Promise<Page<CommunityPostView>> {
    await this.getVisibleGame(gameId, viewer);
    const page = await this.repo.listVisiblePosts(gameId, query);
    return { data: page.data.map(toPostView), nextCursor: page.nextCursor };
  }

  async createPost(
    gameId: string,
    author: AuthUser,
    dto: CreateCommunityPostDto,
  ): Promise<CommunityPostView> {
    await this.getVisibleGame(gameId, author);
    await this.enforceLimit(`community:posts:${author.userId}`, POST_LIMIT);
    const created = await this.repo.createPost(gameId, author.userId, dto.body);
    return toPostView(created);
  }

  async reportPost(postId: string, reporter: AuthUser, dto: ReportPostDto): Promise<void> {
    const post = await this.repo.findPostRowById(postId);
    if (!post) throw AppException.notFound();
    await this.getVisibleGame(post.gameId, reporter);
    await this.enforceLimit(`community:reports:${reporter.userId}`, REPORT_LIMIT);
    await this.repo.insertReport(postId, reporter.userId, dto.reason, dto.details ?? null);
  }

  /**
   * "Papéis do estúdio dono do jogo" (BACKEND-SPEC.md §M13): unlike
   * tenancy-scoped resources, a post belonging to another studio's game is
   * visible (it's public content) but not moderable — 403, not 404, matching
   * `openapi.design.yaml`'s declared Forbidden response for this route. A post
   * of a game that isn't `active` is not public: 404 to anyone outside the
   * owning studio (`getVisibleGame`).
   */
  async moderatePost(
    postId: string,
    moderator: AuthUser,
    dto: ModeratePostDto,
    req: Request,
  ): Promise<CommunityPostView> {
    const post = await this.repo.findPostRowById(postId);
    if (!post) throw AppException.notFound();

    const game = await this.getVisibleGame(post.gameId, moderator);
    if (game.organizationId !== moderator.organizationId) {
      throw AppException.forbidden('Seu estúdio não é dono deste jogo');
    }

    const before = await this.repo.findPostById(postId);
    const updated = await this.repo.moderatePost(
      postId,
      moderator.userId,
      MODERATE_ACTION_TO_STATUS[dto.action],
    );

    // The post row has no column for it, so the moderator's reason lives in
    // the audit trail (Tela 20) — before, it was accepted and dropped.
    recordAudit(req, {
      action: 'community.post_moderated',
      entity: 'community_posts',
      entityId: postId,
      before,
      after: dto.reason ? { ...updated, moderationReason: dto.reason } : updated,
    });
    return toPostView(updated);
  }

  async listReviews(
    gameId: string,
    viewer: AuthUser,
    query: PaginationQuery,
  ): Promise<Page<ReviewView> & { averageRating: number | null }> {
    await this.getVisibleGame(gameId, viewer);
    const { page, averageRating } = await this.repo.listReviews(gameId, query);
    return { data: page.data.map(toReviewView), nextCursor: page.nextCursor, averageRating };
  }

  /**
   * RN (Tela 15): only a player who completed >=1 valid session of a test of
   * this game may review it, once. Eligibility is checked directly against
   * `sessions`/`session_validations`/`participations` (M8's tables, already
   * migrated) since M8's application layer doesn't exist yet — the gate is
   * real from day one and just starts working once M8 populates those rows.
   */
  async createReview(gameId: string, author: AuthUser, dto: CreateReviewDto): Promise<ReviewView> {
    await this.getVisibleGame(gameId, author);

    const eligible = await this.repo.hasValidSessionForGame(author.userId, gameId);
    if (!eligible) {
      throw AppException.forbidden('Sem sessão válida concluída neste jogo');
    }

    try {
      const created = await this.repo.createReview(
        gameId,
        author.userId,
        dto.rating,
        dto.body ?? null,
      );
      return toReviewView(created);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw AppException.conflict('Jogador já avaliou este jogo');
      }
      throw err;
    }
  }

  /**
   * The game behind a community route, if the viewer may see it. A game that
   * isn't `active` (draft, archived) is the studio's private state — like the
   * player catalog (DECISIONS.md M8-03), its posts and reviews answer 404 to
   * everyone except members of the organization that owns it, who keep
   * reading and moderating them.
   */
  private async getVisibleGame(
    gameId: string,
    viewer: Pick<AuthUser, 'organizationId'>,
  ): Promise<{ id: string; organizationId: string; status: string }> {
    const game = await this.games.existsAnyOrg(gameId);
    if (game.status !== 'active' && game.organizationId !== viewer.organizationId) {
      throw AppException.notFound();
    }
    return game;
  }

  private async enforceLimit(
    key: string,
    { limit, windowSeconds }: { limit: number; windowSeconds: number },
  ): Promise<void> {
    const count = await this.redis.incr(key);
    if (count === 1 || (await this.redis.ttl(key)) === -1)
      await this.redis.expire(key, windowSeconds);
    if (count > limit) {
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.TOO_MANY_REQUESTS,
        'Muitas publicações seguidas. Aguarde alguns instantes.',
      );
    }
  }
}

function toPostView(row: PostRecord): CommunityPostView {
  return {
    id: row.id,
    gameId: row.gameId,
    authorUserId: row.authorUserId,
    authorDisplayName: row.authorDisplayName,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

function toReviewView(row: ReviewRecord): ReviewView {
  return {
    id: row.id,
    gameId: row.gameId,
    authorUserId: row.authorUserId,
    authorDisplayName: row.authorDisplayName,
    rating: Number(row.rating),
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Drizzle wraps the driver error in a `DrizzleQueryError` whose own `.code`
 * is `undefined` — the real `PostgresError` (with `.code`) sits on `.cause`.
 * Check both so this works whether the error arrives raw or wrapped.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const causeCode = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505' || causeCode === '23505';
}
