import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { primaryId } from './_helpers';

/**
 * Append-only audit trail (Tela 20). Written by the AuditInterceptor from
 * intents declared by services. organization_id / actor are nullable so
 * pre-auth events (e.g. failed login) can still be recorded later.
 * No updated_at / deleted_at — audit rows are immutable.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: primaryId(),
    organizationId: uuid('organization_id'),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: uuid('entity_id'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: text('ip'),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_org_idx').on(t.organizationId),
    index('audit_log_entity_idx').on(t.entity, t.entityId),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditLogRow = typeof auditLog.$inferInsert;
