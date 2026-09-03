import { and, desc, eq, isNull, lt, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import { AppException } from '../../shared/errors/app.exception';
import {
  buildPage,
  decodeCursor,
  type Page,
  type PaginationQuery,
} from '../../shared/pagination/pagination';
import { isUuid } from '../../shared/util/uuid';
import type { Database } from './database.module';

interface OrgScopedTable extends PgTable {
  id: PgColumn;
  organizationId: PgColumn;
  deletedAt?: PgColumn;
}

export abstract class OrgScopedRepository<
  TSelect extends { id: string },
  TInsert extends Record<string, unknown>,
> {
  protected constructor(
    protected readonly db: Database,
    protected readonly table: OrgScopedTable,
  ) {}

  protected orgScope(organizationId: string): SQL {
    const base = eq(this.table.organizationId, organizationId);
    const notDeleted = this.table.deletedAt ? isNull(this.table.deletedAt) : undefined;
    return notDeleted ? (and(base, notDeleted) as SQL) : base;
  }

  async findByIdInOrg(organizationId: string, id: string): Promise<TSelect | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(this.table)
      .where(and(this.orgScope(organizationId), eq(this.table.id, id)))
      .limit(1);
    return (rows[0] as TSelect | undefined) ?? null;
  }

  async getByIdInOrgOrThrow(organizationId: string, id: string): Promise<TSelect> {
    const row = await this.findByIdInOrg(organizationId, id);
    if (!row) throw AppException.notFound();
    return row;
  }

  async listInOrg(organizationId: string, query: PaginationQuery): Promise<Page<TSelect>> {
    const cursorId = decodeCursor(query.cursor);
    const where = cursorId
      ? and(this.orgScope(organizationId), lt(this.table.id, cursorId))
      : this.orgScope(organizationId);

    const rows = (await this.db
      .select()
      .from(this.table)
      .where(where)
      .orderBy(desc(this.table.id))
      .limit(query.limit + 1)) as TSelect[];

    return buildPage(rows, query.limit);
  }

  async createInOrg(
    organizationId: string,
    values: Omit<TInsert, 'organizationId'>,
  ): Promise<TSelect> {
    const rows = await this.db
      .insert(this.table)
      .values({ ...values, organizationId } as unknown as TInsert)
      .returning();
    return rows[0] as TSelect;
  }

  async updateByIdInOrg(
    organizationId: string,
    id: string,
    patch: Partial<TInsert>,
  ): Promise<TSelect> {
    const rows = await this.db
      .update(this.table)
      .set(patch)
      .where(and(this.orgScope(organizationId), eq(this.table.id, id)))
      .returning();
    if (rows.length === 0) throw AppException.notFound();
    return rows[0] as TSelect;
  }

  async softDeleteByIdInOrg(organizationId: string, id: string): Promise<void> {
    if (!this.table.deletedAt) {
      throw new Error(`${String(this.table)} has no deletedAt column to soft-delete`);
    }
    const rows = await this.db
      .update(this.table)
      .set({ deletedAt: new Date() } as unknown as Partial<TInsert>)
      .where(and(this.orgScope(organizationId), eq(this.table.id, id)))
      .returning({ id: this.table.id });
    if (rows.length === 0) throw AppException.notFound();
  }
}
