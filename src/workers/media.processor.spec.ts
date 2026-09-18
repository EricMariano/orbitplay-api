import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat as fsStat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionRecordingRow } from '../infra/database/schema/participations';
import type { StoragePort } from '../shared/ports/storage.port';
import { generateSampleWebm } from '../../test/helpers/sample-media';
import { processMediaExtractAudio, processMediaTranscode } from './media.processor';
import type { WorkerDeps } from './deps';

const RECORDING_ID = '01920000-0000-7000-8000-0000000000ac';

function makeRecording(overrides: Partial<SessionRecordingRow> = {}): SessionRecordingRow {
  return {
    id: RECORDING_ID,
    sessionId: '01920000-0000-7000-8000-0000000000aa',
    kind: 'screen',
    storageKey: `orgs/x/sessions/y/recordings/screen/${RECORDING_ID}`,
    contentType: 'video/webm',
    sizeBytes: 128,
    durationMs: 999, // deliberately wrong — proves the real probe overrides it
    status: 'processing',
    thumbnailKey: null,
    ...overrides,
  };
}

/** A fake `WorkerDeps.db` covering just the select/update chains the processor uses. */
function makeFakeDb(row: SessionRecordingRow) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [row],
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch);
        Object.assign(row, patch);
        return { where: async () => undefined };
      },
    }),
  };
  return { db: db as unknown as WorkerDeps['db'], updates };
}

interface PutObjectCall {
  key: string;
  body: Buffer;
  contentType: string;
}

function makeFakeStorage(sourceFilePath: string, sizeBytes: number) {
  const putObjectCalls: PutObjectCall[] = [];
  const storage: Partial<StoragePort> = {
    stat: async () => ({ contentType: 'video/webm', sizeBytes }),
    exists: async () => true,
    getObjectStream: async () => createReadStream(sourceFilePath),
    putObject: async (key: string, body: Buffer, contentType: string) => {
      putObjectCalls.push({ key, body, contentType });
    },
  };
  return { storage: storage as StoragePort, putObjectCalls };
}

describe('media.processor (real ffmpeg, GAP-04)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orbitplay-media-spec-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });

  describe('processMediaTranscode', () => {
    it('marks a valid VP8/Opus recording ready, with a real duration and a real JPEG thumbnail', async () => {
      const filePath = join(dir, 'source.webm');
      await generateSampleWebm(filePath, { durationSeconds: 2, withAudio: true });
      const { size } = await fsStat(filePath);

      const row = makeRecording();
      const { db, updates } = makeFakeDb(row);
      const { storage, putObjectCalls } = makeFakeStorage(filePath, size);
      const deps = { db, storage } as WorkerDeps;

      await processMediaTranscode(deps, RECORDING_ID);

      expect(updates).toHaveLength(1);
      expect(row.status).toBe('ready');
      // Real ffprobe duration, not the bogus 999 the row started with.
      expect(row.durationMs).toBeGreaterThan(1500);
      expect(row.durationMs).toBeLessThan(2500);
      expect(row.thumbnailKey).toBe(`${row.storageKey}.thumb.jpg`);

      const thumb = putObjectCalls.find((c) => c.key === row.thumbnailKey);
      expect(thumb).toBeTruthy();
      expect(thumb!.contentType).toBe('image/jpeg');
      // JPEG magic bytes (SOI marker) — proves this is a real image, not a stub.
      expect(thumb!.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(thumb!.body.length).toBeGreaterThan(100);
    });

    it('fails a recording whose object is not actually a video (no codec to validate)', async () => {
      const filePath = join(dir, 'not-a-video.webm');
      await writeFile(filePath, Buffer.from('this is definitely not a video file'));
      const { size } = await fsStat(filePath);

      const row = makeRecording();
      const { db } = makeFakeDb(row);
      const { storage, putObjectCalls } = makeFakeStorage(filePath, size);
      const deps = { db, storage } as WorkerDeps;

      await processMediaTranscode(deps, RECORDING_ID);

      expect(row.status).toBe('failed');
      expect(putObjectCalls).toHaveLength(0);
    });

    it('fails a recording missing from storage without touching ffmpeg', async () => {
      const row = makeRecording();
      const { db } = makeFakeDb(row);
      const storage: Partial<StoragePort> = { stat: async () => null };
      const deps = { db, storage: storage as StoragePort } as WorkerDeps;

      await processMediaTranscode(deps, RECORDING_ID);

      expect(row.status).toBe('failed');
    });
  });

  describe('processMediaExtractAudio', () => {
    it('extracts a real, separate AAC audio file — not a copy of the source bytes', async () => {
      const filePath = join(dir, 'source.webm');
      await generateSampleWebm(filePath, { durationSeconds: 1, withAudio: true });
      const { size } = await fsStat(filePath);

      const row = makeRecording();
      const { db } = makeFakeDb(row);
      const { storage, putObjectCalls } = makeFakeStorage(filePath, size);
      const deps = { db, storage } as WorkerDeps;

      await processMediaExtractAudio(deps, RECORDING_ID);

      expect(putObjectCalls).toHaveLength(1);
      const [audio] = putObjectCalls;
      expect(audio.key).toBe(`${row.storageKey}.audio`);
      expect(audio.contentType).toBe('audio/mp4');
      // Genuinely smaller than the source video and not byte-identical to
      // it — proves this is an extraction, not `copyObject`.
      expect(audio.body.length).toBeGreaterThan(0);
      expect(audio.body.length).toBeLessThan(size);
      expect(audio.body.equals(await readFile(filePath))).toBe(false);
    });

    it('skips extraction (no error, no write) when the source has no audio track', async () => {
      const filePath = join(dir, 'silent.webm');
      await generateSampleWebm(filePath, { durationSeconds: 1, withAudio: false });
      const { size } = await fsStat(filePath);

      const row = makeRecording();
      const { db } = makeFakeDb(row);
      const { storage, putObjectCalls } = makeFakeStorage(filePath, size);
      const deps = { db, storage } as WorkerDeps;

      await processMediaExtractAudio(deps, RECORDING_ID);

      expect(putObjectCalls).toHaveLength(0);
    });
  });
});
