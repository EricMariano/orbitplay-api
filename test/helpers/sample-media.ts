import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { FFMPEG_PATH } from '../../src/workers/ffmpeg';

const execFileAsync = promisify(execFile);

/**
 * Generates a small, genuinely valid WebM (VP8 + Opus) clip from ffmpeg's
 * own synthetic `lavfi` sources — no binary fixture file to commit, and the
 * duration/codecs are exactly known, so tests can assert on them precisely.
 * Used to prove the real ffmpeg pipeline (GAP-04) against real bytes,
 * instead of the old stub's implicit assumption that any object is valid.
 */
export async function generateSampleWebm(
  outputPath: string,
  options: { durationSeconds?: number; withAudio?: boolean } = {},
): Promise<void> {
  const duration = options.durationSeconds ?? 1;
  const withAudio = options.withAudio ?? true;

  const args = ['-y', '-f', 'lavfi', '-i', `testsrc=duration=${duration}:size=320x240:rate=10`];
  if (withAudio) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=1000:duration=${duration}`);
  }
  args.push('-c:v', 'libvpx');
  if (withAudio) {
    args.push('-c:a', 'libopus');
  } else {
    args.push('-an');
  }
  args.push(outputPath);

  await execFileAsync(FFMPEG_PATH, args, { maxBuffer: 10 * 1024 * 1024 });
}
