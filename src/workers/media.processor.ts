import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { eq } from 'drizzle-orm';
import { sessionRecordings } from '../infra/database/schema/participations';
import { extractedAudioKey, thumbnailKey } from '../modules/media/storage-key';
import type { WorkerDeps } from './deps';
import { extractAudioTrack, generateThumbnail, isSupportedVideoCodec, probeMedia } from './ffmpeg';

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function downloadToFile(
  deps: WorkerDeps,
  storageKey: string,
  destPath: string,
): Promise<void> {
  const stream = await deps.storage.getObjectStream(storageKey);
  await pipeline(stream, createWriteStream(destPath));
}

async function markFailed(deps: WorkerDeps, recordingId: string): Promise<void> {
  await deps.db
    .update(sessionRecordings)
    .set({ status: 'failed' })
    .where(eq(sessionRecordings.id, recordingId));
}

/**
 * Real transcode pipeline (GAP-04): downloads the object, probes it with
 * ffprobe (never trusts the client-declared content type/duration), and
 * rejects anything that isn't an actual, supported video — a corrupt upload,
 * a renamed non-media file, or a codec this pipeline doesn't recognize all
 * come back `failed` instead of silently becoming `ready`. A JPEG thumbnail
 * is generated from a real frame. Missing source object → `failed` (Tela 12
 * RN-03 lives on this row, not on the session).
 */
export async function processMediaTranscode(deps: WorkerDeps, recordingId: string): Promise<void> {
  const rows = await deps.db
    .select()
    .from(sessionRecordings)
    .where(eq(sessionRecordings.id, recordingId))
    .limit(1);
  const recording = rows[0];
  if (!recording) throw new Error(`recording ${recordingId} not found`);

  const meta = await deps.storage.stat(recording.storageKey);
  if (!meta) {
    await markFailed(deps, recordingId);
    return;
  }

  await withTempDir(`orbitplay-transcode-${recordingId}-`, async (dir) => {
    const inputPath = join(dir, 'source');
    await downloadToFile(deps, recording.storageKey, inputPath);

    let probe;
    try {
      probe = await probeMedia(inputPath);
    } catch {
      // Not readable as media at all — corrupt upload or not a video.
      await markFailed(deps, recordingId);
      return;
    }

    if (!probe.hasVideo || !isSupportedVideoCodec(probe.videoCodec)) {
      await markFailed(deps, recordingId);
      return;
    }

    // Thumbnail is best-effort: a frame that fails to grab shouldn't fail
    // an otherwise-valid recording.
    let thumbKey: string | null = null;
    try {
      const thumbPath = join(dir, 'thumb.jpg');
      const seekSeconds = probe.durationMs ? Math.min(1, probe.durationMs / 2000) : 0;
      await generateThumbnail(inputPath, thumbPath, seekSeconds);
      const thumbBuffer = await readFile(thumbPath);
      thumbKey = thumbnailKey(recording.storageKey);
      await deps.storage.putObject(thumbKey, thumbBuffer, 'image/jpeg');
    } catch {
      thumbKey = null;
    }

    await deps.db
      .update(sessionRecordings)
      .set({
        status: 'ready',
        contentType: meta.contentType ?? recording.contentType,
        sizeBytes: meta.sizeBytes,
        durationMs: probe.durationMs ?? recording.durationMs,
        thumbnailKey: thumbKey,
      })
      .where(eq(sessionRecordings.id, recordingId));
  });
}

/**
 * Real audio extraction (GAP-04): re-encodes the source's audio track to
 * AAC — genuinely separate bytes an ASR pipeline could consume later, not a
 * copy of the whole video. A recording with no audio track (mic consent
 * withheld, e.g.) is a legitimate case, not a failure: it's skipped, nothing
 * is written, and `status` is left alone (transcode owns that field, not
 * this job).
 */
export async function processMediaExtractAudio(
  deps: WorkerDeps,
  recordingId: string,
): Promise<void> {
  const rows = await deps.db
    .select()
    .from(sessionRecordings)
    .where(eq(sessionRecordings.id, recordingId))
    .limit(1);
  const recording = rows[0];
  if (!recording) throw new Error(`recording ${recordingId} not found`);

  const exists = await deps.storage.exists(recording.storageKey);
  if (!exists) throw new Error(`source object missing for ${recordingId}`);

  await withTempDir(`orbitplay-audio-${recordingId}-`, async (dir) => {
    const inputPath = join(dir, 'source');
    await downloadToFile(deps, recording.storageKey, inputPath);

    const probe = await probeMedia(inputPath);
    if (!probe.hasAudio) return;

    const outputPath = join(dir, 'audio.m4a');
    await extractAudioTrack(inputPath, outputPath);
    const audioBuffer = await readFile(outputPath);
    await deps.storage.putObject(extractedAudioKey(recording.storageKey), audioBuffer, 'audio/mp4');
  });
}
