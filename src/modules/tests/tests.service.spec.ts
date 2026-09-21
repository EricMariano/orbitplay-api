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
import { TestsService } from './tests.service';
import type { TestsRepository } from './tests.repository';

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
    ...overrides,
  };
}

describe('TestsService', () => {
  let repo: {
    getByIdInOrgOrThrow: ReturnType<typeof vi.fn>;
    createInOrg: ReturnType<typeof vi.fn>;
    updateByIdInOrg: ReturnType<typeof vi.fn>;
    withRowLock: ReturnType<typeof vi.fn>;
    findFormQuestions: ReturnType<typeof vi.fn>;
    replaceForm: ReturnType<typeof vi.fn>;
    findAudience: ReturnType<typeof vi.fn>;
    upsertAudience: ReturnType<typeof vi.fn>;
    countEligiblePlayers: ReturnType<typeof vi.fn>;
    listByGameInOrg: ReturnType<typeof vi.fn>;
  };
  let buildsRepo: {
    findLatestBuild: ReturnType<typeof vi.fn>;
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
      findAudience: vi.fn().mockResolvedValue(null),
      upsertAudience: vi.fn(),
      countEligiblePlayers: vi.fn().mockResolvedValue(0),
      listByGameInOrg: vi.fn(),
    };
    buildsRepo = {
      findLatestBuild: vi.fn().mockResolvedValue(null),
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
    );
    req = {} as Request;
  });

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
  });

  describe('confirmBuild', () => {
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
        `build.validate:${BUILD_ID}`,
        { buildId: BUILD_ID },
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

  describe('publish', () => {
    it('requires the Idempotency-Key header', async () => {
      await expect(service.publish(ORG, TEST_ID, undefined, req)).rejects.toMatchObject({
        status: 422,
      });
    });

    it('lists pendingValidations when a step is incomplete', async () => {
      repo.getByIdInOrgOrThrow.mockResolvedValue(makeTestRow());
      repo.findFormQuestions.mockResolvedValue([]); // form still empty

      await expect(service.publish(ORG, TEST_ID, 'idem-1', req)).rejects.toMatchObject({
        status: 422,
      });
    });

    it('publishes once every step is complete and sets startsAt/endsAt', async () => {
      const draft = makeTestRow({ durationDays: 7 });
      repo.getByIdInOrgOrThrow.mockResolvedValue(draft);
      repo.findFormQuestions.mockResolvedValue([{ id: 'q1' }]);
      buildsRepo.findLatestBuild.mockResolvedValue({
        build: makeBuild({ status: 'validated' }),
        steps: makeSteps('ready'),
      });
      repo.findAudience.mockResolvedValue(makeAudience());
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
      repo.findFormQuestions.mockResolvedValue([{ id: 'q1' }]);
      buildsRepo.findLatestBuild.mockResolvedValue(null); // no build ever uploaded
      repo.findAudience.mockResolvedValue(makeAudience());
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
      repo.findFormQuestions.mockResolvedValue([{ id: 'q1' }]);
      buildsRepo.findLatestBuild.mockResolvedValue({
        build: makeBuild({ status: 'validated' }),
        steps: makeSteps('ready'),
      });
      repo.findAudience.mockResolvedValue(makeAudience());
      // Mirrors what postgres-js + Drizzle actually throw: the top-level
      // `.code` is undefined, and the real PostgresError sits on `.cause`.
      repo.updateByIdInOrg.mockRejectedValue(
        Object.assign(new Error('duplicate key value violates unique constraint'), {
          name: 'DrizzleQueryError',
          code: undefined,
          cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
        }),
      );

      const view = await service.publish(ORG, TEST_ID, 'idem-1', req);

      expect(view.status).toBe('published');
      expect(repo.getByIdInOrgOrThrow).toHaveBeenCalledTimes(2);
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
