import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import type { AuthUser } from '../../shared/auth/roles';
import type { CommunityPostRow } from '../../infra/database/schema/community';
import { CommunityService } from './community.service';
import type { CommunityRepository, PostRecord, ReviewRecord } from './community.repository';
import type { GamesService } from '../games/games.service';

const GAME_ID = '01990000-0000-7000-8000-0000000000b1';
const OWNER_ORG = '01990000-0000-7000-8000-0000000000a1';
const OTHER_ORG = '01990000-0000-7000-8000-0000000000a2';
const POST_ID = '01990000-0000-7000-8000-0000000000c1';

function makePostRecord(overrides: Partial<PostRecord> = {}): PostRecord {
  return {
    id: POST_ID,
    gameId: GAME_ID,
    authorUserId: 'user-1',
    authorDisplayName: 'Jogador Um',
    body: 'Ótimo jogo!',
    status: 'visible',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makePostRow(overrides: Partial<CommunityPostRow> = {}): CommunityPostRow {
  return {
    id: POST_ID,
    gameId: GAME_ID,
    authorUserId: 'user-1',
    body: 'Ótimo jogo!',
    status: 'visible',
    moderatedBy: null,
    moderatedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeReviewRecord(overrides: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    id: 'review-1',
    gameId: GAME_ID,
    authorUserId: 'user-1',
    authorDisplayName: 'Jogador Um',
    rating: '5',
    body: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return { userId: 'user-1', organizationId: OWNER_ORG, role: 'player', email: 'a@b.dev', ...overrides };
}

describe('CommunityService', () => {
  let repo: {
    listVisiblePosts: ReturnType<typeof vi.fn>;
    createPost: ReturnType<typeof vi.fn>;
    findPostById: ReturnType<typeof vi.fn>;
    findPostRowById: ReturnType<typeof vi.fn>;
    insertReport: ReturnType<typeof vi.fn>;
    moderatePost: ReturnType<typeof vi.fn>;
    listReviews: ReturnType<typeof vi.fn>;
    hasValidSessionForGame: ReturnType<typeof vi.fn>;
    createReview: ReturnType<typeof vi.fn>;
  };
  let games: { existsAnyOrg: ReturnType<typeof vi.fn> };
  let service: CommunityService;
  let req: Request;

  beforeEach(() => {
    repo = {
      listVisiblePosts: vi.fn(),
      createPost: vi.fn(),
      findPostById: vi.fn(),
      findPostRowById: vi.fn(),
      insertReport: vi.fn(),
      moderatePost: vi.fn(),
      listReviews: vi.fn(),
      hasValidSessionForGame: vi.fn(),
      createReview: vi.fn(),
    };
    games = {
      existsAnyOrg: vi.fn().mockResolvedValue({ id: GAME_ID, organizationId: OWNER_ORG, status: 'active' }),
    };
    service = new CommunityService(
      repo as unknown as CommunityRepository,
      games as unknown as GamesService,
    );
    req = {} as Request;
  });

  describe('createPost', () => {
    it('404s when the game does not exist (any org)', async () => {
      games.existsAnyOrg.mockRejectedValueOnce({ status: 404 });
      await expect(
        service.createPost(GAME_ID, makeUser(), { body: 'oi' }),
      ).rejects.toMatchObject({ status: 404 });
      expect(repo.createPost).not.toHaveBeenCalled();
    });

    it('creates the post under the author from the token', async () => {
      repo.createPost.mockResolvedValue(makePostRecord());
      const view = await service.createPost(GAME_ID, makeUser(), { body: 'Ótimo jogo!' });
      expect(repo.createPost).toHaveBeenCalledWith(GAME_ID, 'user-1', 'Ótimo jogo!');
      expect(view).toMatchObject({ id: POST_ID, status: 'visible', authorUserId: 'user-1' });
    });
  });

  describe('reportPost', () => {
    it('404s for an unknown post', async () => {
      repo.findPostRowById.mockResolvedValue(null);
      await expect(
        service.reportPost(POST_ID, makeUser(), { reason: 'spam' }),
      ).rejects.toMatchObject({ status: 404 });
      expect(repo.insertReport).not.toHaveBeenCalled();
    });

    it('records the report against the reporter from the token', async () => {
      repo.findPostRowById.mockResolvedValue(makePostRow());
      await service.reportPost(POST_ID, makeUser({ userId: 'reporter-1' }), {
        reason: 'abuse',
        details: 'ofensivo',
      });
      expect(repo.insertReport).toHaveBeenCalledWith(POST_ID, 'reporter-1', 'abuse', 'ofensivo');
    });
  });

  describe('moderatePost', () => {
    it('403s when the moderator is not from the owning studio', async () => {
      repo.findPostRowById.mockResolvedValue(makePostRow());
      games.existsAnyOrg.mockResolvedValue({ id: GAME_ID, organizationId: OTHER_ORG, status: 'active' });

      await expect(
        service.moderatePost(POST_ID, makeUser({ organizationId: OWNER_ORG, role: 'owner' }), { action: 'hide' }, req),
      ).rejects.toMatchObject({ status: 403 });
      expect(repo.moderatePost).not.toHaveBeenCalled();
    });

    it('maps hide/restore/remove to the real post_status enum and audits the change', async () => {
      repo.findPostRowById.mockResolvedValue(makePostRow());
      repo.findPostById.mockResolvedValue(makePostRecord());
      repo.moderatePost.mockResolvedValue(makePostRecord({ status: 'hidden' }));

      const moderator = makeUser({ userId: 'mod-1', organizationId: OWNER_ORG, role: 'owner' });
      const view = await service.moderatePost(POST_ID, moderator, { action: 'hide' }, req);

      expect(repo.moderatePost).toHaveBeenCalledWith(POST_ID, 'mod-1', 'hidden');
      expect(view.status).toBe('hidden');
      const [draft] = drainAuditDrafts(req);
      expect(draft).toMatchObject({ action: 'community.post_moderated', entity: 'community_posts', entityId: POST_ID });
    });
  });

  describe('createReview', () => {
    it('403s without a completed valid session for the game', async () => {
      repo.hasValidSessionForGame.mockResolvedValue(false);
      await expect(
        service.createReview(GAME_ID, makeUser(), { rating: 5 }),
      ).rejects.toMatchObject({ status: 403 });
      expect(repo.createReview).not.toHaveBeenCalled();
    });

    it('creates the review once eligible', async () => {
      repo.hasValidSessionForGame.mockResolvedValue(true);
      repo.createReview.mockResolvedValue(makeReviewRecord());

      const view = await service.createReview(GAME_ID, makeUser(), { rating: 5, body: 'Bom!' });
      expect(repo.createReview).toHaveBeenCalledWith(GAME_ID, 'user-1', 5, 'Bom!');
      expect(view.rating).toBe(5);
    });

    it('409s on a duplicate review (unique violation)', async () => {
      repo.hasValidSessionForGame.mockResolvedValue(true);
      repo.createReview.mockRejectedValue({ code: '23505' });

      await expect(
        service.createReview(GAME_ID, makeUser(), { rating: 4 }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });
});
