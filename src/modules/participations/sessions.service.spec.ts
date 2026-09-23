import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '../../infra/database/schema/participations';
import type { TestRow } from '../../infra/database/schema/tests';
import type { BuildsRepository } from '../builds/builds.repository';
import type { GamesService } from '../games/games.service';
import { SessionsService } from './sessions.service';
import type { ParticipationsRepository } from './participations.repository';

const TEST_ID = '01990000-0000-7000-8000-0000000000c1';
const PARTICIPATION_ID = '01990000-0000-7000-8000-0000000000f1';
const SESSION_ID = '01990000-0000-7000-8000-0000000000a9';
const USER_ID = '01990000-0000-7000-8000-0000000000e1';

function makeTestRow(overrides: Partial<TestRow> = {}): TestRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: TEST_ID,
    organizationId: '01990000-0000-7000-8000-0000000000a1',
    gameId: '01990000-0000-7000-8000-0000000000b1',
    name: 'Onboarding',
    modelKey: 'free_exploration',
    status: 'published',
    currentStep: 'review',
    slotsTotal: 10,
    slotsTaken: 1,
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

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: SESSION_ID,
    participationId: PARTICIPATION_ID,
    testId: TEST_ID,
    organizationId: '01990000-0000-7000-8000-0000000000a1',
    status: 'starting',
    startedAt: now,
    endedAt: null,
    durationMs: null,
    finishIdempotencyKey: null,
    ...overrides,
  };
}

function makeBuildWithSteps(status: 'validated' | 'processing' | 'failed' = 'validated') {
  return { build: { status }, steps: [] } as unknown as Awaited<
    ReturnType<BuildsRepository['findLatestBuild']>
  >;
}

describe('SessionsService', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let builds: { findLatestBuild: ReturnType<typeof vi.fn> };
  let games: { getAnyOrg: ReturnType<typeof vi.fn> };
  let queue: { ensureEnqueued: ReturnType<typeof vi.fn> };
  let storage: { createDownloadUrl: ReturnType<typeof vi.fn> };
  let redis: { set: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> };
  let service: SessionsService;

  beforeEach(() => {
    repo = {
      getByIdForUserOrThrow: vi.fn(),
      findTestById: vi.fn(),
      findConsent: vi.fn(),
      startSession: vi.fn(),
      getSessionForUserOrThrow: vi.fn(),
      insertDeviceEvent: vi.fn(),
      updateSession: vi.fn(),
      finishSession: vi.fn(),
      findFormQuestions: vi.fn().mockResolvedValue([]),
      findPrimaryRecording: vi.fn().mockResolvedValue(null),
      findFormResponse: vi.fn().mockResolvedValue(null),
      findSessionValidation: vi.fn().mockResolvedValue(null),
      insertFormResponse: vi.fn(),
    };
    builds = { findLatestBuild: vi.fn() };
    games = { getAnyOrg: vi.fn() };
    queue = { ensureEnqueued: vi.fn().mockResolvedValue(undefined) };
    storage = { createDownloadUrl: vi.fn().mockResolvedValue('https://signed') };
    redis = { set: vi.fn().mockResolvedValue('OK'), del: vi.fn().mockResolvedValue(1) };
    service = new SessionsService(
      repo as unknown as ParticipationsRepository,
      builds as unknown as BuildsRepository,
      games as unknown as GamesService,
      queue as never,
      storage as never,
      redis as never,
    );
  });

  describe('start', () => {
    const participation = {
      id: PARTICIPATION_ID,
      testId: TEST_ID,
      userId: USER_ID,
      status: 'reserved',
    };

    it('409s when the build is not validated', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(participation);
      repo.findTestById.mockResolvedValue(makeTestRow());
      builds.findLatestBuild.mockResolvedValue(makeBuildWithSteps('processing'));

      await expect(
        service.start(PARTICIPATION_ID, USER_ID, { buildVersion: '1.0.0', platform: 'windows' }),
      ).rejects.toMatchObject({ status: 409 });
      expect(repo.startSession).not.toHaveBeenCalled();
    });

    it('409s when a required consent was never recorded', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(participation);
      repo.findTestById.mockResolvedValue(makeTestRow());
      builds.findLatestBuild.mockResolvedValue(makeBuildWithSteps('validated'));
      repo.findConsent.mockResolvedValue(null);

      await expect(
        service.start(PARTICIPATION_ID, USER_ID, { buildVersion: '1.0.0', platform: 'windows' }),
      ).rejects.toMatchObject({ status: 409 });
      expect(repo.startSession).not.toHaveBeenCalled();
    });

    it('starts the session once build + consents are ready', async () => {
      repo.getByIdForUserOrThrow.mockResolvedValue(participation);
      repo.findTestById.mockResolvedValue(makeTestRow());
      builds.findLatestBuild.mockResolvedValue(makeBuildWithSteps('validated'));
      repo.findConsent.mockResolvedValue({ screenRecording: true });
      repo.startSession.mockResolvedValue(makeSession());

      const started = await service.start(PARTICIPATION_ID, USER_ID, {
        buildVersion: '1.0.0',
        platform: 'windows',
      });
      expect(started.sessionId).toBe(SESSION_ID);
      expect(started.recordingRequired).toBe(true);
      expect(redis.set).toHaveBeenCalled();
    });
  });

  describe('recordDeviceEvent', () => {
    it('409s when the session is already closed', async () => {
      repo.getSessionForUserOrThrow.mockResolvedValue(makeSession({ status: 'completed' }));
      await expect(
        service.recordDeviceEvent(SESSION_ID, USER_ID, { kind: 'webcam', enabled: true, tMs: 100 }),
      ).rejects.toMatchObject({ status: 409 });
      expect(repo.insertDeviceEvent).not.toHaveBeenCalled();
    });

    it('inserts the event for an open session', async () => {
      repo.getSessionForUserOrThrow.mockResolvedValue(makeSession({ status: 'recording' }));
      await service.recordDeviceEvent(SESSION_ID, USER_ID, {
        kind: 'webcam',
        enabled: true,
        tMs: 100,
      });
      expect(repo.insertDeviceEvent).toHaveBeenCalledWith(SESSION_ID, 'webcam', 100, true);
    });
  });

  describe('finish', () => {
    it('enqueues session.validate and returns the finished view', async () => {
      repo.getSessionForUserOrThrow.mockResolvedValue(makeSession());
      repo.finishSession.mockResolvedValue(
        makeSession({ status: 'processing', endedAt: new Date(), durationMs: 12_000 }),
      );

      const view = await service.finish(
        SESSION_ID,
        USER_ID,
        { tMs: 12_000, confirmed: true },
        undefined,
      );
      expect(view.status).toBe('in_review');
      expect(queue.ensureEnqueued).toHaveBeenCalledWith(
        'session.validate',
        expect.stringContaining(SESSION_ID),
        { sessionId: SESSION_ID },
      );
      expect(redis.del).toHaveBeenCalled();
    });

    it('409s when the repository reports the session already closed', async () => {
      repo.getSessionForUserOrThrow.mockResolvedValue(makeSession());
      repo.finishSession.mockRejectedValue({ status: 409, message: 'Sessão já encerrada' });

      await expect(
        service.finish(SESSION_ID, USER_ID, { tMs: 1000, confirmed: true }, undefined),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('submitFormResponse', () => {
    const questions = [
      {
        id: 'q1',
        required: true,
        type: 'open_text',
        label: 'Q1',
        helpText: null,
        position: 0,
        scaleMin: null,
        scaleMax: null,
      },
    ];

    it('422s when a required question is unanswered', async () => {
      repo.getSessionForUserOrThrow.mockResolvedValue(makeSession());
      repo.findFormQuestions.mockResolvedValue(questions);

      await expect(
        service.submitFormResponse(SESSION_ID, USER_ID, { answers: [] }, undefined),
      ).rejects.toMatchObject({ status: 422 });
      expect(repo.insertFormResponse).not.toHaveBeenCalled();
    });

    it('409s on a duplicate submit (unique violation)', async () => {
      repo.getSessionForUserOrThrow.mockResolvedValue(makeSession());
      repo.findFormQuestions.mockResolvedValue(questions);
      repo.insertFormResponse.mockRejectedValue({ code: '23505' });

      await expect(
        service.submitFormResponse(
          SESSION_ID,
          USER_ID,
          { answers: [{ questionId: 'q1', value: 'ok' }] },
          undefined,
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('submits successfully when all required questions are answered', async () => {
      repo.getSessionForUserOrThrow.mockResolvedValue(makeSession());
      repo.findFormQuestions.mockResolvedValue(questions);
      repo.insertFormResponse.mockResolvedValue({
        id: 'resp-1',
        submittedAt: new Date('2026-01-03T00:00:00.000Z'),
      });

      const response = await service.submitFormResponse(
        SESSION_ID,
        USER_ID,
        { answers: [{ questionId: 'q1', value: 'ok' }] },
        undefined,
      );
      expect(response.id).toBe('resp-1');
      expect(response.sessionId).toBe(SESSION_ID);
    });
  });
});
