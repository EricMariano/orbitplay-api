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

export const RECORDING_UPLOAD_TTL_SECONDS = 3600;

export const recordingUploadUrlRequestSchema = z.object({
  contentType: z.enum(recordingContentTypeValues),
  sizeBytes: z
    .number()
    .int()
    .min(1, 'Arquivo vazio')
    .max(MAX_RECORDING_BYTES, `Arquivo acima de ${MAX_RECORDING_BYTES} bytes`),
  partNumber: z.number().int().min(1).optional(),
  uploadId: z.string().min(1).max(500).optional(),
  kind: z.enum(recordingKindApiValues).optional(),
});

export const recordingCompletePartSchema = z.object({
  partNumber: z.number().int().min(1),
  etag: z.string().min(1).max(200),
});

export const recordingCompleteRequestSchema = z
  .object({
    storageKey: z.string().min(1).max(500),
    durationMs: z.number().int().min(0),
    sizeBytes: z.number().int().min(1).optional(),
    uploadId: z.string().min(1).max(500).optional(),
    parts: z.array(recordingCompletePartSchema).optional(),
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

export const uploadUrlResponseSchema = z.object({
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
export class UploadUrlResponseDto extends createZodDto(uploadUrlResponseSchema) {}
export class RecordingDto extends createZodDto(recordingSchema) {}
export class PlaybackUrlResponseDto extends createZodDto(playbackUrlResponseSchema) {}

export type RecordingUploadUrlRequest = z.infer<typeof recordingUploadUrlRequestSchema>;
export type RecordingCompleteRequest = z.infer<typeof recordingCompleteRequestSchema>;
export type UploadUrlResponse = z.infer<typeof uploadUrlResponseSchema>;
export type RecordingView = z.infer<typeof recordingSchema>;
export type PlaybackUrlResponse = z.infer<typeof playbackUrlResponseSchema>;
