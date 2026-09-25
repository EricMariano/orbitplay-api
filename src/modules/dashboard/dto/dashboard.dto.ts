import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { gameSchema } from '../../games/dto/game.dto';
import { processingStatusValues } from '../../reports/dto/report.dto';
import { testSchema } from '../../tests/dto/test.dto';

/**
 * M11 — dashboard do estúdio (Tela 02). RN-02: todo KPI é calculado e
 * consolidado aqui; a UI não recalcula nada.
 */
export const dashboardKpiKeyValues = [
  'gamesTotal',
  'testsTotal',
  'testsActive',
  'sessionsValid',
  'playersTotal',
  'averageRating',
  'completionRate',
] as const;

/**
 * `delta` is always `null` for now: the handoff doesn't define the comparison
 * period (week? month? since last visit?) — see DECISIONS.md §3 (M11).
 */
export const dashboardKpiSchema = z.object({
  value: z.number().nullable(),
  delta: z.number().nullable(),
  unit: z.string().nullable(),
});

export const dashboardStatsPointSchema = z.object({
  date: z.string(),
  sessions: z.number().int(),
});

/** Same block shape as the M10 report blocks (`ReportBlockView`). */
export const dashboardBlockSchema = z.object({
  key: z.string(),
  status: z.enum(processingStatusValues),
  payload: z.record(z.string(), z.unknown()).nullable(),
  computedAt: z.string().nullable(),
});

export const studioDashboardSchema = z.object({
  kpis: z.record(z.enum(dashboardKpiKeyValues), dashboardKpiSchema),
  games: z.array(gameSchema),
  recentTests: z.array(testSchema),
  stats: dashboardBlockSchema,
});

export class StudioDashboardDto extends createZodDto(studioDashboardSchema) {}
export class DashboardBlockDto extends createZodDto(dashboardBlockSchema) {}

export type DashboardKpiKey = (typeof dashboardKpiKeyValues)[number];
export type DashboardKpiView = z.infer<typeof dashboardKpiSchema>;
export type DashboardStatsPoint = z.infer<typeof dashboardStatsPointSchema>;
export type DashboardBlockView = z.infer<typeof dashboardBlockSchema>;
export type StudioDashboardView = z.infer<typeof studioDashboardSchema>;
