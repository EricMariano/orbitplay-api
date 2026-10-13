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
  'evaluations',
  'telemetry',
] as const;

export const processingStatusValues = ['processing', 'ready', 'failed', 'unavailable'] as const;
export const reportExportFormatValues = ['csv', 'pdf'] as const;
export const playerArchetypeValues = ['achiever', 'explorer', 'socializer', 'killer'] as const;
export const playerProfileTierValues = ['casual', 'experienced', 'trained', 'qa'] as const;
export const insightCategoryValues = [
  'ux_ui',
  'bugs_accessibility',
  'fun',
  'narrative_social',
] as const;

/* ------------------------------- Blocos ---------------------------------- */

export const overviewPayloadSchema = z.object({
  totalParticipations: z.number().int(),
  completedSessions: z.number().int(),
  validSessions: z.number().int(),
  completionRate: z.number().nullable(),
  averageDurationMs: z.number().nullable(),
  averageRating: z.number().nullable(),
  /** Jogadores distintos com participação no teste. */
  testersCount: z.number().int(),
  /**
   * Derivados dos insights de IA (deferidos, BACKEND-SPEC §10): `null` até o
   * `AiPort` real existir — nunca um valor provisório.
   */
  aiScore: z.number().nullable(),
  funFactor: z.number().nullable(),
  bugsCount: z.number().int().nullable(),
});

export const evolutionPointSchema = z.object({
  date: z.string(),
  sessions: z.number().int(),
});
/** Semana N conta a partir do início do teste (ou da 1ª sessão, sem data de início). */
export const evolutionWeekSchema = z.object({
  week: z.number().int(),
  startDate: z.string(),
  sessions: z.number().int(),
});
export const evolutionPayloadSchema = z.object({
  points: z.array(evolutionPointSchema),
  weeks: z.array(evolutionWeekSchema),
});

export const ratingBucketSchema = z.object({
  rating: z.number().int(),
  count: z.number().int(),
});
export const ratingDistributionPayloadSchema = z.object({
  buckets: z.array(ratingBucketSchema),
});

/** `unknown` = jogador que ainda não preencheu o perfil. */
export const testerProfilePayloadSchema = z.object({
  ageBrackets: z.array(z.object({ bracket: z.string(), count: z.number().int() })),
  archetypes: z.array(
    z.object({ key: z.enum([...playerArchetypeValues, 'unknown']), count: z.number().int() }),
  ),
  playerTiers: z.array(
    z.object({ key: z.enum([...playerProfileTierValues, 'unknown']), count: z.number().int() }),
  ),
});

/** Resumo de uma pergunta do formulário (bloco `evaluations`). */
export const evaluationQuestionSummarySchema = z.object({
  questionId: z.string(),
  position: z.number().int(),
  label: z.string(),
  type: z.string(),
  responsesCount: z.number().int(),
  /** Média das respostas numéricas (escala/NPS); `null` nos demais tipos. */
  average: z.number().nullable(),
  /** Escala/NPS: contagem por valor, de `scaleMin` a `scaleMax` (zeros incluídos). */
  distribution: z.array(z.object({ value: z.number().int(), count: z.number().int() })),
  /** Escolha única/múltipla: contagem por opção, na ordem do formulário. */
  options: z.array(z.object({ label: z.string(), count: z.number().int() })),
  /** Texto aberto: até 3 respostas mais recentes. */
  samples: z.array(z.string()),
});

export const evaluationsPayloadSchema = z.object({
  questionsCount: z.number().int(),
  responsesCount: z.number().int(),
  /** Média entre o fim da sessão e o envio do formulário. */
  averageResponseTimeMs: z.number().nullable(),
  /** Sessões encerradas sem formulário enviado ÷ sessões encerradas. */
  dropoutRate: z.number().nullable(),
  questions: z.array(evaluationQuestionSummarySchema),
});

/**
 * Orbit Plug-in (deferido, BACKEND-SPEC §10). O bloco só fica `ready` quando a
 * build do teste tem manifesto do plug-in; sem ele, `unavailable`.
 * `discoveries`/`aiSuggestions` dependem da IA: `null` até ela existir.
 */
export const telemetryPayloadSchema = z.object({
  sessionsAnalyzed: z.number().int(),
  activeTriggers: z.number().int(),
  discoveries: z.array(z.string()).nullable(),
  aiSuggestions: z.array(z.string()).nullable(),
});

/** Payload de cada bloco — também valida snapshots em cache de um formato antigo. */
export const reportBlockPayloadSchemas = {
  overview: overviewPayloadSchema,
  evolution: evolutionPayloadSchema,
  rating_distribution: ratingDistributionPayloadSchema,
  tester_profile: testerProfilePayloadSchema,
  evaluations: evaluationsPayloadSchema,
  telemetry: telemetryPayloadSchema,
} as const;

function blockVariant<K extends ReportBlockKey>(key: K) {
  return z.object({
    key: z.literal(key),
    status: z.enum(processingStatusValues),
    payload: reportBlockPayloadSchemas[key].nullable(),
    computedAt: z.string().nullable(),
  });
}

/**
 * Um bloco por chave, com payload tipado (união discriminada por `key`) —
 * `payload` só vem preenchido com `status: ready`.
 */
export const reportBlockSchema = z.discriminatedUnion('key', [
  blockVariant('overview'),
  blockVariant('evolution'),
  blockVariant('rating_distribution'),
  blockVariant('tester_profile'),
  blockVariant('evaluations'),
  blockVariant('telemetry'),
]);

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
  archetype: z.enum(playerArchetypeValues).nullable(),
  playerTier: z.enum(playerProfileTierValues).nullable(),
  /** Nota de qualidade da sessão pela IA (deferida): `null` até existir. */
  aiQualityScore: z.number().nullable(),
  /** O plug-in abriu sessão de telemetria (`session_tokens`) nesta sessão. */
  telemetryConnected: z.boolean(),
});

export const reportSessionListSchema = z.object({
  data: z.array(reportSessionSchema),
  nextCursor: z.string().nullable(),
  /** Total de sessões do teste — para "Mostrando X–Y de N". */
  total: z.number().int(),
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

export const rateSessionSchema = z.object({
  rating: z.number().int().min(1, 'Nota mínima é 1').max(5, 'Nota máxima é 5'),
  comment: z.string().trim().max(1000, 'Comentário muito longo').nullish(),
  markedInvalid: z.boolean().default(false),
});

export const sessionRatingSchema = z.object({
  sessionId: z.string(),
  rating: z.number().int(),
  comment: z.string().nullable(),
  markedInvalid: z.boolean(),
  ratedByUserId: z.string(),
  updatedAt: z.string(),
});

/* ------------------------------ Insights de IA ------------------------------ */

export const testInsightsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  category: z.enum(insightCategoryValues).optional(),
});

/**
 * Tela 11 RN-03: todo insight aponta para a evidência de origem e é marcado
 * como gerado por IA. Insight não substitui o dado bruto.
 */
export const insightSchema = z.object({
  id: z.string(),
  category: z.enum(insightCategoryValues),
  title: z.string(),
  body: z.string(),
  sessionId: z.string().nullable(),
  tMs: z.number().int().nullable(),
  sourceType: z.string(),
  generatedByAi: z.literal(true),
  createdAt: z.string(),
});

/**
 * Geração deferida (BACKEND-SPEC §10): enquanto não há `AiPort` real a lista
 * vem vazia com `status: unavailable` — a tela mostra o estado, não dado fake.
 */
export const testInsightsSchema = z.object({
  status: z.enum(processingStatusValues),
  /** Modelo que gerou os insights; `null` enquanto não houver geração. */
  model: z.string().nullable(),
  data: z.array(insightSchema),
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
export class TestInsightsQueryDto extends createZodDto(testInsightsQuerySchema) {}
export class TestInsightsDto extends createZodDto(testInsightsSchema) {}
export class ReportSessionQueryDto extends createZodDto(reportSessionQuerySchema) {}
export class ReportSessionListDto extends createZodDto(reportSessionListSchema) {}
export class SessionEvaluationDto extends createZodDto(sessionEvaluationSchema) {}
export class RateSessionDto extends createZodDto(rateSessionSchema) {}
export class SessionRatingDto extends createZodDto(sessionRatingSchema) {}
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
export type EvaluationsPayload = z.infer<typeof evaluationsPayloadSchema>;
export type EvaluationQuestionSummary = z.infer<typeof evaluationQuestionSummarySchema>;
export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;
export type TestInsightsQuery = z.infer<typeof testInsightsQuerySchema>;
export type TestInsightsView = z.infer<typeof testInsightsSchema>;
export type ReportSessionView = z.infer<typeof reportSessionSchema>;
export type ReportSessionQuery = z.infer<typeof reportSessionQuerySchema>;
export type SessionEvaluationView = z.infer<typeof sessionEvaluationSchema>;
export type SessionEvaluationAnswerView = z.infer<typeof sessionEvaluationAnswerSchema>;
export type RateSessionRequest = z.infer<typeof rateSessionSchema>;
export type SessionRatingView = z.infer<typeof sessionRatingSchema>;
export type CreateReportExportRequest = z.infer<typeof createReportExportSchema>;
export type ReportExportView = z.infer<typeof reportExportSchema>;
