import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { builds, buildValidationSteps } from '../infra/database/schema/tests';
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

function makeDeps(malwareScanBypass: boolean) {
  const fake = makeFakeDb();
  const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]);
  const storage: Partial<StoragePort> = {
    stat: async () => ({ contentType: 'application/x-msdownload', sizeBytes: exe.length }),
    getObjectStream: async () => Readable.from([exe]),
  };
  const deps = { db: fake.db, storage, malwareScanBypass } as WorkerDeps;
  return { deps, ...fake };
}

describe('processBuildValidate', () => {
  it('fails closed on the malware scan when no scanner is integrated', async () => {
    const { deps, buildUpdates, stepUpdates } = makeDeps(false);

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates.at(-1)).toMatchObject({ status: 'failed' });
    expect(stepUpdates.at(-1)).toMatchObject({ status: 'failed' });
  });

  it('skips the malware scan and validates the build with the dev bypass', async () => {
    const { deps, buildUpdates, stepUpdates } = makeDeps(true);

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates.at(-1)).toEqual({ status: 'validated', failureReason: null });
    expect(stepUpdates.at(-1)).toMatchObject({
      status: 'ready',
      message: expect.stringContaining('PULADA'),
    });
  });

  it('still rejects a file whose bytes do not match its extension', async () => {
    const { deps, buildUpdates } = makeDeps(true);
    deps.storage.getObjectStream = async () => Readable.from([Buffer.from('not an exe')]);

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates.at(-1)).toMatchObject({ status: 'failed' });
  });
});
