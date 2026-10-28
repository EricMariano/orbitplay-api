import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const execFileAsync = promisify(execFile);

/**
 * Binaries come from the `@ffmpeg-installer`/`@ffprobe-installer` npm
 * packages (a static binary per platform) instead of assuming ffmpeg is
 * installed on the host — the worker needs to run the same way in dev, CI,
 * and whatever deploys it, without an extra OS-level dependency (GAP-04).
 */
export const FFMPEG_PATH: string = ffmpegInstaller.path;
export const FFPROBE_PATH: string = ffprobeInstaller.path;

/**
 * Every input is a file a player uploaded, so ffmpeg may only read it as a
 * local file in the containers a `MediaRecorder` produces (Matroska/WebM,
 * MP4/MOV, Ogg): a playlist or concat script disguised as a recording can't
 * make it fetch URLs or pull other local files into a thumbnail or track.
 */
const INPUT_GUARD = ['-protocol_whitelist', 'file', '-format_whitelist', 'matroska,mov,ogg'];

/**
 * Wall-clock caps per call. The worker runs one job at a time, on the same
 * queue that validates sessions and builds — a crafted file that keeps
 * ffmpeg busy must not stall everything behind it (or hold its lock forever).
 */
const PROBE_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 60_000;
const AUDIO_TIMEOUT_MS = 15 * 60_000;

function run(binary: string, args: string[], timeoutMs: number) {
  return execFileAsync(binary, args, {
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: 10 * 1024 * 1024,
  });
}

export interface MediaProbe {
  durationMs: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}

/**
 * Codecs a `MediaRecorder` capture (or a re-encode of one) actually produces
 * in practice — vp8/vp9/opus from Chromium/Firefox WebM, h264/aac from
 * Safari's fMP4. Anything else means the object isn't the kind of recording
 * this pipeline expects, so it's treated as invalid rather than guessed at.
 */
const ALLOWED_VIDEO_CODECS = new Set(['vp8', 'vp9', 'av1', 'h264', 'hevc']);
const ALLOWED_AUDIO_CODECS = new Set(['opus', 'aac', 'vorbis', 'mp3']);

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  duration?: string;
}

interface FfprobeOutput {
  format?: { duration?: string };
  streams?: FfprobeStream[];
}

/** Reads codec/duration/stream-presence straight from the file's own bytes — never trusted from the client. */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
  const { stdout } = await run(
    FFPROBE_PATH,
    [
      '-v',
      'error',
      ...INPUT_GUARD,
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ],
    PROBE_TIMEOUT_MS,
  );

  const parsed = JSON.parse(stdout) as FfprobeOutput;
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');

  const durationRaw = parsed.format?.duration ?? videoStream?.duration ?? audioStream?.duration;
  const durationSeconds = durationRaw ? Number.parseFloat(durationRaw) : NaN;

  return {
    durationMs: Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : null,
    hasVideo: !!videoStream,
    hasAudio: !!audioStream,
    videoCodec: videoStream?.codec_name ?? null,
    audioCodec: audioStream?.codec_name ?? null,
  };
}

export function isSupportedVideoCodec(codec: string | null): boolean {
  return !!codec && ALLOWED_VIDEO_CODECS.has(codec.toLowerCase());
}

export function isSupportedAudioCodec(codec: string | null): boolean {
  return !!codec && ALLOWED_AUDIO_CODECS.has(codec.toLowerCase());
}

/** Grabs one frame as a JPEG thumbnail, scaled to a 480px-wide preview. */
export async function generateThumbnail(
  inputPath: string,
  outputPath: string,
  atSeconds: number,
): Promise<void> {
  await run(
    FFMPEG_PATH,
    [
      '-y',
      ...INPUT_GUARD,
      '-ss',
      String(Math.max(0, atSeconds)),
      '-i',
      inputPath,
      '-frames:v',
      '1',
      '-vf',
      'scale=480:-2',
      '-q:v',
      '4',
      outputPath,
    ],
    THUMBNAIL_TIMEOUT_MS,
  );
}

/**
 * Re-encodes just the audio track to AAC — a real extraction, not a copy of
 * the source bytes. `-t` stops at `maxDurationMs` whatever the container
 * claims: a small file can still decode to hours of audio.
 */
export async function extractAudioTrack(
  inputPath: string,
  outputPath: string,
  maxDurationMs: number,
): Promise<void> {
  await run(
    FFMPEG_PATH,
    [
      '-y',
      ...INPUT_GUARD,
      '-i',
      inputPath,
      '-t',
      String(maxDurationMs / 1000),
      '-vn',
      '-acodec',
      'aac',
      '-b:a',
      '128k',
      outputPath,
    ],
    AUDIO_TIMEOUT_MS,
  );
}
