import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { paginationQuerySchema } from '../../../shared/pagination/pagination';
import { gameSchema } from '../../games/dto/game.dto';

/**
 * Feed ranking (ORB-M8-02): placeholder — jogos mais recentes primeiro
 * (games.createdAt desc). `player_preferences` (genres/platforms/
 * deviceProfile) ainda não entra na pontuação — "weights are still TBD"
 * (comentário em schema/player.ts). Isolado aqui para trocar por um
 * critério real sem tocar em repository/service/controller. Ver
 * DECISIONS.md.
 */
export const FEED_SNAPSHOT_TTL_SECONDS = 60 * 30; // 30 min
export const FEED_MAX_ITEMS = 500; // teto defensivo do snapshot congelado

export const feedQuerySchema = paginationQuerySchema.extend({
  seed: z.string().min(1).optional(),
});

export const feedListSchema = z.object({
  data: z.array(gameSchema),
  nextCursor: z.string().nullable(),
  seed: z.string(),
});

export type FeedQuery = z.infer<typeof feedQuerySchema>;
export type FeedList = z.infer<typeof feedListSchema>;

export class FeedQueryDto extends createZodDto(feedQuerySchema) {}
export class FeedListDto extends createZodDto(feedListSchema) {}
