import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { gameSchema, gameSpecsSchema, platformValues } from '../../games/dto/game.dto';
import { testModelKeyValues } from '../../test-models/dto/test-model.dto';
import { participationSchema } from './participation.dto';

/**
 * M8-03 — leituras do jogador sobre jogos/testes de qualquer organização
 * (Telas 14 e 15). Formato do `openapi.design.yaml` (`PlayerGame`,
 * `PlayerTest`, `ParticipationList`).
 */

/** Tela 15 RN-01: CTA calculado no backend, nunca inferido na UI. */
export const testCtaValues = [
  'start',
  'continue',
  'completed',
  'in_review',
  'downloading',
  'unavailable',
] as const;

export const playerTestSchema = z.object({
  testId: z.string(),
  gameId: z.string(),
  title: z.string(),
  genre: z.string().nullable(),
  coverUrl: z.string().nullable(),
  rewardCents: z.number().int().nullable(),
  /** Duração estimada de uma sessão — nenhum modelo/teste define isso ainda, sempre `null`. */
  durationMinutes: z.number().int().nullable(),
  spotsLeft: z.number().int().nullable(),
  expiresAt: z.string().nullable(),
  platforms: z.array(z.enum(platformValues)),
  cta: z.enum(testCtaValues),
  /** Tela 14 RN-03: indisponível aparece desabilitado, com motivo, em vez de sumir. */
  disabled: z.boolean(),
  disabledReason: z.string().nullable(),
  /** Item pago (impulsionamento) — sempre `false` nesta fase (§10). */
  promoted: z.boolean(),
  modelKey: z.enum(testModelKeyValues),
  participation: participationSchema.nullable(),
});

export const playerTestListSchema = z.object({
  data: z.array(playerTestSchema),
  nextCursor: z.string().nullable(),
});

/** Tela 15 — cabeçalho do jogo para o jogador. */
export const playerGameSchema = z.object({
  game: gameSchema,
  playersTotal: z.number().int(),
  /** Testes publicados, dentro do prazo e com vaga. */
  openTests: z.number().int(),
  /** Maior recompensa entre os testes abertos; `null` quando nenhum define recompensa. */
  maxRewardCents: z.number().int().nullable(),
  specs: gameSpecsSchema,
});

/** Tela 13 — dados consolidados da Home do jogador. Recompensas só entram após validação da sessão. */
export const playerHomeTestSchema = z.object({
  participationId: z.string(),
  testId: z.string(),
  gameId: z.string(),
  title: z.string(),
  coverUrl: z.string().nullable(),
  status: participationSchema.shape.status,
  progress: z.number().int().min(0).max(100),
  rewardCents: z.number().int().nullable(),
  endsAt: z.string().nullable(),
});

export const playerEarningsPointSchema = z.object({
  date: z.string(),
  amountCents: z.number().int(),
});

export const playerHomeSchema = z.object({
  continuing: playerHomeTestSchema.nullable(),
  tests: z.array(playerHomeTestSchema),
  earnings: z.object({
    currency: z.string(),
    last7DaysCents: z.number().int(),
    totalValidatedCents: z.number().int(),
    series: z.array(playerEarningsPointSchema),
  }),
});

export class PlayerTestDto extends createZodDto(playerTestSchema) {}
export class PlayerTestListDto extends createZodDto(playerTestListSchema) {}
export class PlayerGameDto extends createZodDto(playerGameSchema) {}
export class PlayerHomeDto extends createZodDto(playerHomeSchema) {}

export type TestCta = (typeof testCtaValues)[number];
export type PlayerTestView = z.infer<typeof playerTestSchema>;
export type PlayerTestList = z.infer<typeof playerTestListSchema>;
export type PlayerGameView = z.infer<typeof playerGameSchema>;
export type PlayerHomeView = z.infer<typeof playerHomeSchema>;
