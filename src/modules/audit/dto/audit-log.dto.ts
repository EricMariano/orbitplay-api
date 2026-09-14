import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { paginationQuerySchema } from '../../../shared/pagination/pagination';

/**
 * Query for GET /audit-logs (ORB-M2-06). Extends the project's single cursor
 * pagination schema (see `games` for the same pattern) instead of redefining
 * limit/cursor here.
 *
 * Filters are limited to columns that already exist on `audit_log`
 * (actorUserId, action, entity, entityId, createdAt) — no schema change was
 * needed. `from`/`to` bound `createdAt` (inclusive), both optional and
 * independently usable.
 *
 * `from`/`to` stay as ISO datetime STRINGS here (not z.coerce.date()) on
 * purpose: nestjs-zod generates the OpenAPI schema from this same Zod schema,
 * and a native `Date` has no JSON Schema representation — `pnpm
 * openapi:generate` fails with "Date cannot be represented in JSON Schema" if
 * this field is a date type. The string -> Date conversion happens in
 * AuditQueryService instead, right before hitting the repository.
 */
export const auditLogQuerySchema = paginationQuerySchema.extend({
  actorUserId: z.string().uuid('actorUserId deve ser um UUID válido').optional(),
  action: z.string().min(1).max(200).optional(),
  entity: z.string().min(1).max(200).optional(),
  entityId: z.string().uuid('entityId deve ser um UUID válido').optional(),
  from: z.iso
    .datetime({ offset: true, message: 'from deve ser uma data ISO 8601 válida' })
    .optional(),
  to: z.iso.datetime({ offset: true, message: 'to deve ser uma data ISO 8601 válida' }).optional(),
});

/** Public representation of an audit log row. */
export const auditLogSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  actorUserId: z.string().nullable(),
  action: z.string(),
  entity: z.string(),
  entityId: z.string().nullable(),
  // `before`/`after` are free-form JSON snapshots (jsonb in audit_log) — kept
  // as an open object map rather than z.unknown(), which is a safer bet for
  // JSON Schema generation than an unconstrained/untyped field.
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  ip: z.string().nullable(),
  requestId: z.string().nullable(),
  createdAt: z.string(),
});

export const auditLogListSchema = z.object({
  data: z.array(auditLogSchema),
  nextCursor: z.string().nullable(),
});

export class AuditLogQueryDto extends createZodDto(auditLogQuerySchema) {}
export class AuditLogDto extends createZodDto(auditLogSchema) {}
export class AuditLogListDto extends createZodDto(auditLogListSchema) {}

export type AuditLogQuery = z.infer<typeof auditLogQuerySchema>;
export type AuditLogView = z.infer<typeof auditLogSchema>;
