import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

/**
 * Single, cursor-based pagination convention for the whole API.
 * Request:  ?limit=20&cursor=<opaque>
 * Response: { data: T[], nextCursor: string | null }
 *
 * Cursors are opaque base64url of the last row's UUIDv7 id. Because ids are
 * time-ordered, this gives stable chronological paging without offsets.
 */
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export class PaginationQueryDto extends createZodDto(paginationQuerySchema) {}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (!cursor) return undefined;
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
}

/**
 * Build a page from rows fetched with (limit + 1). If an extra row came back,
 * there's a next page; drop it and expose its predecessor's id as the cursor.
 */
export function buildPage<T extends { id: string }>(rows: T[], limit: number): Page<T> {
  if (rows.length > limit) {
    const data = rows.slice(0, limit);
    return { data, nextCursor: encodeCursor(data[data.length - 1].id) };
  }
  return { data: rows, nextCursor: null };
}
