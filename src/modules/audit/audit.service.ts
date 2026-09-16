import { Injectable } from '@nestjs/common';
import { newId } from '../../infra/database/schema/_helpers';
import type { NewAuditLogRow } from '../../infra/database/schema/audit-log';
import type { Page } from '../../shared/pagination/pagination';
import type { AuditRecord, AuditRecorder } from '../../shared/audit/audit-recorder';
import type { AuditLogEntryView, AuditLogQuery } from './dto/audit-log.dto';
import { AuditRepository } from './audit.repository';

/**
 * Persists audit records declared by services and stamped by the
 * AuditInterceptor. Implements the AuditRecorder port so the interceptor stays
 * decoupled from the database.
 */
@Injectable()
export class AuditService implements AuditRecorder {
  constructor(private readonly repo: AuditRepository) {}

  async record(records: AuditRecord[]): Promise<void> {
    const rows: NewAuditLogRow[] = records.map((r) => ({
      id: newId(),
      organizationId: r.organizationId,
      actorUserId: r.actorUserId,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId ?? null,
      before: r.before ?? null,
      after: r.after ?? null,
      ip: r.ip,
      requestId: r.requestId,
    }));
    await this.repo.insertMany(rows);
  }

  countForEntity(entity: string, entityId: string): Promise<number> {
    return this.repo.countForEntity(entity, entityId);
  }

  async listForOrg(organizationId: string, query: AuditLogQuery): Promise<Page<AuditLogEntryView>> {
    const page = await this.repo.listForOrg(organizationId, query);
    return {
      data: page.data.map((r) => ({
        id: r.id,
        actorUserId: r.actorUserId,
        actorEmail: r.actorEmail,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        before: r.before,
        after: r.after,
        createdAt: r.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
