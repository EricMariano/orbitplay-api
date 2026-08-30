import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { auditLog, type NewAuditLogRow } from '../../infra/database/schema/audit-log';

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
}
