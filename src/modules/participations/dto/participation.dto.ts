import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
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

export class ParticipationDto extends createZodDto(participationSchema) {}

export type ParticipationStatus = (typeof participationStatusValues)[number];
export type ParticipationView = z.infer<typeof participationSchema>;
