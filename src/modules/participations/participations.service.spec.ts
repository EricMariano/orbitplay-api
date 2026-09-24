import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParticipationRow } from '../../infra/database/schema/participations';
import type { TestRow } from '../../infra/database/schema/tests';
import type { BuildsRepository } from '../builds/builds.repository';
import { ParticipationsService } from './participations.service';
import type { ParticipationsRepository } from './participations.repository';

const TEST_ID = '01990000-0000-7000-8000-0000000000c1';
const GAME_ID = '01990000-0000-7000-8000-0000000000b1';
const USER_ID = '01990000-0000-7000-8000-0000000000e1';
const PARTICIPATION_ID = '01990000-0000-7000-8000-0000000000f1';

function makeTestRow(overrides: Partial<TestRow> = {}): TestRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: TEST_ID,
    organizationId: '01990000-0000-7000-8000-0000000000a1',
    gameId: GAME_ID,
    name: null,
    modelKey: 'free_exploration',
    status: 'published',
    currentStep: 'review',
    slotsTotal: 10,
    slotsTaken: 0,
    durationDays: null,
    startsAt: now,
    endsAt: null,
    publishedAt: now,
    publishIdempotencyKey: null,
    rewardAmountCents: null,
    rewardCurrency: null,
    reportStage: 'none',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeParticipation(overrides: Partial<ParticipationRow> = {}): ParticipationRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: PARTICIPATION_ID,
    testId: TEST_ID,
    userId: USER_ID,
    status: 'reserved',
    resumePoint: null,
    idempotencyKey: null,
    expiresAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('ParticipationsService', () => {
  let repo: {
    findTestById: ReturnType<typeof vi.fn>;
    findAudienceAgeRange: ReturnType<typeof vi.fn>;
    findUserBirthdate: ReturnType<typeof vi.fn>;
    reserveParticipation: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    getByIdForUserOrThrow: ReturnType<typeof vi.fn>;
    findConsent: ReturnType<typeof vi.fn>;
    findOpenSessionId: ReturnType<typeof vi.fn>;
    findFirstSessionStartedAt: ReturnType<typeof vi.fn>;
    findLastSessionEndedAt: ReturnType<typeof vi.fn>;
    upsertConsent: ReturnType<typeof vi.fn>;
    findOpenOrLastSessionId: ReturnType<typeof vi.fn>;
    findSessionValidation: ReturnType<typeof vi.fn>;
    sumXpForSession: ReturnType<typeof vi.fn>;
  };
  let builds: { findLatestBuild: ReturnType<typeof vi.fn> };
  let service: ParticipationsService;

  beforeEach(() => {
    repo = {
      findTestById: vi.fn(),
      findAudienceAgeRange: vi.fn().mockResolvedValue(null),
      findUserBirthdate: vi.fn().mockResolvedValue(null),
      reserveParticipation: vi.fn(),
      findById: vi.fn(),
      getByIdForUserOrThrow: vi.fn(),
      findConsent: vi.fn().mockResolvedValue(null),
      findOpenSessionId: vi.fn().mockResolvedValue(null),
      findFirstSessionStartedAt: vi.fn().mockResolvedValue(null),
      findLastSessionEndedAt: vi.fn().mockResolvedValue(null),
      upsertConsent: vi.fn(),
      findOpenOrLastSessionId: vi.fn().mockResolvedValue(null),
      findSessionValidation: vi.fn().mockResolvedValue(null),
      sumXpForSession: vi.fn().mockResolvedValue(0),
    };
    builds = { findLatestBuild: vi.fn().mockResolvedValue(null) };
    service = new ParticipationsService(
      repo as unknown as ParticipationsRepository,
      builds as unknown as BuildsRepository,
    );
  });

  describe('join', () => {
    it('404s when the test does not exist', async () => {
      repo.findTestById.mockResolvedValue(null);
      await expect(service.join(TEST_ID, USER_ID)).rejects.toMatchObject({ status: 404 });
    });

    it('409s when the test is not published', async () => {
      repo.findTestById.mockResolvedValue(makeTestRow({ status: 'draft' }));
      await expect(service.join(TEST_ID, USER_ID)).rejects.toMatchObject({ status: 409 });
      expect(repo.reserveParticipation).not.toHaveBeenCalled();
    });

    it('409s when the test already ended', async () => {
      repo.findTestById.mockResolvedValue(
        makeTestRow({ endsAt: new Date('2020-01-01T00:00:00.000Z') }),
      );
      await expect(service.join(TEST_ID, USER_ID)).rejects.toMatchObject({ status: 409 });
      expect(repo.reserveParticipation).not.toHaveBeenCalled();
    });

    it('403s when the player is outside the audience age bracket', async () => {
      repo.findTestById.mockResolvedValue(makeTestRow());
      repo.findAudienceAgeRange.mockResolvedValue({ ageMin: 18, ageMax: 25 });
      repo.findUserBirthdate.mockResolvedValue('1960-01-01'); // way older than 25
      await expect(service.join(TEST_ID, USER_ID)).rejects.toMatchObject({ status: 403 });
      expect(repo.reserveParticipation).not.toHaveBeenCalled();
    });

    it('lets a player inside the audience age bracket through', async () => {
      repo.findTestById.mockResolvedValue(makeTestRow());
      repo.findAudienceAgeRange.mockResolvedValue({ ageMin: 18, ageMax: 60 });
      repo.findUserBirthdate.mockResolvedValue('1995-06-15');
      repo.reserveParticipation.mockResolvedValue(makeParticipation());

      const view = await service.join(TEST_ID, USER_ID);
      expect(view.id).toBe(PARTICIPATION_ID);
      expect(view.status).toBe('reserved');
      expect(view.gameId).toBe(GAME_ID);
    });

    it('409s when reserveParticipation reports a unique violation (already active)', async () => {
      repo.findTestById.mockResolvedValue(makeTestRow());
      repo.reserveParticipation.mockRejectedValue({ code: '23505' });
      await expect(service.join(TEST_ID, USER_ID)).rejects.toMatchObject({ status: 409 });
    });

    it('propagates the "vagas esgotadas" conflict raised by the repository', async () => {
      repo.findTestById.mockResolvedValue(makeTestRow());
      const slotsFull = { status: 409, message: 'Vagas esgotadas' };
      repo.reserveParticipation.mockRejectedValue(slotsFull);
      await expect(service.join(TEST_ID, USER_ID)).rejects.toBe(slotsFull);
    });
  });

  describe('get', () => {
    it('builds the view for the caller’s own participation', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(makeParticipation());
      repo.findTestById.mockResolvedValue(makeTestRow());

      const view = await service.get(PARTICIPATION_ID, USER_ID);
      expect(view.id).toBe(PARTICIPATION_ID);
      expect(view.testId).toBe(TEST_ID);
    });

    it('404s when the participation belongs to someone else (repo enforces this)', async () => {
      repo.getByIdForUserOrThrow.mockRejectedValue({ status: 404 });
      await expect(service.get(PARTICIPATION_ID, USER_ID)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('tutorial', () => {
    it('returns the tutorial for the participation’s test model', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(makeParticipation());
      repo.findTestById.mockResolvedValue(makeTestRow({ modelKey: 'free_exploration' }));

      const tutorial = await service.tutorial(PARTICIPATION_ID, USER_ID);
      expect(tutorial.modelKey).toBe('free_exploration');
      expect(tutorial.requiredConsents).toContain('screen_recording');
    });

    it('returns no required consents for the image A/B model', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(makeParticipation());
      repo.findTestById.mockResolvedValue(makeTestRow({ modelKey: 'ab_test_images' }));

      const tutorial = await service.tutorial(PARTICIPATION_ID, USER_ID);
      expect(tutorial.requiredConsents).toEqual([]);
    });
  });

  describe('consents', () => {
    it('422s when a required consent is refused', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(makeParticipation());
      repo.findTestById.mockResolvedValue(makeTestRow({ modelKey: 'free_exploration' }));

      await expect(
        service.consents(
          PARTICIPATION_ID,
          USER_ID,
          { consents: [{ kind: 'screen_recording', granted: false }] },
          { ip: null, userAgent: null },
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(repo.upsertConsent).not.toHaveBeenCalled();
    });

    it('records consents when every required one is granted', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(makeParticipation());
      repo.findTestById.mockResolvedValue(makeTestRow({ modelKey: 'free_exploration' }));
      repo.upsertConsent.mockResolvedValue({ acceptedAt: new Date('2026-01-02T00:00:00.000Z') });

      const record = await service.consents(
        PARTICIPATION_ID,
        USER_ID,
        { consents: [{ kind: 'screen_recording', granted: true }] },
        { ip: '1.2.3.4', userAgent: 'vitest' },
      );
      expect(record.allRequiredGranted).toBe(true);
      expect(repo.upsertConsent).toHaveBeenCalledWith(
        PARTICIPATION_ID,
        [{ kind: 'screen_recording', granted: true }],
        { ip: '1.2.3.4', userAgent: 'vitest' },
      );
    });
  });

  describe('result', () => {
    it('reports in_review with null values before any session exists', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(makeParticipation());
      repo.findOpenOrLastSessionId.mockResolvedValue(null);

      const result = await service.result(PARTICIPATION_ID, USER_ID);
      expect(result).toEqual({
        status: 'in_review',
        xpEarned: null,
        rating: null,
        rewardCents: null,
        rewardStatus: 'pending',
        invalidReason: null,
      });
    });

    it('reports rejected with the invalidation reason when the session was invalid', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(makeParticipation());
      repo.findOpenOrLastSessionId.mockResolvedValue('session-1');
      repo.findSessionValidation.mockResolvedValue({ valid: false, reason: 'timeout' });

      const result = await service.result(PARTICIPATION_ID, USER_ID);
      expect(result.status).toBe('rejected');
      expect(result.invalidReason).toBe('timeout');
      expect(result.xpEarned).toBeNull();
    });

    it('reports completed with XP and reward once the session validated as valid', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(makeParticipation());
      repo.findOpenOrLastSessionId.mockResolvedValue('session-1');
      repo.findSessionValidation.mockResolvedValue({ valid: true, reason: null });
      repo.findTestById.mockResolvedValue(makeTestRow({ rewardAmountCents: 500 }));
      repo.sumXpForSession.mockResolvedValue(50);

      const result = await service.result(PARTICIPATION_ID, USER_ID);
      expect(result).toEqual({
        status: 'completed',
        xpEarned: 50,
        rating: null,
        rewardCents: 500,
        rewardStatus: 'pending',
        invalidReason: null,
      });
    });
  });
});
