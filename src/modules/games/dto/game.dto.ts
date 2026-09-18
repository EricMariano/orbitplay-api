import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { paginationQuerySchema } from '../../../shared/pagination/pagination';

const slugField = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug deve ser kebab-case (a-z, 0-9, hífen)');

export const gameStatusValues = ['draft', 'active', 'archived'] as const;

export const assetKindValues = ['cover', 'banner', 'screenshot'] as const;

export const assetContentTypeValues = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** 5 MiB — capa/banner/screenshot are images, not builds. */
export const MAX_GAME_ASSET_BYTES = 5 * 1024 * 1024;

export const ASSET_UPLOAD_TTL_SECONDS = 900;

/** Input to create a game. slug is optional and derived from title when omitted. */
export const createGameSchema = z.object({
  title: z.string().min(1, 'Título obrigatório').max(200),
  slug: slugField.optional(),
  description: z.string().max(5000).optional(),
  genre: z.string().max(100).optional(),
  platform: z.string().max(100).optional(),
  status: z.enum(gameStatusValues).optional(),
});

/** Input to update a game — every field optional. */
export const updateGameSchema = createGameSchema.partial();

/** RN-03 (Tela 03): card aggregates computed on the backend. */
export const gameMetricsSchema = z.object({
  testsTotal: z.number().int(),
  testsActive: z.number().int(),
  sessionsValid: z.number().int(),
  playersTotal: z.number().int(),
  averageRating: z.number().nullable(),
});

/** Public representation of a game. */
export const gameSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  title: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  genre: z.string().nullable(),
  platform: z.string().nullable(),
  status: z.enum(gameStatusValues),
  coverUrl: z.string().nullable(),
  bannerUrl: z.string().nullable(),
  metrics: gameMetricsSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const gameListSchema = z.object({
  data: z.array(gameSchema),
  nextCursor: z.string().nullable(),
});

/** GET /games — cursor page plus search (`q`) and status filter. */
export const gameListQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(200).optional(),
  status: z.enum(gameStatusValues).optional(),
});

/** Tela 05 — header + aggregates for the game detail screen. */
export const gameSummarySchema = z.object({
  game: gameSchema,
  availability: z.enum(['available', 'unavailable']),
  metrics: gameMetricsSchema,
  canEdit: z.boolean(),
});

export const platformValues = ['windows', 'macos', 'linux', 'android', 'ios', 'web'] as const;

/**
 * Stub (BACKEND-SPEC.md §9, pendência #1): the "Novo jogo" (Tela 04) fields —
 * supported platforms, languages, min/recommended requirements — are still
 * undefined in the handoff, and `games` has no columns for them yet. Every
 * field is optional in the design contract; returning empty defaults now
 * closes the endpoint's shape without inventing schema ahead of that call.
 */
export const gameSpecsSchema = z.object({
  minimumRequirements: z.record(z.string(), z.string()).optional(),
  recommendedRequirements: z.record(z.string(), z.string()).optional(),
  supportedPlatforms: z.array(z.enum(platformValues)).optional(),
  languages: z.array(z.string()).optional(),
});

export const assetUploadUrlRequestSchema = z.object({
  kind: z.enum(assetKindValues),
  contentType: z.enum(assetContentTypeValues),
  sizeBytes: z
    .number()
    .int()
    .min(1, 'Arquivo vazio')
    .max(MAX_GAME_ASSET_BYTES, `Imagem acima de ${MAX_GAME_ASSET_BYTES} bytes`),
  fileName: z.string().min(1).max(255),
});

export const confirmAssetRequestSchema = z.object({
  kind: z.enum(assetKindValues),
  storageKey: z.string().min(1).max(500),
});

export const assetUploadUrlResponseSchema = z.object({
  uploadUrl: z.string(),
  storageKey: z.string(),
  expiresAt: z.string(),
  maxSizeBytes: z.number().int(),
});

export const gameAssetSchema = z.object({
  id: z.string(),
  kind: z.enum(assetKindValues),
  url: z.string(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  createdAt: z.string(),
});

export class CreateGameDto extends createZodDto(createGameSchema) {}
export class UpdateGameDto extends createZodDto(updateGameSchema) {}
export class GameDto extends createZodDto(gameSchema) {}
export class GameListDto extends createZodDto(gameListSchema) {}
export class GameListQueryDto extends createZodDto(gameListQuerySchema) {}
export class GameMetricsDto extends createZodDto(gameMetricsSchema) {}
export class GameSummaryDto extends createZodDto(gameSummarySchema) {}
export class GameSpecsDto extends createZodDto(gameSpecsSchema) {}
export class AssetUploadUrlRequestDto extends createZodDto(assetUploadUrlRequestSchema) {}
export class ConfirmAssetRequestDto extends createZodDto(confirmAssetRequestSchema) {}
export class AssetUploadUrlResponseDto extends createZodDto(assetUploadUrlResponseSchema) {}
export class GameAssetDto extends createZodDto(gameAssetSchema) {}

export type GameView = z.infer<typeof gameSchema>;
export type GameMetricsView = z.infer<typeof gameMetricsSchema>;
export type GameListQuery = z.infer<typeof gameListQuerySchema>;
export type GameSummaryView = z.infer<typeof gameSummarySchema>;
export type GameSpecsView = z.infer<typeof gameSpecsSchema>;
export type AssetKind = (typeof assetKindValues)[number];
export type AssetUploadUrlRequest = z.infer<typeof assetUploadUrlRequestSchema>;
export type ConfirmAssetRequest = z.infer<typeof confirmAssetRequestSchema>;
export type AssetUploadUrlResponse = z.infer<typeof assetUploadUrlResponseSchema>;
export type GameAssetView = z.infer<typeof gameAssetSchema>;

export const EMPTY_GAME_METRICS: GameMetricsView = {
  testsTotal: 0,
  testsActive: 0,
  sessionsValid: 0,
  playersTotal: 0,
  averageRating: null,
};

export const EMPTY_GAME_SPECS: GameSpecsView = {
  minimumRequirements: {},
  recommendedRequirements: {},
  supportedPlatforms: [],
  languages: [],
};
