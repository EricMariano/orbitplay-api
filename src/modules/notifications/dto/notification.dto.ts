import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { paginationQuerySchema } from '../../../shared/pagination/pagination';

/**
 * Query strings arrive as text. `z.coerce.boolean()` would treat the string
 * `"false"` as true, so the flag is accepted only as a real boolean or the
 * literals `"true"` / `"false"`.
 */
const unreadOnlySchema = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .optional()
  .transform((value) => value === true || value === 'true');

export const notificationQuerySchema = paginationQuerySchema.extend({
  unreadOnly: unreadOnlySchema,
});

/** Contract from `openapi.design.yaml`: DB `kind` is exposed as `type`. */
export const notificationSchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  body: z.string().nullable(),
  link: z.string().nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});

export const notificationListSchema = z.object({
  data: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().int(),
});

export class NotificationQueryDto extends createZodDto(notificationQuerySchema) {}
export class NotificationDto extends createZodDto(notificationSchema) {}
export class NotificationListDto extends createZodDto(notificationListSchema) {}

export type NotificationQuery = z.infer<typeof notificationQuerySchema>;
export type NotificationView = z.infer<typeof notificationSchema>;
