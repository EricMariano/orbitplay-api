import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Deviation from `openapi.design.yaml` (documented in DECISIONS.md §3): the
 * migrated `post_status` enum is `visible | hidden | removed`, not the
 * design's `visible | hidden | pinned` — there is no `pinned` column. The
 * moderate action follows the real enum: `hide | restore | remove`, not the
 * design's `hide | restore | pin | unpin`.
 */
export const postStatusValues = ['visible', 'hidden', 'removed'] as const;
export type PostStatus = (typeof postStatusValues)[number];

export const communityPostSchema = z.object({
  id: z.string(),
  gameId: z.string(),
  authorUserId: z.string(),
  authorDisplayName: z.string(),
  body: z.string(),
  status: z.enum(postStatusValues),
  createdAt: z.string(),
});

export const communityPostListSchema = z.object({
  data: z.array(communityPostSchema),
  nextCursor: z.string().nullable(),
});

export const createCommunityPostSchema = z.object({
  body: z.string().min(1, 'Publicação vazia').max(5000),
});

export const reportReasonValues = ['spam', 'abuse', 'spoiler', 'other'] as const;

export const reportPostSchema = z.object({
  reason: z.enum(reportReasonValues),
  details: z.string().max(1000).optional(),
});

export const moderatePostActionValues = ['hide', 'restore', 'remove'] as const;

export const moderatePostSchema = z.object({
  action: z.enum(moderatePostActionValues),
  reason: z.string().max(1000).optional(),
});

export const reviewSchema = z.object({
  id: z.string(),
  gameId: z.string(),
  authorUserId: z.string(),
  authorDisplayName: z.string(),
  rating: z.number().int().min(1).max(5),
  body: z.string().nullable(),
  createdAt: z.string(),
});

export const reviewListSchema = z.object({
  data: z.array(reviewSchema),
  nextCursor: z.string().nullable(),
  averageRating: z.number().nullable(),
});

export const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().max(5000).optional(),
});

export type CommunityPostView = z.infer<typeof communityPostSchema>;
export type CreateCommunityPostDto = z.infer<typeof createCommunityPostSchema>;
export type ReportPostDto = z.infer<typeof reportPostSchema>;
export type ModeratePostDto = z.infer<typeof moderatePostSchema>;
export type ReviewView = z.infer<typeof reviewSchema>;
export type CreateReviewDto = z.infer<typeof createReviewSchema>;

export class CommunityPostDto extends createZodDto(communityPostSchema) {}
export class CommunityPostListDto extends createZodDto(communityPostListSchema) {}
export class CreateCommunityPostRequestDto extends createZodDto(createCommunityPostSchema) {}
export class ReportPostRequestDto extends createZodDto(reportPostSchema) {}
export class ModeratePostRequestDto extends createZodDto(moderatePostSchema) {}
export class ReviewDto extends createZodDto(reviewSchema) {}
export class ReviewListDto extends createZodDto(reviewListSchema) {}
export class CreateReviewRequestDto extends createZodDto(createReviewSchema) {}
