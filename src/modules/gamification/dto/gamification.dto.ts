import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { paginationQuerySchema } from '../../../shared/pagination/pagination';

/**
 * XP→level curve. Placeholder (BACKEND-SPEC.md §9 pendência #4 is still
 * open) — flat 100 XP per level. Isolated here so swapping it for the real
 * curve later touches one place, not every caller. See DECISIONS.md §3.
 */
export const XP_PER_LEVEL = 100;

export function levelFromXp(xp: number): number {
  return Math.floor(xp / XP_PER_LEVEL) + 1;
}

export function xpToNextLevelFromXp(xp: number): number {
  return XP_PER_LEVEL - (xp % XP_PER_LEVEL);
}

export const playerProgressSchema = z.object({
  level: z.number().int(),
  xp: z.number().int(),
  xpToNextLevel: z.number().int(),
  feedbackQuality: z.number(),
  achievementsUnlocked: z.number().int(),
  hoursPlayed: z.number(),
  testsCompleted: z.number().int(),
});

export const achievementSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  iconUrl: z.string().nullable(),
});

export const playerAchievementSchema = z.object({
  achievement: achievementSchema,
  unlocked: z.boolean(),
  unlockedAt: z.string().nullable(),
  progress: z.number().nullable(),
});

export const playerAchievementListSchema = z.object({
  data: z.array(playerAchievementSchema),
  nextCursor: z.string().nullable(),
});

/**
 * `target` is always `1`: `player_missions.progress` (real schema) has no
 * paired threshold column — there's no `missions.target` to read. `progress`
 * is exposed as that same 0–1 fraction instead of the design's "N of target"
 * integer pair. See DECISIONS.md §3.
 */
export const playerMissionSchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  progress: z.number(),
  target: z.literal(1),
  rewardXp: z.number().int().nullable(),
  expiresAt: z.string().nullable(),
});

export const playerMissionListSchema = z.object({
  data: z.array(playerMissionSchema),
});

export const rankingScopeValues = ['global', 'game'] as const;
export const rankingPeriodValues = ['week', 'month', 'all'] as const;

export const rankingsQuerySchema = paginationQuerySchema
  .extend({
    scope: z.enum(rankingScopeValues).default('global'),
    gameId: z.string().uuid().optional(),
    period: z.enum(rankingPeriodValues).default('month'),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'game' && !v.gameId) {
      ctx.addIssue({
        code: 'custom',
        message: 'gameId é obrigatório quando scope=game',
        path: ['gameId'],
      });
    }
  });

export const rankingEntrySchema = z.object({
  position: z.number().int(),
  userId: z.string(),
  displayName: z.string(),
  level: z.number().int(),
  score: z.number(),
  isCurrentUser: z.boolean(),
});

export const rankingListSchema = z.object({
  data: z.array(rankingEntrySchema),
  nextCursor: z.string().nullable(),
  currentUserEntry: rankingEntrySchema.nullable(),
  generatedAt: z.string().nullable(),
});

export type PlayerProgress = z.infer<typeof playerProgressSchema>;
export type AchievementView = z.infer<typeof achievementSchema>;
export type PlayerAchievementView = z.infer<typeof playerAchievementSchema>;
export type PlayerMissionView = z.infer<typeof playerMissionSchema>;
export type RankingsQuery = z.infer<typeof rankingsQuerySchema>;
export type RankingEntryView = z.infer<typeof rankingEntrySchema>;
export type RankingList = z.infer<typeof rankingListSchema>;

export class PlayerProgressDto extends createZodDto(playerProgressSchema) {}
export class PlayerAchievementListDto extends createZodDto(playerAchievementListSchema) {}
export class PlayerMissionListDto extends createZodDto(playerMissionListSchema) {}
export class RankingsQueryDto extends createZodDto(rankingsQuerySchema) {}
export class RankingListDto extends createZodDto(rankingListSchema) {}
