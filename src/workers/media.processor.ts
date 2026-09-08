import { eq } from 'drizzle-orm';
import { sessionRecordings } from '../infra/database/schema/participations';
import { extractedAudioKey } from '../modules/media/storage-key';
import type { WorkerDeps } from './deps';

/**
 * Passthrough transcode: browser WebM is already playable. A real ffmpeg
 * pipeline (mp4 + thumbnail) can replace this without changing the job name
 * or the row status machine. Missing object → `failed` (Tela 12 RN-03 lives
 * on this row, not on the session).
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
    await deps.db
      .update(sessionRecordings)
      .set({ status: 'failed' })
      .where(eq(sessionRecordings.id, recordingId));
    return;
  }

  await deps.db
    .update(sessionRecordings)
    .set({
      status: 'ready',
      contentType: meta.contentType ?? recording.contentType,
      sizeBytes: meta.sizeBytes,
    })
    .where(eq(sessionRecordings.id, recordingId));
}

/**
 * Copy a sidecar next to the recording so ASR can consume it later. No
 * ffmpeg in this phase — the bytes are the source object. Failure of this
 * job does not rewrite `status` (transcode owns that field).
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

  await deps.storage.copyObject(recording.storageKey, extractedAudioKey(recording.storageKey));
}
