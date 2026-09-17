import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { platformValues } from '../../games/dto/game.dto';

/** Short-lived — "curta duração" (BACKEND-SPEC §M6), unlike the 1h upload URLs. */
export const BUILD_DOWNLOAD_TTL_SECONDS = 900;

export const compatibilityQuerySchema = z.object({
  platform: z.enum(platformValues),
  os: z.string().max(100).optional(),
  arch: z.string().max(50).optional(),
});

export const compatibilityReportSchema = z.object({
  compatible: z.boolean(),
  reasons: z.array(z.string()),
  supportedPlatforms: z.array(z.enum(platformValues)),
});

export const downloadUrlQuerySchema = z.object({
  localVersion: z.string().max(100).optional(),
});

/**
 * `version`/`checksum` are nullable here even though the design's
 * `DownloadUrlResponse` lists `version` as a required non-nullable string —
 * `builds.version`/`builds.checksum` are nullable columns in the migrated
 * schema (confirming a build never requires either), same drift pattern as
 * `BuildView` in `modules/tests/dto/test.dto.ts`. See DECISIONS.md §3.
 */
export const downloadUrlResponseSchema = z.object({
  needsDownload: z.boolean(),
  downloadUrl: z.string().nullable(),
  expiresAt: z.string().nullable(),
  version: z.string().nullable(),
  checksum: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  supportsRange: z.boolean(),
});

export class CompatibilityQueryDto extends createZodDto(compatibilityQuerySchema) {}
export class CompatibilityReportDto extends createZodDto(compatibilityReportSchema) {}
export class DownloadUrlQueryDto extends createZodDto(downloadUrlQuerySchema) {}
export class DownloadUrlResponseDto extends createZodDto(downloadUrlResponseSchema) {}

export type CompatibilityQuery = z.infer<typeof compatibilityQuerySchema>;
export type CompatibilityReport = z.infer<typeof compatibilityReportSchema>;
export type DownloadUrlQuery = z.infer<typeof downloadUrlQuerySchema>;
export type DownloadUrlResponse = z.infer<typeof downloadUrlResponseSchema>;
