import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { paginationQuerySchema } from '../../../shared/pagination/pagination';

/**
 * Query for GET /audit-logs (ORB-M2-08, Tela 20): cursor pagination
 * (inherited from paginationQuerySchema) + filters by actor, action and a
 * created_at range.
 */
export const auditLogQuerySchema = paginationQuerySchema.extend({
  actorUserId: z.string().uuid().optional(),
  action: z.string().min(1).max(200).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export const auditLogEntrySchema = z.object({
  id: z.string(),
  actorUserId: z.string().nullable(),
  actorEmail: z.string().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  createdAt: z.string(),
});

export const auditLogListSchema = z.object({
  data: z.array(auditLogEntrySchema),
  nextCursor: z.string().nullable(),
});

export class AuditLogQueryDto extends createZodDto(auditLogQuerySchema) {}
export class AuditLogListDto extends createZodDto(auditLogListSchema) {}

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type AuditLogEntryView = z.infer<typeof auditLogEntrySchema>;
