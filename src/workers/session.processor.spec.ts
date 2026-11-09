import { describe, expect, it, vi } from 'vitest';
import {
  sessionRecordings,
  sessions,
  sessionValidations,
} from '../infra/database/schema/participations';
import type { SessionRow } from '../infra/database/schema/participations';
import { tests } from '../infra/database/schema/tests';
import type { WorkerDeps } from './deps';
import {
  decideSessionVerdict,
  INVALID_REASONS,
  MIN_VALID_SESSION_MS,
  processSessionValidate,
} from './session.processor';

const NOW = new Date('2026-11-09T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function makeSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: '01990000-0000-7000-8000-0000000000a3',
    participationId: '01990000-0000-7000-8000-0000000000a2',
    testId: '01990000-0000-7000-8000-0000000000a1',
    organizationId: '01990000-0000-7000-8000-0000000000a0',
    status: 'processing',
    startedAt: minutesAgo(30),
    endedAt: minutesAgo(5),
    durationMs: 20 * 60_000,
    finishIdempotencyKey: null,
    ...overrides,
  };
}

type Recording = { kind: 'screen' | 'webcam' | 'microphone'; status: string };

/** Fake `db.select()` answering per table; `transaction` must never run in these cases. */
function fakeDeps(data: {
  recordings?: Recording[];
  modelKey?: string;
  session?: SessionRow;
  validated?: boolean;
}) {
  const byTable = new Map<unknown, unknown[]>([
    [sessionRecordings, data.recordings ?? []],
    [tests, [{ modelKey: data.modelKey ?? 'free_exploration' }]],
    [sessions, data.session ? [data.session] : []],
    [sessionValidations, data.validated ? [{ sessionId: data.session?.id }] : []],
  ]);
  const transaction = vi.fn();
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows = byTable.get(table) ?? [];
          return Object.assign(Promise.resolve(rows), { limit: () => Promise.resolve(rows) });
        },
      }),
    }),
    transaction,
  };
  return { deps: { db } as unknown as WorkerDeps, transaction };
}

const decide = (session: SessionRow, data: Parameters<typeof fakeDeps>[0] = {}) =>
  decideSessionVerdict(fakeDeps(data).deps, session, NOW);

describe('decideSessionVerdict', () => {
  it('rejects a heartbeat timeout', async () => {
    await expect(decide(makeSession({ status: 'invalidated' }))).resolves.toEqual({
      valid: false,
      reason: INVALID_REASONS.timeout,
    });
  });

  it(`rejects a session shorter than ${MIN_VALID_SESSION_MS} ms, and one without duration`, async () => {
    await expect(decide(makeSession({ durationMs: MIN_VALID_SESSION_MS - 1 }))).resolves.toEqual({
      valid: false,
      reason: INVALID_REASONS.tooShort,
    });
    await expect(decide(makeSession({ durationMs: null }))).resolves.toEqual({
      valid: false,
      reason: INVALID_REASONS.noDuration,
    });
  });

  it('accepts exactly the minimum with a ready screen recording', async () => {
    await expect(
      decide(makeSession({ durationMs: MIN_VALID_SESSION_MS }), {
        recordings: [{ kind: 'screen', status: 'ready' }],
      }),
    ).resolves.toEqual({ valid: true, reason: null });
  });

  it('rejects when any recording failed, even next to a ready one', async () => {
    await expect(
      decide(makeSession(), {
        recordings: [
          { kind: 'screen', status: 'ready' },
          { kind: 'webcam', status: 'failed' },
        ],
      }),
    ).resolves.toEqual({ valid: false, reason: INVALID_REASONS.recordingFailed });
  });

  it('waits while a recording is still processing', async () => {
    await expect(
      decide(makeSession(), { recordings: [{ kind: 'screen', status: 'processing' }] }),
    ).resolves.toBe('deferred');
  });

  it('waits for a required recording within the upload window, then rejects its absence', async () => {
    await expect(decide(makeSession({ endedAt: minutesAgo(119) }))).resolves.toBe('deferred');
    await expect(decide(makeSession({ endedAt: minutesAgo(121) }))).resolves.toEqual({
      valid: false,
      reason: INVALID_REASONS.recordingMissing,
    });
  });

  it('only a screen recording satisfies a required screen recording', async () => {
    await expect(
      decide(makeSession({ endedAt: minutesAgo(121) }), {
        recordings: [{ kind: 'webcam', status: 'ready' }],
      }),
    ).resolves.toEqual({ valid: false, reason: INVALID_REASONS.recordingMissing });
  });

  it('stops waiting for a recording stuck in processing after the deadline', async () => {
    await expect(
      decide(makeSession({ endedAt: minutesAgo(25 * 60) }), {
        recordings: [{ kind: 'screen', status: 'processing' }],
      }),
    ).resolves.toEqual({ valid: false, reason: INVALID_REASONS.recordingNotProcessed });
  });

  it('does not ask for a recording when the model requires none', async () => {
    await expect(decide(makeSession(), { modelKey: 'ab_test_images' })).resolves.toEqual({
      valid: true,
      reason: null,
    });
  });
});

describe('processSessionValidate', () => {
  it('never judges a session that is still being played', async () => {
    const session = makeSession({ status: 'recording', endedAt: null, durationMs: null });
    const { deps, transaction } = fakeDeps({ session });

    await expect(processSessionValidate(deps, session.id, NOW)).resolves.toBe('deferred');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('writes nothing while the verdict waits for the recording', async () => {
    const session = makeSession();
    const { deps, transaction } = fakeDeps({ session });

    await expect(processSessionValidate(deps, session.id, NOW)).resolves.toBe('deferred');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('is a no-op once the session has a verdict', async () => {
    const session = makeSession();
    const { deps, transaction } = fakeDeps({ session, validated: true });

    await expect(processSessionValidate(deps, session.id, NOW)).resolves.toBe('already-validated');
    expect(transaction).not.toHaveBeenCalled();
  });
});
