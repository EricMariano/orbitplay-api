import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, lt, lte, type SQL } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import {
  auditLog,
  type AuditLogRow,
  type NewAuditLogRow,
} from '../../infra/database/schema/audit-log';
import { buildPage, decodeCursor, type Page } from '../../shared/pagination/pagination';

/**
 * Single, well-typed filter object for reads (Interface Segregation) instead
 * of a near-duplicate repository method per filter (by actor, by action, by
 * period, ...). All fields map to columns that already exist on `audit_log`.
 */
export interface AuditLogFilter {
  actorUserId?: string;
  action?: string;
  entity?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
}

export interface AuditLogListQuery extends AuditLogFilter {
  limit: number;
  cursor?: string;
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
   * Paginated audit trail for one organization (RN-01 — filtered here, in the
   * repository, never left to the service). `organizationId` is not optional:
   * a caller always belongs to exactly one org (its token), and the audit_log
   * column being nullable only accounts for pre-auth events, never for a
   * cross-org read. Ordered by id (UUIDv7, time-ordered) like every other
   * cursor-paginated listing in the project.
   */
  async listInOrg(organizationId: string, query: AuditLogListQuery): Promise<Page<AuditLogRow>> {
    const cursorId = decodeCursor(query.cursor);
    const conditions: SQL[] = [eq(auditLog.organizationId, organizationId)];

    if (cursorId) conditions.push(lt(auditLog.id, cursorId));
    if (query.actorUserId) conditions.push(eq(auditLog.actorUserId, query.actorUserId));
    if (query.action) conditions.push(eq(auditLog.action, query.action));
    if (query.entity) conditions.push(eq(auditLog.entity, query.entity));
    if (query.entityId) conditions.push(eq(auditLog.entityId, query.entityId));
    if (query.from) conditions.push(gte(auditLog.createdAt, query.from));
    if (query.to) conditions.push(lte(auditLog.createdAt, query.to));

    const rows = await this.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
  }
}
