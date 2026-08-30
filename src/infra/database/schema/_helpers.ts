import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { v7 as uuidv7 } from 'uuid';

/**
 * Primary key column: UUID v7 (time-ordered → index-friendly and paginatable).
 * Generated in the application so ids are known before the row hits the DB.
 */
export const primaryId = () =>
  uuid('id')
    .primaryKey()
    .$defaultFn(() => uuidv7());

/** A UUID v7 value generated the same way as primary keys (for non-PK ids). */
export const newId = (): string => uuidv7();

/** created_at / updated_at present on every table. */
export const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

/** Soft-delete marker — used where the handoff wants deactivation over deletion. */
export const softDelete = {
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
};
