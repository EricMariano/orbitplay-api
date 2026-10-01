import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { paginationQuerySchema } from '../../../shared/pagination/pagination';

/**
 * M10 — relatórios do estúdio (Telas 11 e 12). As chaves de bloco abaixo são
 * os `block_key`s de `test_report_snapshots`: cada bloco é uma linha própria,
 * então um bloco que falha não derruba os demais.
 */
export const reportBlockKeyValues = [
  'overview',
  'evolution',
  'rating_distribution',
  'tester_profile',
] as const;

export const processingStatusValues = ['processing', 'ready', 'failed', 'unavailable'] as const;
export const reportExportFormatValues = ['csv', 'pdf'] as const;

/* ------------------------------- Blocos ---------------------------------- */

export const overviewPayloadSchema = z.object({
  totalParticipations: z.number().int(),
  completedSessions: z.number().int(),
  validSessions: z.number().int(),
  completionRate: z.number().nullable(),
  averageDurationMs: z.number().nullable(),
  averageRating: z.number().nullable(),
});

export const evolutionPointSchema = z.object({
  date: z.string(),
  sessions: z.number().int(),
});
export const evolutionPayloadSchema = z.object({ points: z.array(evolutionPointSchema) });

export const ratingBucketSchema = z.object({
  rating: z.number().int(),
  count: z.number().int(),
});
export const ratingDistributionPayloadSchema = z.object({
  buckets: z.array(ratingBucketSchema),
});

export const testerProfilePayloadSchema = z.object({
  ageBrackets: z.array(z.object({ bracket: z.string(), count: z.number().int() })),
});

export const reportBlockSchema = z.object({
  key: z.enum(reportBlockKeyValues),
  status: z.enum(processingStatusValues),
  payload: z.record(z.string(), z.unknown()).nullable(),
  computedAt: z.string().nullable(),
});

export const testReportSchema = z.object({
  testId: z.string(),
  blocks: z.array(reportBlockSchema),
});

/* --------------------------- Sessões e avaliações -------------------------- */

export const reportSessionQuerySchema = paginationQuerySchema;

export const reportSessionSchema = z.object({
  sessionId: z.string(),
  participationId: z.string(),
  testerId: z.string(),
  testerName: z.string(),
  status: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  valid: z.boolean().nullable(),
  averageRating: z.number().nullable(),
});

export const reportSessionListSchema = z.object({
  data: z.array(reportSessionSchema),
  nextCursor: z.string().nullable(),
});

export const sessionEvaluationAnswerSchema = z.object({
  questionId: z.string(),
  prompt: z.string(),
  type: z.string(),
  valueText: z.string().nullable(),
  valueNumber: z.number().nullable(),
  valueBoolean: z.boolean().nullable(),
  optionLabels: z.array(z.string()),
});

export const sessionEvaluationSchema = z.object({
  session: reportSessionSchema,
  submittedAt: z.string().nullable(),
  answers: z.array(sessionEvaluationAnswerSchema),
});

/* -------------------------------- Exportação -------------------------------- */

export const createReportExportSchema = z.object({
  format: z.enum(reportExportFormatValues),
});

export const reportExportSchema = z.object({
  id: z.string(),
  testId: z.string(),
  format: z.enum(reportExportFormatValues),
  status: z.enum(processingStatusValues),
  downloadUrl: z.string().nullable(),
  failureReason: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});

export class TestReportDto extends createZodDto(testReportSchema) {}
export class ReportSessionQueryDto extends createZodDto(reportSessionQuerySchema) {}
export class ReportSessionListDto extends createZodDto(reportSessionListSchema) {}
export class SessionEvaluationDto extends createZodDto(sessionEvaluationSchema) {}
export class CreateReportExportDto extends createZodDto(createReportExportSchema) {}
export class ReportExportDto extends createZodDto(reportExportSchema) {}

export type ReportBlockKey = (typeof reportBlockKeyValues)[number];
export type ProcessingStatusValue = (typeof processingStatusValues)[number];
export type ReportExportFormat = (typeof reportExportFormatValues)[number];
export type TestReportView = z.infer<typeof testReportSchema>;
export type ReportBlockView = z.infer<typeof reportBlockSchema>;
export type OverviewPayload = z.infer<typeof overviewPayloadSchema>;
export type EvolutionPayload = z.infer<typeof evolutionPayloadSchema>;
export type RatingDistributionPayload = z.infer<typeof ratingDistributionPayloadSchema>;
export type TesterProfilePayload = z.infer<typeof testerProfilePayloadSchema>;
export type ReportSessionView = z.infer<typeof reportSessionSchema>;
export type ReportSessionQuery = z.infer<typeof reportSessionQuerySchema>;
export type SessionEvaluationView = z.infer<typeof sessionEvaluationSchema>;
export type SessionEvaluationAnswerView = z.infer<typeof sessionEvaluationAnswerSchema>;
export type CreateReportExportRequest = z.infer<typeof createReportExportSchema>;
export type ReportExportView = z.infer<typeof reportExportSchema>;
