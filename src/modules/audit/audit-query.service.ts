import { Injectable } from '@nestjs/common';
import type { AuditLogRow } from '../../infra/database/schema/audit-log';
import type { Page } from '../../shared/pagination/pagination';
import type { AuditLogQuery, AuditLogView } from './dto/audit-log.dto';
import { AuditRepository } from './audit.repository';

/**
 * Read side of the audit trail (ORB-M2-06). Kept separate from AuditService
 * (the AuditRecorder implementation used by the interceptor to persist
 * records) so writing and querying audit data stay single-responsibility.
 */
@Injectable()
export class AuditQueryService {
  constructor(private readonly repo: AuditRepository) {}

  async list(organizationId: string, query: AuditLogQuery): Promise<Page<AuditLogView>> {
    const page = await this.repo.listInOrg(organizationId, {
      limit: query.limit,
      cursor: query.cursor,
      actorUserId: query.actorUserId,
      action: query.action,
      entity: query.entity,
      entityId: query.entityId,
      // DTO carries from/to as ISO strings (so the Zod schema stays
      // JSON-Schema-representable for openapi:generate) — converted to Date
      // here, right at the boundary to the repository.
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
    return { data: page.data.map(toView), nextCursor: page.nextCursor };
  }
}

function toView(row: AuditLogRow): AuditLogView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    actorUserId: row.actorUserId,
    action: row.action,
    entity: row.entity,
    entityId: row.entityId,
    before: toJsonObject(row.before),
    after: toJsonObject(row.after),
    ip: row.ip,
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `before`/`after` are `jsonb` columns — Drizzle infers them as `unknown`.
 * AuditInterceptor only ever writes plain objects (snapshots of a DTO/view)
 * or null into them, so a plain-object guard is a safe, honest narrowing —
 * not a blind cast — for the DTO's `Record<string, unknown> | null` shape.
 */
function toJsonObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}
