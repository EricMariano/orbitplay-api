import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { recordingKindApiValues } from '../recording-kind';

export const processingStatusValues = ['processing', 'ready', 'failed', 'unavailable'] as const;

export const recordingContentTypeValues = [
  'video/webm',
  'video/mp4',
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
] as const;

/** 2 GiB — long screen recordings; the API never proxies the bytes. */
export const MAX_RECORDING_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 4 h — longer than any playtest session is expected to run. The worker
 * refuses (and never re-encodes past) this much media, and it keeps the
 * `integer` duration column far from overflowing.
 */
export const MAX_RECORDING_DURATION_MS = 4 * 60 * 60 * 1000;

export const RECORDING_UPLOAD_TTL_SECONDS = 3600;

/**
 * Highest multipart part number a recording upload may use (S3 allows
 * 10 000). With the client's ≥ 8 MiB parts, 1000 parts already exceed
 * `MAX_RECORDING_BYTES`, so a legitimate upload never gets near it.
 */
export const MAX_RECORDING_PARTS = 1000;

/** Recordings (stored + still uploading) one session may hold. */
export const MAX_RECORDINGS_PER_SESSION = 10;

/**
 * How long after a session ends a new recording upload may still start. The
 * `session.validate` worker waits this long for a required recording before
 * settling the session as "Gravação obrigatória ausente" — keep both in step.
 */
export const RECORDING_UPLOAD_WINDOW_MS = 2 * 60 * 60 * 1000;

export const recordingUploadUrlRequestSchema = z.object({
  contentType: z.enum(recordingContentTypeValues),
  // Advisory, on every call: the recording's expected total size or this
  // part's size — both fit the range. Only range-checked here; the presigned
  // part URL doesn't bind it, and `complete` enforces the real object size
  // (`stat`, 1..MAX_RECORDING_BYTES) before any row exists.
  sizeBytes: z
    .number()
    .int()
    .min(1, 'Arquivo vazio')
    .max(MAX_RECORDING_BYTES, `Arquivo acima de ${MAX_RECORDING_BYTES} bytes`),
  partNumber: z.number().int().min(1).max(MAX_RECORDING_PARTS).optional(),
  uploadId: z.string().min(1).max(500).optional(),
  kind: z.enum(recordingKindApiValues).optional(),
});

export const recordingCompletePartSchema = z.object({
  partNumber: z.number().int().min(1).max(MAX_RECORDING_PARTS),
  etag: z.string().min(1).max(200),
});

export const recordingCompleteRequestSchema = z
  .object({
    storageKey: z.string().min(1).max(500),
    durationMs: z.number().int().min(0).max(MAX_RECORDING_DURATION_MS),
    sizeBytes: z.number().int().min(1).optional(),
    uploadId: z.string().min(1).max(500).optional(),
    parts: z.array(recordingCompletePartSchema).max(MAX_RECORDING_PARTS).optional(),
  })
  .superRefine((value, ctx) => {
    const hasUploadId = Boolean(value.uploadId);
    const hasParts = Boolean(value.parts && value.parts.length > 0);
    if (hasUploadId !== hasParts) {
      ctx.addIssue({
        code: 'custom',
        message: 'Informe uploadId e parts juntos para fechar o envio multipart',
        path: hasUploadId ? ['parts'] : ['uploadId'],
      });
    }
  });

export const recordingUploadUrlResponseSchema = z.object({
  uploadUrl: z.string(),
  storageKey: z.string(),
  expiresAt: z.string(),
  maxSizeBytes: z.number().int().optional(),
  uploadId: z.string().optional(),
});

export const recordingSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  status: z.enum(processingStatusValues),
  durationMs: z.number().int().nullable(),
  createdAt: z.string(),
});

export const playbackUrlResponseSchema = z.object({
  status: z.enum(processingStatusValues),
  url: z.string().nullable(),
  expiresAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  thumbnailUrl: z.string().nullable(),
});

export class RecordingUploadUrlRequestDto extends createZodDto(recordingUploadUrlRequestSchema) {}
export class RecordingCompleteRequestDto extends createZodDto(recordingCompleteRequestSchema) {}
export class RecordingUploadUrlResponseDto extends createZodDto(recordingUploadUrlResponseSchema) {}
export class RecordingDto extends createZodDto(recordingSchema) {}
export class PlaybackUrlResponseDto extends createZodDto(playbackUrlResponseSchema) {}

export type RecordingUploadUrlRequest = z.infer<typeof recordingUploadUrlRequestSchema>;
export type RecordingCompleteRequest = z.infer<typeof recordingCompleteRequestSchema>;
export type RecordingUploadUrlResponse = z.infer<typeof recordingUploadUrlResponseSchema>;
export type RecordingView = z.infer<typeof recordingSchema>;
export type PlaybackUrlResponse = z.infer<typeof playbackUrlResponseSchema>;
