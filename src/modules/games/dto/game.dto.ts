import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const slugField = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug deve ser kebab-case (a-z, 0-9, hífen)');

export const gameStatusValues = ['draft', 'active', 'archived'] as const;

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
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const gameListSchema = z.object({
  data: z.array(gameSchema),
  nextCursor: z.string().nullable(),
});

export class CreateGameDto extends createZodDto(createGameSchema) {}
export class UpdateGameDto extends createZodDto(updateGameSchema) {}
export class GameDto extends createZodDto(gameSchema) {}
export class GameListDto extends createZodDto(gameListSchema) {}

export type GameView = z.infer<typeof gameSchema>;
