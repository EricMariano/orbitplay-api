import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BuildRow,
  BuildValidationStepRow,
  TestAudienceCriteriaRow,
  TestRow,
} from '../../infra/database/schema/tests';
import { drainAuditDrafts } from '../../shared/audit/audit-context';
import type { QueuePort } from '../../shared/ports/queue.port';
import type { StoragePort } from '../../shared/ports/storage.port';
import type { BuildWithSteps, BuildsRepository } from '../builds/builds.repository';
import { GamesService } from '../games/games.service';
import { TestModelsService } from '../test-models/test-models.service';
import { MAX_BUILD_BYTES } from './dto/test.dto';
import { buildBuildStorageKey, validatedBuildStorageKey, webBuildPrefix } from './storage-key';
import { TestsService } from './tests.service';
import type { TestsRepository } from './tests.repository';
import type { DashboardKpiCache } from '../../infra/redis/dashboard-kpi-cache';

const ORG = '01990000-0000-7000-8000-0000000000a1';
const GAME_ID = '01990000-0000-7000-8000-0000000000b1';
const TEST_ID = '01990000-0000-7000-8000-0000000000c1';
const BUILD_ID = '01990000-0000-7000-8000-0000000000d1';
const OTHER_BUILD_ID = '01990000-0000-7000-8000-0000000000d2';

function makeTestRow(overrides: Partial<TestRow> = {}): TestRow {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: TEST_ID,
    organizationId: ORG,
    gameId: GAME_ID,
    name: null,
    modelKey: 'free_exploration',
    status: 'draft',
    currentStep: 'form',
    slotsTotal: 0,
    slotsTaken: 0,
    durationDays: null,
    startsAt: null,
    endsAt: null,
    publishedAt: null,
    publishIdempotencyKey: null,
    rewardAmountCents: null,
    rewardCurrency: null,
    reportStage: 'none',
    gamepadSupported: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeBuild(overrides: Partial<BuildRow> = {}): BuildRow {
  return {
    id: BUILD_ID,
    organizationId: ORG,
    testId: TEST_ID,
    fileName: 'game.zip',
    version: '1.0.0',
    platform: 'windows',
    sizeBytes: 1024,
    checksum: null,
    storageKey: `orgs/${ORG}/tests/${TEST_ID}/builds/${BUILD_ID}/game.zip`,
    status: 'validated',
    failureReason: null,
    scanEngine: null,
    scanSignatures: null,
    scanFinishedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeSteps(status: BuildValidationStepRow['status'] = 'ready'): BuildValidationStepRow[] {
  return [
    { id: 's1', buildId: BUILD_ID, key: 'checksum', status, message: null, finishedAt: null },
    { id: 's2', buildId: BUILD_ID, key: 'malware_scan', status, message: null, finishedAt: null },
    { id: 's3', buildId: BUILD_ID, key: 'metadata', status, message: null, finishedAt: null },
  ];
}

function makeAudience(overrides: Partial<TestAudienceCriteriaRow> = {}): TestAudienceCriteriaRow {
  return {
    testId: TEST_ID,
    countries: [],
    archetypes: [],
    platforms: [],
    ageMin: 18,
    ageMax: 40,
    testerCount: 10,
    keepActive: false,
    estimatedReach: 5,
    playerTier: 'all',
    boosted: false,
    ...overrides,
  };
}

/** Batch-lookup result holding one entry for TEST_ID. */
function byTest<T>(value: T): Map<string, T> {
  return new Map([[TEST_ID, value]]);
}

/** A Drizzle-wrapped unique violation, as postgres-js + Drizzle actually throw it. */
function wrappedUniqueViolation(constraint: string): Error {
  // The top-level `.code` is undefined; the real PostgresError sits on `.cause`.
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    name: 'DrizzleQueryError',
    code: undefined,
    cause: Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint_name: constraint,
    }),
  });
}

describe('TestsService', () => {
  let repo: {
    getByIdInOrgOrThrow: ReturnType<typeof vi.fn>;
    createInOrg: ReturnType<typeof vi.fn>;
    updateByIdInOrg: ReturnType<typeof vi.fn>;
    withRowLock: ReturnType<typeof vi.fn>;
    findFormQuestions: ReturnType<typeof vi.fn>;
    replaceForm: ReturnType<typeof vi.fn>;
    findAudiencesByTestIds: ReturnType<typeof vi.fn>;
    countFormQuestionsByTestIds: ReturnType<typeof vi.fn>;
    upsertAudience: ReturnType<typeof vi.fn>;
    countEligiblePlayers: ReturnType<typeof vi.fn>;
    listByGameInOrg: ReturnType<typeof vi.fn>;
  };
  let buildsRepo: {
    findLatestBuild: ReturnType<typeof vi.fn>;
    findLatestBuildsByTestIds: ReturnType<typeof vi.fn>;
    createBuildWithSteps: ReturnType<typeof vi.fn>;
    deleteBuild: ReturnType<typeof vi.fn>;
    markBuildFailed: ReturnType<typeof vi.fn>;
  };
  let games: { existsInOrg: ReturnType<typeof vi.fn> };
  let storage: {
    createUploadUrl: ReturnType<typeof vi.fn>;
    createDownloadUrl: ReturnType<typeof vi.fn>;
    exists: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    removePrefix: ReturnType<typeof vi.fn>;
    healthCheck: ReturnType<typeof vi.fn>;
  };
  let queue: { ensureEnqueued: ReturnType<typeof vi.fn>; healthCheck: ReturnType<typeof vi.fn> };
  let service: TestsService;
  let req: Request;

  beforeEach(() => {
    repo = {
      getByIdInOrgOrThrow: vi.fn(),
      createInOrg: vi.fn(),
      updateByIdInOrg: vi.fn(),
      withRowLock: vi.fn(),
      findFormQuestions: vi.fn().mockResolvedValue([]),
      replaceForm: vi.fn(),
      findAudiencesByTestIds: vi.fn().mockResolvedValue(new Map()),
      countFormQuestionsByTestIds: vi.fn().mockResolvedValue(new Map()),
      upsertAudience: vi.fn(),
      countEligiblePlayers: vi.fn().mockResolvedValue(0),
      listByGameInOrg: vi.fn(),
    };
    buildsRepo = {
      findLatestBuild: vi.fn().mockResolvedValue(null),
      findLatestBuildsByTestIds: vi.fn().mockResolvedValue(new Map()),
      createBuildWithSteps: vi.fn(),
      deleteBuild: vi.fn().mockResolvedValue(undefined),
      markBuildFailed: vi.fn(),
    };
    games = { existsInOrg: vi.fn().mockResolvedValue(true) };
    // Mimics the real TestsRepository.withRowLock: fetches the row (via the
    // same mock other tests already drive through getByIdInOrgOrThrow) and
    // gives the callback an updater backed by updateByIdInOrg — without
    // actually needing a database transaction/row lock in unit tests.
    const getTest = repo.getByIdInOrgOrThrow as (orgId: string, id: string) => Promise<TestRow>;
    const updateRow = repo.updateByIdInOrg as (
      orgId: string,
      id: string,
      patch: unknown,
    ) => Promise<TestRow>;
    repo.withRowLock.mockImplementation(async (orgId, testId, fn) => {
      const test = await getTest(orgId, testId);
      const updateTest = (patch: unknown) => updateRow(orgId, testId, patch);
      return fn(test, updateTest);
    });
    storage = {
      createUploadUrl: vi.fn().mockResolvedValue('https://minio.local/put'),
      createDownloadUrl: vi.fn().mockResolvedValue('https://minio.local/get'),
      exists: vi.fn(),
      stat: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
      removePrefix: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn(),
    };
    queue = {
      ensureEnqueued: vi.fn().mockResolvedValue(undefined),
      healthCheck: vi.fn(),
    };
    service = new TestsService(
      repo as unknown as TestsRepository,
      buildsRepo as unknown as BuildsRepository,
      games as unknown as GamesService,
      new TestModelsService(),
      storage as unknown as StoragePort,
      queue as unknown as QueuePort,
      { invalidate: vi.fn().mockResolvedValue(undefined) } as unknown as DashboardKpiCache,
    );
    req = {} as Request;
  });

  /** Every wizard step done: one question, a validated build, a reachable audience. */
  function readyToPublish() {
    repo.countFormQuestionsByTestIds.mockResolvedValue(byTest(1));
    buildsRepo.findLatestBuildsByTestIds.mockResolvedValue(
      byTest({ build: makeBuild({ status: 'validated' }), steps: makeSteps('ready') }),
    );
    repo.findAudiencesByTestIds.mockResolvedValue(byTest(makeAudience()));
  }

  describe('create', () => {
    it('rejects an unavailable model (free_exploration_telemetry) with 422', async () => {
      await expect(
        service.create(ORG, GAME_ID, { testModelKey: 'free_exploration_telemetry' }, req),
      ).rejects.toMatchObject({ status: 422 });
      expect(repo.createInOrg).not.toHaveBeenCalled();
    });

    it('404s when the game does not exist in the org', async () => {
      games.existsInOrg.mockResolvedValue(false);
      await expect(
        service.create(ORG, GAME_ID, { testModelKey: 'free_exploration' }, req),
      ).rejects.toMatchObject({ status: 404 });
    });

    it('creates a draft already past the model step and records an audit intent', async () => {
      repo.createInOrg.mockResolvedValue(makeTestRow());
      await service.create(ORG, GAME_ID, { testModelKey: 'free_exploration', title: 'Beta' }, req);

      expect(repo.createInOrg).toHaveBeenCalledWith(
        ORG,
        expect.objectContaining({
          gameId: GAME_ID,
          name: 'Beta',
          modelKey: 'free_exploration',
          status: 'draft',
          currentStep: 'form',
        }),
      );
      const drafts = drainAuditDrafts(req);
      expect(drafts[0]).toMatchObject({ action: 'test.created', entity: 'tests' });
    });
  });

  describe('listByGame', () => {
    it('404s when the game does not exist in the org', async () => {
      games.existsInOrg.mockResolvedValue(false);
      await expect(
        service.listByGame(ORG, GAME_ID, { tab: 'active', limit: 20 } as never),
      ).rejects.toMatchObject({ status: 404 });
      expect(repo.listByGameInOrg).not.toHaveBeenCalled();
    });

    it('hydrates each row into a full TestView and forwards the page cursor', async () => {
      repo.listByGameInOrg.mockResolvedValue({
        data: [makeTestRow(), makeTestRow({ id: 'other-id', status: 'published' })],
        nextCursor: 'cursor-1',
      });

      const result = await service.listByGame(ORG, GAME_ID, { tab: 'active', limit: 20 } as never);

      expect(repo.listByGameInOrg).toHaveBeenCalledWith(ORG, GAME_ID, { tab: 'active', limit: 20 });
      expect(result.nextCursor).toBe('cursor-1');
      expect(result.data).toHaveLength(2);
      expect(result.data.map((t) => t.id)).toEqual([TEST_ID, 'other-id']);
    });

    it('loads the whole page with one batched lookup per table, not ~8 queries per test', async () => {
      const otherId = '01990000-0000-7000-8000-0000000000c2';
      repo.listByGameInOrg.mockResolvedValue({
        data: [makeTestRow(), makeTestRow({ id: otherId })],
        nextCursor: null,
      });
      repo.findAudiencesByTestIds.mockResolvedValue(byTest(makeAudience()));
      repo.countFormQuestionsByTestIds.mockResolvedValue(byTest(2));
      buildsRepo.findLatestBuildsByTestIds.mockResolvedValue(
        byTest({ build: makeBuild({ status: 'validated' }), steps: makeSteps('ready') }),
      );

      const { data } = await service.listByGame(ORG, GAME_ID, {
        tab: 'active',
        limit: 20,
      } as never);

      for (const batch of [
        repo.findAudiencesByTestIds,
        repo.countFormQuestionsByTestIds,
        buildsRepo.findLatestBuildsByTestIds,
      ]) {
        expect(batch).toHaveBeenCalledTimes(1);
        expect(batch).toHaveBeenCalledWith([TEST_ID, otherId], undefined);
      }
      expect(repo.findFormQuestions).not.toHaveBeenCalled();
      expect(buildsRepo.findLatestBuild).not.toHaveBeenCalled();
      // Each view gets its own test's data, nothing borrowed from a neighbour.
      expect(data[0]).toMatchObject({ pendingValidations: [], build: { id: BUILD_ID } });
      expect(data[0].audience).not.toBeNull();
      expect(data[1]).toMatchObject({ audience: null, build: null });
      expect(data[1].pendingValidations.map((p) => p.code)).toEqual([
        'FORM_EMPTY',
        'BUILD_NOT_VALIDATED',
        'AUDIENCE_NOT_CONFIGURED',
      ]);
    });

    it('skips the lookups entirely for an empty page', async () => {
      repo.listByGameInOrg.mockResolvedValue({ data: [], nextCursor: null });

      const { data } = await service.listByGame(ORG, GAME_ID, {
        tab: 'active',
        limit: 20,
      } as never);

      expect(data).toEqual([]);
      expect(repo.findAudiencesByTestIds).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('fetches each input of the view once (the publish gate no longer re-reads them)', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      readyToPublish();

      const view = await service.get(ORG, TEST_ID);

      expect(view.pendingValidations).toEqual([]);
      expect(repo.findAudiencesByTestIds).toHaveBeenCalledTimes(1);
      expect(repo.countFormQuestionsByTestIds).toHaveBeenCalledTimes(1);
      expect(buildsRepo.findLatestBuildsByTestIds).toHaveBeenCalledTimes(1);
      expect(buildsRepo.findLatestBuild).not.toHaveBeenCalled();
    });

    it('keeps the failed build reason as the BUILD_NOT_VALIDATED message for the owning studio', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      buildsRepo.findLatestBuildsByTestIds.mockResolvedValue(
        byTest({
          build: makeBuild({ status: 'failed', failureReason: 'Ameaça detectada: X' }),
          steps: makeSteps('failed'),
        }),
      );

      const view = await service.get(ORG, TEST_ID);

      expect(view.pendingValidations).toContainEqual({
        step: 3,
        code: 'BUILD_NOT_VALIDATED',
        message: 'Ameaça detectada: X',
      });
    });
  });

  describe('setModel', () => {
    it('refuses to edit a published test', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ status: 'published' }));
      await expect(
        service.setModel(ORG, TEST_ID, { testModelKey: 'ab_test' }, req),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('never regresses currentStep past where the wizard already reached', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ currentStep: 'audience' }));
      repo.updateByIdInOrg.mockResolvedValue(makeTestRow({ currentStep: 'audience' }));

      await service.setModel(ORG, TEST_ID, { testModelKey: 'ab_test' }, req);

      expect(repo.updateByIdInOrg).toHaveBeenCalledWith(
        ORG,
        TEST_ID,
        expect.objectContaining({ currentStep: 'audience' }),
      );
    });
  });

  describe('putForm', () => {
    it('persists the full question set and advances the step pointer to build', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ currentStep: 'form' }));
      repo.replaceForm.mockResolvedValue([
        {
          id: 'q1',
          testId: TEST_ID,
          type: 'open_text',
          label: 'O que achou?',
          helpText: null,
          required: true,
          position: 0,
          scaleMin: null,
          scaleMax: null,
          scaleMinLabel: null,
          scaleMaxLabel: null,
          options: [],
        },
      ]);

      const view = await service.putForm(
        ORG,
        TEST_ID,
        [{ type: 'open_text', prompt: 'O que achou?', required: true, position: 0 }],
        req,
      );

      expect(view.questions).toHaveLength(1);
      expect(repo.updateByIdInOrg).toHaveBeenCalledWith(
        ORG,
        TEST_ID,
        expect.objectContaining({ currentStep: 'build' }),
      );
    });

    it('returns the scale end markers saved with a scale question', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ currentStep: 'form' }));
      repo.replaceForm.mockResolvedValue([
        {
          id: 'q1',
          testId: TEST_ID,
          type: 'scale',
          label: 'Gostou da paleta de cor?',
          helpText: null,
          required: false,
          position: 0,
          scaleMin: 1,
          scaleMax: 5,
          scaleMinLabel: 'Nada',
          scaleMaxLabel: 'Muito',
          options: [],
        },
      ]);

      const view = await service.putForm(
        ORG,
        TEST_ID,
        [
          {
            type: 'scale',
            prompt: 'Gostou da paleta de cor?',
            required: false,
            position: 0,
            scaleMin: 1,
            scaleMax: 5,
            scaleMinLabel: 'Nada',
            scaleMaxLabel: 'Muito',
          },
        ],
        req,
      );

      expect(view.questions[0]).toMatchObject({ scaleMinLabel: 'Nada', scaleMaxLabel: 'Muito' });
    });
  });

  describe('setBuildSettings', () => {
    it('stores whether the build is playable with a gamepad', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ currentStep: 'build' }));
      repo.updateByIdInOrg.mockResolvedValue(
        makeTestRow({ currentStep: 'build', gamepadSupported: true }),
      );

      const view = await service.setBuildSettings(ORG, TEST_ID, { gamepadSupported: true }, req);

      expect(view.gamepadSupported).toBe(true);
      expect(repo.updateByIdInOrg).toHaveBeenCalledWith(
        ORG,
        TEST_ID,
        expect.objectContaining({ gamepadSupported: true }),
      );
    });

    it('refuses to change a published test', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ status: 'published' }));
      await expect(
        service.setBuildSettings(ORG, TEST_ID, { gamepadSupported: true }, req),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('setAudience', () => {
    it('stores the player tier and the boost with the audience', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ currentStep: 'audience' }));
      repo.updateByIdInOrg.mockResolvedValue(
        makeTestRow({ currentStep: 'review', durationDays: 30 }),
      );
      repo.countEligiblePlayers.mockResolvedValue(40);
      repo.findAudiencesByTestIds.mockResolvedValue(
        byTest(makeAudience({ playerTier: 'experienced', boosted: true, testerCount: 750 })),
      );

      const view = await service.setAudience(
        ORG,
        TEST_ID,
        {
          ageMin: 18,
          ageMax: 40,
          quantity: 750,
          durationDays: 30,
          keepActive: false,
          playerTier: 'experienced',
          boosted: true,
        },
        req,
      );

      expect(repo.upsertAudience).toHaveBeenCalledWith(
        TEST_ID,
        expect.objectContaining({ playerTier: 'experienced', boosted: true, estimatedReach: 40 }),
        undefined,
      );
      expect(view.audience).toMatchObject({ playerTier: 'experienced', boosted: true });
    });

    it('opens one slot per requested tester (slots_total = quantity)', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ currentStep: 'audience' }));
      repo.updateByIdInOrg.mockResolvedValue(
        makeTestRow({ currentStep: 'review', slotsTotal: 25 }),
      );
      repo.countEligiblePlayers.mockResolvedValue(10);
      repo.findAudiencesByTestIds.mockResolvedValue(byTest(makeAudience({ testerCount: 25 })));

      const view = await service.setAudience(
        ORG,
        TEST_ID,
        {
          ageMin: 18,
          ageMax: 40,
          quantity: 25,
          durationDays: 14,
          keepActive: false,
          playerTier: 'all',
          boosted: false,
        },
        req,
      );

      expect(repo.updateByIdInOrg).toHaveBeenCalledWith(
        ORG,
        TEST_ID,
        expect.objectContaining({ slotsTotal: 25, durationDays: 14 }),
      );
      expect(view.spotsTotal).toBe(25);
    });
  });

  describe('confirmBuild', () => {
    const newKey = buildBuildStorageKey(ORG, TEST_ID, OTHER_BUILD_ID, 'game.zip');

    it('checks storage before taking the row lock, so no lock is held across the HEAD', async () => {
      storage.stat.mockResolvedValue(null);

      await expect(
        service.confirmBuild(ORG, TEST_ID, { storageKey: newKey, platform: 'windows' }, req),
      ).rejects.toMatchObject({ status: 422 });
      expect(repo.withRowLock).not.toHaveBeenCalled();
    });

    it('refuses a key shaped like the validated copy (a raw `/` in the file name)', async () => {
      const storageKey = validatedBuildStorageKey(ORG, TEST_ID, BUILD_ID, 'game.zip');

      await expect(
        service.confirmBuild(ORG, TEST_ID, { storageKey, platform: 'windows' }, req),
      ).rejects.toMatchObject({ status: 422 });
      expect(storage.stat).not.toHaveBeenCalled();
    });

    it('replaces a failed build and removes its objects — upload and validated copy', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      const failed = makeBuild({ status: 'failed' });
      buildsRepo.findLatestBuild.mockResolvedValue({ build: failed, steps: makeSteps('failed') });
      storage.stat.mockResolvedValue({ sizeBytes: 2048, contentType: 'application/zip' });
      buildsRepo.createBuildWithSteps.mockResolvedValue({
        build: makeBuild({ id: OTHER_BUILD_ID, status: 'processing', storageKey: newKey }),
        steps: makeSteps('processing'),
      });

      await service.confirmBuild(ORG, TEST_ID, { storageKey: newKey, platform: 'windows' }, req);

      expect(buildsRepo.deleteBuild).toHaveBeenCalledWith(BUILD_ID, undefined);
      const removed = storage.remove.mock.calls.map(([key]) => key as string);
      expect(removed.sort()).toEqual(
        [failed.storageKey, validatedBuildStorageKey(ORG, TEST_ID, BUILD_ID, 'game.zip')].sort(),
      );
      expect(removed).not.toContain(newKey);
    });

    it("keeps the upload when a retry re-confirms the failed build's own key (only its stale copy goes)", async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      const failed = makeBuild({ status: 'failed' });
      buildsRepo.findLatestBuild.mockResolvedValue({ build: failed, steps: makeSteps('failed') });
      storage.stat.mockResolvedValue({ sizeBytes: 2048, contentType: 'application/zip' });
      buildsRepo.createBuildWithSteps.mockResolvedValue({
        build: makeBuild({ status: 'processing' }),
        steps: makeSteps('processing'),
      });

      await service.confirmBuild(
        ORG,
        TEST_ID,
        { storageKey: failed.storageKey, platform: 'windows' },
        req,
      );

      expect(storage.remove.mock.calls).toEqual([
        [validatedBuildStorageKey(ORG, TEST_ID, BUILD_ID, 'game.zip')],
      ]);
      // The copy is gone before the job could reuse it.
      expect(storage.remove.mock.invocationCallOrder[0]).toBeLessThan(
        queue.ensureEnqueued.mock.invocationCallOrder[0],
      );
    });

    it('rejects a storageKey that does not belong to this test', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      await expect(
        service.confirmBuild(
          ORG,
          TEST_ID,
          { storageKey: 'not/a/valid/key', platform: 'windows' },
          req,
        ),
      ).rejects.toMatchObject({ status: 422 });
    });

    it('conflicts when a non-failed build already exists for the test', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      storage.stat.mockResolvedValue({ sizeBytes: 2048, contentType: 'application/zip' });
      buildsRepo.findLatestBuild.mockResolvedValue({
        build: makeBuild({ status: 'processing' }),
        steps: makeSteps('processing'),
      } satisfies BuildWithSteps);

      await expect(
        service.confirmBuild(
          ORG,
          TEST_ID,
          {
            storageKey: `orgs/${ORG}/tests/${TEST_ID}/builds/${OTHER_BUILD_ID}/game.zip`,
            platform: 'windows',
          },
          req,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('deletes the oversized object from storage before rejecting it (SEC-06)', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      buildsRepo.findLatestBuild.mockResolvedValue(null);
      storage.stat.mockResolvedValue({
        sizeBytes: MAX_BUILD_BYTES + 1,
        contentType: 'application/zip',
      });
      const storageKey = `orgs/${ORG}/tests/${TEST_ID}/builds/${BUILD_ID}/game.zip`;

      await expect(
        service.confirmBuild(ORG, TEST_ID, { storageKey, platform: 'windows' }, req),
      ).rejects.toMatchObject({ status: 422 });

      expect(storage.remove).toHaveBeenCalledWith(storageKey);
      expect(buildsRepo.createBuildWithSteps).not.toHaveBeenCalled();
    });

    it('enqueues build.validate and returns 202-shaped processing state on success', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      buildsRepo.findLatestBuild.mockResolvedValue(null);
      storage.stat.mockResolvedValue({ sizeBytes: 2048, contentType: 'application/zip' });
      buildsRepo.createBuildWithSteps.mockResolvedValue({
        build: makeBuild({ status: 'processing' }),
        steps: makeSteps('processing'),
      });

      const view = await service.confirmBuild(
        ORG,
        TEST_ID,
        {
          storageKey: `orgs/${ORG}/tests/${TEST_ID}/builds/${BUILD_ID}/game.zip`,
          platform: 'windows',
        },
        req,
      );

      expect(view.status).toBe('processing');
      expect(queue.ensureEnqueued).toHaveBeenCalledWith(
        'build.validate',
        `build-validate-${BUILD_ID}`,
        { buildId: BUILD_ID },
        // A reconfirmed failed build reuses its id: its finished job must run again.
        { rerunCompleted: true },
      );
    });

    it('marks the build failed instead of leaving it stuck in "processing" when enqueueing fails (OPS-01)', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      buildsRepo.findLatestBuild.mockResolvedValue(null);
      storage.stat.mockResolvedValue({ sizeBytes: 2048, contentType: 'application/zip' });
      buildsRepo.createBuildWithSteps.mockResolvedValue({
        build: makeBuild({ status: 'processing' }),
        steps: makeSteps('processing'),
      });
      queue.ensureEnqueued.mockRejectedValue(new Error('redis unreachable'));
      buildsRepo.markBuildFailed.mockResolvedValue(makeBuild({ status: 'failed' }));

      const view = await service.confirmBuild(
        ORG,
        TEST_ID,
        {
          storageKey: `orgs/${ORG}/tests/${TEST_ID}/builds/${BUILD_ID}/game.zip`,
          platform: 'windows',
        },
        req,
      );

      expect(buildsRepo.markBuildFailed).toHaveBeenCalledWith(BUILD_ID, expect.any(String));
      expect(view.status).toBe('failed');
    });
  });

  describe('deleteBuild', () => {
    it('removes both the validated copy and the upload (it can be re-PUT while its URL lives)', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ currentStep: 'audience' }));
      const copyKey = validatedBuildStorageKey(ORG, TEST_ID, BUILD_ID, 'game.zip');
      buildsRepo.findLatestBuild.mockResolvedValue({
        build: makeBuild({ status: 'validated', storageKey: copyKey }),
        steps: makeSteps('ready'),
      });

      await service.deleteBuild(ORG, TEST_ID, req);

      const removed = storage.remove.mock.calls.map(([key]) => key as string);
      expect(removed.sort()).toEqual(
        [copyKey, buildBuildStorageKey(ORG, TEST_ID, BUILD_ID, 'game.zip')].sort(),
      );
      // …and the unpacked web build, if it had one.
      expect(storage.removePrefix).toHaveBeenCalledWith(webBuildPrefix(ORG, TEST_ID, BUILD_ID));
    });

    it('still succeeds when storage cleanup fails (best-effort)', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      buildsRepo.findLatestBuild.mockResolvedValue({ build: makeBuild(), steps: makeSteps() });
      storage.remove.mockRejectedValue(new Error('minio down'));
      storage.removePrefix.mockRejectedValue(new Error('minio down'));

      await expect(service.deleteBuild(ORG, TEST_ID, req)).resolves.toBeUndefined();
      expect(buildsRepo.deleteBuild).toHaveBeenCalledWith(BUILD_ID, undefined);
    });
  });

  describe('publish', () => {
    it('requires the Idempotency-Key header', async () => {
      await expect(service.publish(ORG, TEST_ID, undefined, req)).rejects.toMatchObject({
        status: 422,
      });
    });

    it('lists pendingValidations when a step is incomplete', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      // form still empty: countFormQuestionsByTestIds has no entry for the test

      await expect(service.publish(ORG, TEST_ID, 'idem-1', req)).rejects.toMatchObject({
        status: 422,
      });
    });

    it('publishes once every step is complete and sets startsAt/endsAt', async () => {
      const draft = makeTestRow({ durationDays: 7 });
      repo.getByIdInOrgOrThrow.mockResolvedValue(draft);
      readyToPublish();
      repo.updateByIdInOrg.mockImplementation((_org, _id, patch) =>
        Promise.resolve({ ...draft, ...patch }),
      );

      const view = await service.publish(ORG, TEST_ID, 'idem-1', req);

      expect(view.status).toBe('published');
      expect(repo.updateByIdInOrg).toHaveBeenCalledWith(
        ORG,
        TEST_ID,
        expect.objectContaining({ status: 'published', publishIdempotencyKey: 'idem-1' }),
      );
      const drafts = drainAuditDrafts(req);
      expect(drafts[0]).toMatchObject({ action: 'test.published' });
    });

    it('publishes an ab_test_images test with no build at all (GAP-03)', async () => {
      const draft = makeTestRow({ modelKey: 'ab_test_images', durationDays: 7 });
      repo.getByIdInOrgOrThrow.mockResolvedValue(draft);
      repo.countFormQuestionsByTestIds.mockResolvedValue(byTest(1));
      // no build ever uploaded: findLatestBuildsByTestIds stays empty
      repo.findAudiencesByTestIds.mockResolvedValue(byTest(makeAudience()));
      repo.updateByIdInOrg.mockImplementation((_org, _id, patch) =>
        Promise.resolve({ ...draft, ...patch }),
      );

      const view = await service.publish(ORG, TEST_ID, 'idem-1', req);

      expect(view.status).toBe('published');
      expect(view.pendingValidations).toEqual([]);
    });

    it('replays the current state instead of re-publishing when already published', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ status: 'published' }));

      const view = await service.publish(ORG, TEST_ID, 'any-key', req);

      expect(view.status).toBe('published');
      expect(repo.updateByIdInOrg).not.toHaveBeenCalled();
    });

    it('replays the current state when the unique violation arrives wrapped in a Drizzle error (code on .cause, not top-level)', async () => {
      const draft = makeTestRow({ durationDays: 7 });
      repo.getByIdInOrgOrThrow
        .mockResolvedValueOnce(draft)
        .mockResolvedValueOnce(makeTestRow({ status: 'published', durationDays: 7 }));
      readyToPublish();
      repo.updateByIdInOrg.mockRejectedValue(
        wrappedUniqueViolation('tests_publish_idempotency_key_unique'),
      );

      const view = await service.publish(ORG, TEST_ID, 'idem-1', req);

      expect(view.status).toBe('published');
      expect(repo.getByIdInOrgOrThrow).toHaveBeenCalledTimes(2);
    });

    it('409s, instead of a 200 carrying the draft, when the key was already spent on another test', async () => {
      const draft = makeTestRow({ durationDays: 7 });
      repo.getByIdInOrgOrThrow.mockResolvedValue(draft); // still a draft after the rollback
      readyToPublish();
      repo.updateByIdInOrg.mockRejectedValue(
        wrappedUniqueViolation('tests_publish_idempotency_key_unique'),
      );

      await expect(service.publish(ORG, TEST_ID, 'used-elsewhere', req)).rejects.toMatchObject({
        status: 409,
      });
      expect(drainAuditDrafts(req)).toEqual([]);
    });

    it('does not take any other unique violation for a publish replay', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow({ durationDays: 7 }));
      readyToPublish();
      const other = wrappedUniqueViolation('some_other_unique');
      repo.updateByIdInOrg.mockRejectedValue(other);

      await expect(service.publish(ORG, TEST_ID, 'idem-1', req)).rejects.toBe(other);
      expect(repo.getByIdInOrgOrThrow).toHaveBeenCalledTimes(1);
    });

    it("reads the publish gate's inputs on the row lock's transaction, and reuses them for the view", async () => {
      const draft = makeTestRow({ durationDays: 7 });
      const tx = { sentinel: 'tx' };
      repo.withRowLock.mockImplementation(async (_org, _id, fn) =>
        fn(draft, (patch: unknown) => Promise.resolve({ ...draft, ...(patch as object) }), tx),
      );
      readyToPublish();

      const view = await service.publish(ORG, TEST_ID, 'idem-1', req);

      expect(view.status).toBe('published');
      expect(repo.findAudiencesByTestIds).toHaveBeenCalledTimes(1);
      expect(repo.findAudiencesByTestIds).toHaveBeenCalledWith([TEST_ID], tx);
      expect(buildsRepo.findLatestBuildsByTestIds).toHaveBeenCalledWith([TEST_ID], tx);
      expect(repo.countFormQuestionsByTestIds).toHaveBeenCalledWith([TEST_ID], tx);
    });
  });

  describe('setStatus', () => {
    it.each([
      ['draft', 'paused'],
      ['finished', 'published'],
      ['paused', 'paused'],
    ])('rejects the %s -> %s transition with 409', async (from, to) => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(
        makeTestRow({ status: from as TestRow['status'] }),
      );
      await expect(
        service.setStatus(ORG, TEST_ID, { status: to as never }, req),
      ).rejects.toMatchObject({ status: 409 });
    });

    it.each([
      ['published', 'paused'],
      ['paused', 'published'],
      ['published', 'finished'],
    ])('allows the %s -> %s transition', async (from, to) => {
      const row = makeTestRow({ status: from as TestRow['status'] });
      repo.getByIdInOrgOrThrow.mockResolvedValue(row);
      repo.updateByIdInOrg.mockResolvedValue({ ...row, status: to as TestRow['status'] });

      const view = await service.setStatus(ORG, TEST_ID, { status: to as never }, req);
      expect(view.status).toBe(to);
    });
  });
});
