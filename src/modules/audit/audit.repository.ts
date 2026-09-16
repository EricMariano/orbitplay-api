import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, lte, lt } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { auditLog, type NewAuditLogRow } from '../../infra/database/schema/audit-log';
import { users } from '../../infra/database/schema/users';
import { buildPage, decodeCursor, type Page } from '../../shared/pagination/pagination';
import type { AuditLogQuery } from './dto/audit-log.dto';

export interface AuditLogEntryRow {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  createdAt: Date;
}

@Injectable()
export class AuditRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async insertMany(rows: NewAuditLogRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.insert(auditLog).values(rows);
  }

  /** Test/utility helper: how many audit rows exist for an entity id. */
  async countForEntity(entity: string, entityId: string): Promise<number> {
    const result = await this.db
      .select({ value: count() })
      .from(auditLog)
      .where(and(eq(auditLog.entity, entity), eq(auditLog.entityId, entityId)));
    return result[0]?.value ?? 0;
  }

  /**
   * Cursor page of the org's audit trail (ORB-M2-08), left-joined with
   * `users` for `actorEmail` — the actor can be null (pre-auth events) or a
   * user later deleted. Filters: actor, exact action, created_at range.
   */
  async listForOrg(organizationId: string, query: AuditLogQuery): Promise<Page<AuditLogEntryRow>> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [eq(auditLog.organizationId, organizationId)];
    if (cursorId) filters.push(lt(auditLog.id, cursorId));
    if (query.actorUserId) filters.push(eq(auditLog.actorUserId, query.actorUserId));
    if (query.action) filters.push(eq(auditLog.action, query.action));
    if (query.from) filters.push(gte(auditLog.createdAt, new Date(query.from)));
    if (query.to) filters.push(lte(auditLog.createdAt, new Date(query.to)));

    const rows = await this.db
      .select({
        id: auditLog.id,
        actorUserId: auditLog.actorUserId,
        actorEmail: users.email,
        action: auditLog.action,
        entity: auditLog.entity,
        entityId: auditLog.entityId,
        before: auditLog.before,
        after: auditLog.after,
        createdAt: auditLog.createdAt,
      })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorUserId, users.id))
      .where(and(...filters))
      .orderBy(desc(auditLog.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
  }
}
