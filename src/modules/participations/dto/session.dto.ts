import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { gameSchema, platformValues } from '../../games/dto/game.dto';
import { playbackUrlResponseSchema } from '../../media/dto/media.dto';
import { testModelKeyValues } from '../../test-models/dto/test-model.dto';
import { testFormSchema, testStatusValues } from '../../tests/dto/test.dto';

/**
 * The design contract's `SessionSummary.test` is a `PlayerTest` — a schema
 * M8 (player feed) owns and hasn't been built yet. Rather than embedding the
 * full studio-facing `Test` (wizard steps, pending validations, audience —
 * none of it meaningful to a player mid-session), this is the honest subset
 * a session summary actually needs; M8 can widen it later without breaking
 * this route.
 */
export const playerTestSchema = z.object({
  id: z.string(),
  gameId: z.string(),
  title: z.string().nullable(),
  testModelKey: z.enum(testModelKeyValues),
  status: z.enum(testStatusValues),
  rewardCents: z.number().int().nullable(),
  expiresAt: z.string().nullable(),
});

export const startSessionRequestSchema = z.object({
  buildVersion: z.string().min(1),
  platform: z.enum(platformValues),
  deviceInfo: z.record(z.string(), z.unknown()).optional(),
});

export const sessionStartedSchema = z.object({
  sessionId: z.string(),
  startedAt: z.string(),
  maxDurationMs: z.number().int().nullable(),
  heartbeatIntervalMs: z.number().int(),
  recordingRequired: z.boolean(),
});

/**
 * API-facing session status. The DB enum (`session_status`) tracks the
 * mechanics of the recording pipeline (`starting`/`recording`/`paused`/
 * `finishing`/`processing`/`completed`/`invalidated`); this is the coarser,
 * player-facing shape the design contract promises. `completed` maps to
 * `valid`/`invalid` by consulting `session_validations` — see
 * `sessions.service.ts#toSessionStatus`.
 */
export const sessionStatusValues = [
  'active',
  'finishing',
  'in_review',
  'valid',
  'invalid',
  'abandoned',
] as const;

export const sessionSchema = z.object({
  id: z.string(),
  participationId: z.string(),
  testId: z.string(),
  status: z.enum(sessionStatusValues),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  invalidReason: z.string().nullable(),
});

export const deviceEventKindValues = ['microphone', 'webcam'] as const;

export const deviceEventRequestSchema = z.object({
  kind: z.enum(deviceEventKindValues),
  enabled: z.boolean(),
  tMs: z.number().int().min(0),
});

export const heartbeatRequestSchema = z.object({
  tMs: z.number().int().min(0),
  connectionQuality: z.enum(['good', 'degraded', 'poor']).optional(),
});

export const finishReasonValues = ['completed', 'gave_up', 'technical_failure'] as const;

export const finishSessionRequestSchema = z.object({
  tMs: z.number().int().min(0),
  confirmed: z.literal(true),
  reason: z.enum(finishReasonValues).optional(),
});

export const sessionSummarySchema = z.object({
  session: sessionSchema,
  test: playerTestSchema,
  game: gameSchema,
  recording: playbackUrlResponseSchema.nullable(),
  form: testFormSchema,
  alreadySubmitted: z.boolean(),
});

export const answerInputSchema = z.object({
  questionId: z.string(),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
});

export const formResponseRequestSchema = z.object({
  answers: z.array(answerInputSchema),
});

export const formResponseSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  submittedAt: z.string(),
});

export const rewardStatusValues = ['pending', 'approved', 'paid'] as const;

export const participationResultSchema = z.object({
  status: z.enum(['in_review', 'completed', 'rejected']),
  xpEarned: z.number().int().nullable(),
  rating: z.number().nullable(),
  rewardCents: z.number().int().nullable(),
  rewardStatus: z.enum(rewardStatusValues),
  invalidReason: z.string().nullable(),
});

export class PlayerTestDto extends createZodDto(playerTestSchema) {}
export class StartSessionRequestDto extends createZodDto(startSessionRequestSchema) {}
export class SessionStartedDto extends createZodDto(sessionStartedSchema) {}
export class SessionDto extends createZodDto(sessionSchema) {}
export class DeviceEventRequestDto extends createZodDto(deviceEventRequestSchema) {}
export class HeartbeatRequestDto extends createZodDto(heartbeatRequestSchema) {}
export class FinishSessionRequestDto extends createZodDto(finishSessionRequestSchema) {}
export class SessionSummaryDto extends createZodDto(sessionSummarySchema) {}
export class FormResponseRequestDto extends createZodDto(formResponseRequestSchema) {}
export class FormResponseDto extends createZodDto(formResponseSchema) {}
export class ParticipationResultDto extends createZodDto(participationResultSchema) {}

export type PlayerTestView = z.infer<typeof playerTestSchema>;
export type StartSessionRequest = z.infer<typeof startSessionRequestSchema>;
export type SessionStartedView = z.infer<typeof sessionStartedSchema>;
export type SessionStatus = (typeof sessionStatusValues)[number];
export type SessionView = z.infer<typeof sessionSchema>;
export type DeviceEventRequest = z.infer<typeof deviceEventRequestSchema>;
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;
export type FinishSessionRequest = z.infer<typeof finishSessionRequestSchema>;
export type SessionSummaryView = z.infer<typeof sessionSummarySchema>;
export type AnswerInput = z.infer<typeof answerInputSchema>;
export type FormResponseRequest = z.infer<typeof formResponseRequestSchema>;
export type FormResponseView = z.infer<typeof formResponseSchema>;
export type ParticipationResultView = z.infer<typeof participationResultSchema>;
