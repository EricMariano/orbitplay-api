import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { builds, buildValidationSteps } from '../infra/database/schema/tests';
import type { MalwareScannerPort, ScanResult } from '../shared/ports/malware-scanner.port';
import type { StoragePort } from '../shared/ports/storage.port';
import { processBuildValidate } from './build.processor';
import type { WorkerDeps } from './deps';

const BUILD_ID = '01920000-0000-7000-8000-0000000000b1';

/** A fake `WorkerDeps.db` covering just the select/update chains the processor uses. */
function makeFakeDb() {
  const buildUpdates: Record<string, unknown>[] = [];
  const stepUpdates: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: BUILD_ID,
              storageKey: `orgs/o/tests/t/builds/${BUILD_ID}/game.exe`,
              fileName: 'game.exe',
              checksum: null,
            },
          ],
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        if (table === builds) buildUpdates.push(patch);
        if (table === buildValidationSteps) stepUpdates.push(patch);
        return { where: async () => undefined };
      },
    }),
  };
  return { db: db as unknown as WorkerDeps['db'], buildUpdates, stepUpdates };
}

function makeDeps(scan: ScanResult) {
  const fake = makeFakeDb();
  const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]);
  const storage: Partial<StoragePort> = {
    stat: async () => ({ contentType: 'application/x-msdownload', sizeBytes: exe.length }),
    getObjectStream: async () => Readable.from([exe]),
  };
  const scanner: MalwareScannerPort = { scan: async () => scan };
  const deps = { db: fake.db, storage, scanner } as WorkerDeps;
  return { deps, ...fake };
}

const CLEAN: ScanResult = { verdict: 'clean', engine: 'ClamAV 1.4.1', signatures: '27500' };

describe('processBuildValidate', () => {
  it('validates the build and records the engine when the scan is clean', async () => {
    const { deps, buildUpdates, stepUpdates } = makeDeps(CLEAN);

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates).toContainEqual(
      expect.objectContaining({ scanEngine: 'ClamAV 1.4.1', scanSignatures: '27500' }),
    );
    expect(buildUpdates.at(-1)).toEqual({ status: 'validated', failureReason: null });
    expect(stepUpdates.at(-1)).toMatchObject({ status: 'ready' });
  });

  it('fails the build, without retry, when a threat is found', async () => {
    const { deps, buildUpdates, stepUpdates } = makeDeps({
      verdict: 'infected',
      engine: 'ClamAV 1.4.1',
      signatures: '27500',
      threat: 'Win.Test.EICAR_HDB-1',
    });

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates.at(-1)).toMatchObject({
      status: 'failed',
      failureReason: expect.stringContaining('Win.Test.EICAR_HDB-1'),
    });
    expect(stepUpdates.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('fails the build when the scanner could not fully scan the file', async () => {
    const { deps, buildUpdates } = makeDeps({
      verdict: 'unscannable',
      engine: 'ClamAV 1.4.1',
      signatures: '27500',
      reason: 'limite',
    });

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('throws (so the job is retried) and never approves when the scanner errors', async () => {
    const { deps, buildUpdates } = makeDeps({ verdict: 'error', reason: 'ECONNREFUSED' });

    await expect(processBuildValidate(deps, BUILD_ID)).rejects.toThrow(/indisponível/);

    expect(buildUpdates.some((u) => u.status === 'validated')).toBe(false);
    expect(buildUpdates.some((u) => u.status === 'failed')).toBe(false);
  });

  it('marks the step as skipped (never clean) with the dev scanner', async () => {
    const { deps, buildUpdates, stepUpdates } = makeDeps({ verdict: 'skipped' });

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates.at(-1)).toEqual({ status: 'validated', failureReason: null });
    expect(stepUpdates.at(-1)).toMatchObject({
      status: 'ready',
      message: expect.stringContaining('PULADA'),
    });
  });

  it('still rejects a file whose bytes do not match its extension', async () => {
    const { deps, buildUpdates } = makeDeps(CLEAN);
    deps.storage.getObjectStream = async () => Readable.from([Buffer.from('not an exe')]);

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates.at(-1)).toMatchObject({ status: 'failed' });
  });
});
