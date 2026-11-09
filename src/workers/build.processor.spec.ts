import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { builds, buildValidationSteps, type BuildRow } from '../infra/database/schema/tests';
import { buildBuildStorageKey, validatedBuildStorageKey } from '../modules/tests/storage-key';
import type { MalwareScannerPort, ScanResult } from '../shared/ports/malware-scanner.port';
import type { StoragePort } from '../shared/ports/storage.port';
import { processBuildValidate } from './build.processor';
import type { WorkerDeps } from './deps';

const ORG_ID = '01920000-0000-7000-8000-0000000000a1';
const TEST_ID = '01920000-0000-7000-8000-0000000000c1';
const BUILD_ID = '01920000-0000-7000-8000-0000000000b1';
const UPLOAD_KEY = buildBuildStorageKey(ORG_ID, TEST_ID, BUILD_ID, 'game.exe');
const VALIDATED_KEY = validatedBuildStorageKey(ORG_ID, TEST_ID, BUILD_ID, 'game.exe');

const EXE = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64)]);
/** Same size as EXE (the presigned PUT signs Content-Length), other bytes. */
const SWAPPED = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.alloc(64, 0x66)]);

/** A fake `WorkerDeps.db` covering just the select/update chains the processor uses. */
function makeFakeDb(row: Partial<BuildRow>, opts: { rowGone?: boolean } = {}) {
  const buildUpdates: Record<string, unknown>[] = [];
  const stepUpdates: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [
            {
              id: BUILD_ID,
              organizationId: ORG_ID,
              testId: TEST_ID,
              storageKey: UPLOAD_KEY,
              fileName: 'game.exe',
              checksum: null,
              status: 'processing',
              ...row,
            },
          ],
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        if (table === builds) buildUpdates.push(patch);
        if (table === buildValidationSteps) stepUpdates.push(patch);
        // Awaitable like a Drizzle builder, plus the `.returning()` the approve write uses.
        return {
          where: () =>
            Object.assign(Promise.resolve(undefined), {
              returning: async () => (opts.rowGone ? [] : [{ id: BUILD_ID }]),
            }),
        };
      },
    }),
  };
  return { db: db as unknown as WorkerDeps['db'], buildUpdates, stepUpdates };
}

/** In-memory bucket: copies are real copies, so a later write to the source can't reach them. */
function makeMemoryStorage(initial: Record<string, Buffer>) {
  const objects = new Map(Object.entries(initial));
  const copies: [string, string][] = [];
  const reads: string[] = [];
  const removed: string[] = [];
  const storage: Partial<StoragePort> = {
    stat: async (key) => {
      const body = objects.get(key);
      return body ? { contentType: 'application/x-msdownload', sizeBytes: body.length } : null;
    },
    copyObject: async (source, dest) => {
      const body = objects.get(source);
      if (!body) throw new Error('NoSuchKey');
      objects.set(dest, Buffer.from(body));
      copies.push([source, dest]);
    },
    getObjectStream: async (key) => {
      reads.push(key);
      const body = objects.get(key);
      if (!body) throw new Error('NoSuchKey');
      return Readable.from([body]);
    },
    remove: async (key) => {
      objects.delete(key);
      removed.push(key);
    },
  };
  return { storage, objects, copies, reads, removed };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function makeDeps(
  scan: ScanResult,
  opts: {
    row?: Partial<BuildRow>;
    objects?: Record<string, Buffer>;
    rowGone?: boolean;
  } = {},
) {
  const fake = makeFakeDb(opts.row ?? {}, { rowGone: opts.rowGone });
  const memory = makeMemoryStorage(opts.objects ?? { [UPLOAD_KEY]: EXE });
  const scanned: Buffer[] = [];
  const scanner: MalwareScannerPort = {
    scan: async (stream) => {
      scanned.push(await readAll(stream));
      return scan;
    },
  };
  const deps = { db: fake.db, storage: memory.storage, scanner } as WorkerDeps;
  return { deps, scanned, ...fake, ...memory };
}

const CLEAN: ScanResult = { verdict: 'clean', engine: 'ClamAV 1.4.1', signatures: '27500' };

describe('processBuildValidate', () => {
  it('validates the build and records the engine when the scan is clean', async () => {
    const { deps, buildUpdates, stepUpdates } = makeDeps(CLEAN);

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates).toContainEqual(
      expect.objectContaining({ scanEngine: 'ClamAV 1.4.1', scanSignatures: '27500' }),
    );
    expect(buildUpdates.at(-1)).toEqual({
      status: 'validated',
      failureReason: null,
      storageKey: VALIDATED_KEY,
      sizeBytes: EXE.length,
    });
    expect(stepUpdates.at(-1)).toMatchObject({ status: 'ready' });
  });

  it('hashes and scans only the server-side copy, then serves it and drops the upload', async () => {
    const { deps, copies, reads, objects } = makeDeps(CLEAN);

    await processBuildValidate(deps, BUILD_ID);

    expect(copies).toEqual([[UPLOAD_KEY, VALIDATED_KEY]]);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((key) => key === VALIDATED_KEY)).toBe(true);
    expect(objects.has(UPLOAD_KEY)).toBe(false);
    expect(objects.get(VALIDATED_KEY)?.equals(EXE)).toBe(true);
  });

  it('a re-PUT through the still-live upload URL after the copy never reaches the scan or the served key', async () => {
    const { deps, objects, scanned, buildUpdates } = makeDeps(CLEAN);
    const copy = deps.storage.copyObject.bind(deps.storage);
    deps.storage.copyObject = async (source, dest) => {
      await copy(source, dest);
      objects.set(UPLOAD_KEY, SWAPPED); // the studio swaps the bytes right after the copy
    };

    await processBuildValidate(deps, BUILD_ID);

    expect(scanned).toHaveLength(1);
    expect(scanned[0].equals(EXE)).toBe(true);
    expect(objects.get(VALIDATED_KEY)?.equals(EXE)).toBe(true);
    expect(buildUpdates.at(-1)).toMatchObject({ status: 'validated', storageKey: VALIDATED_KEY });
  });

  it('reuses an existing copy on redelivery instead of copying the upload again', async () => {
    const { deps, copies, scanned } = makeDeps(CLEAN, {
      objects: { [UPLOAD_KEY]: SWAPPED, [VALIDATED_KEY]: EXE },
    });

    await processBuildValidate(deps, BUILD_ID);

    expect(copies).toEqual([]);
    expect(scanned[0].equals(EXE)).toBe(true);
  });

  it('validates the copy the row already points at, with no upload left to copy', async () => {
    const { deps, copies, removed, buildUpdates } = makeDeps(CLEAN, {
      row: { storageKey: VALIDATED_KEY },
      objects: { [VALIDATED_KEY]: EXE },
    });

    await processBuildValidate(deps, BUILD_ID);

    expect(copies).toEqual([]);
    expect(removed).toEqual([]);
    expect(buildUpdates.at(-1)).toMatchObject({ status: 'validated', storageKey: VALIDATED_KEY });
  });

  it('does nothing when redelivered after it already approved the copy', async () => {
    const { deps, reads, buildUpdates, stepUpdates } = makeDeps(CLEAN, {
      row: { status: 'validated', storageKey: VALIDATED_KEY },
      objects: { [VALIDATED_KEY]: EXE },
    });

    await processBuildValidate(deps, BUILD_ID);

    expect(reads).toEqual([]);
    expect(buildUpdates).toEqual([]);
    expect(stepUpdates).toEqual([]);
  });

  it('fails the build when neither the upload nor a copy exists', async () => {
    const { deps, buildUpdates } = makeDeps(CLEAN, { objects: {} });

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates.at(-1)).toMatchObject({
      status: 'failed',
      failureReason: 'Arquivo não encontrado no storage',
    });
  });

  it('removes the copy when the build row was deleted mid-run', async () => {
    const { deps, objects } = makeDeps(CLEAN, { rowGone: true });

    await processBuildValidate(deps, BUILD_ID);

    expect(objects.size).toBe(0);
  });

  it('fails the build, without retry, when a threat is found — and keeps serving nothing new', async () => {
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
    expect(buildUpdates.some((u) => 'storageKey' in u)).toBe(false);
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
    const { deps, buildUpdates, objects } = makeDeps({ verdict: 'error', reason: 'ECONNREFUSED' });

    await expect(processBuildValidate(deps, BUILD_ID)).rejects.toThrow(/indisponível/);

    expect(buildUpdates.some((u) => u.status === 'validated')).toBe(false);
    expect(buildUpdates.some((u) => u.status === 'failed')).toBe(false);
    // The retry reuses this copy (see the redelivery case above).
    expect(objects.has(VALIDATED_KEY)).toBe(true);
  });

  it('marks the step as skipped (never clean) with the dev scanner', async () => {
    const { deps, buildUpdates, stepUpdates } = makeDeps({ verdict: 'skipped' });

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates.at(-1)).toMatchObject({ status: 'validated', failureReason: null });
    expect(stepUpdates.at(-1)).toMatchObject({
      status: 'ready',
      message: expect.stringContaining('PULADA'),
    });
  });

  it('still rejects a file whose bytes do not match its extension', async () => {
    const { deps, buildUpdates } = makeDeps(CLEAN, {
      objects: { [UPLOAD_KEY]: Buffer.from('not an exe') },
    });

    await processBuildValidate(deps, BUILD_ID);

    expect(buildUpdates.at(-1)).toMatchObject({ status: 'failed' });
  });
});
