import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { paginationQuerySchema } from '../../../shared/pagination/pagination';
import { buildSchema } from '../../tests/dto/test.dto';

export const participationStatusValues = [
  'reserved',
  'tutorial',
  'downloading',
  'ready',
  'playing',
  'form_pending',
  'in_review',
  'completed',
  'rejected',
  'abandoned',
] as const;

/** Public representation of a participation (`GET /participations/:id`, POST response). */
export const participationSchema = z.object({
  id: z.string(),
  testId: z.string(),
  gameId: z.string(),
  status: z.enum(participationStatusValues),
  currentSessionId: z.string().nullable(),
  resumePoint: z.string().nullable(),
  consentsGranted: z.boolean(),
  build: buildSchema.nullable(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});

/** `GET /player/participations` — cursor page of the caller's participations. */
export const participationListSchema = z.object({
  data: z.array(participationSchema),
  nextCursor: z.string().nullable(),
});

export const participationListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(participationStatusValues).optional(),
});

export class ParticipationDto extends createZodDto(participationSchema) {}
export class ParticipationListDto extends createZodDto(participationListSchema) {}
export class ParticipationListQueryDto extends createZodDto(participationListQuerySchema) {}

export type ParticipationStatus = (typeof participationStatusValues)[number];
export type ParticipationView = z.infer<typeof participationSchema>;
export type ParticipationListQuery = z.infer<typeof participationListQuerySchema>;
