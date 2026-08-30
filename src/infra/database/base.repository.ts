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

/**
 * Shape every org-scoped table exposes to the base repository.
 */
interface OrgScopedTable extends PgTable {
  id: PgColumn;
  organizationId: PgColumn;
  deletedAt?: PgColumn;
}

/**
 * THE org boundary (RN-01, Telas 02/03). Every read and write is filtered by
 * organization_id HERE, so no service can forget it. Crucially,
 * cross-organization access returns 404 — never 403 — so an id in another org
 * can't even be confirmed to exist (acceptance criterion #4).
 *
 * Concrete repositories extend this and add their typed, domain-specific
 * queries on top; they must route all tenant reads/writes through these methods.
 */
export abstract class OrgScopedRepository<
  TSelect extends { id: string },
  TInsert extends Record<string, unknown>,
> {
  protected constructor(
    protected readonly db: Database,
    protected readonly table: OrgScopedTable,
  ) {}

  /** Predicate: row belongs to org and (if soft-deletable) is not deleted. */
  protected orgScope(organizationId: string): SQL {
    const base = eq(this.table.organizationId, organizationId);
    const notDeleted = this.table.deletedAt ? isNull(this.table.deletedAt) : undefined;
    return notDeleted ? (and(base, notDeleted) as SQL) : base;
  }

  /** Returns the row only if it lives in this org; otherwise null. */
  async findByIdInOrg(organizationId: string, id: string): Promise<TSelect | null> {
    // A malformed id is simply "not found" — never a 500 from the uuid cast.
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(this.table)
      .where(and(this.orgScope(organizationId), eq(this.table.id, id)))
      .limit(1);
    return (rows[0] as TSelect | undefined) ?? null;
  }

  /** Same as findByIdInOrg but throws 404 (NOT 403) when absent/cross-org. */
  async getByIdInOrgOrThrow(organizationId: string, id: string): Promise<TSelect> {
    const row = await this.findByIdInOrg(organizationId, id);
    if (!row) throw AppException.notFound();
    return row;
  }

  /** Cursor-paginated list scoped to the org, newest first (UUIDv7 order). */
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

  /** Insert forcing organization_id to the caller's org — never trust input. */
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

  /** Update only within the org; 404 if the row isn't in this org. */
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

  /** Soft-delete within the org (requires a deletedAt column); 404 if absent. */
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
