import { describe, expect, it } from 'vitest';
import { buildPage, decodeCursor, encodeCursor } from './pagination';

describe('pagination', () => {
  it('round-trips a cursor', () => {
    const id = '01920000-0000-7000-8000-0000000000d1';
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it('decodes an undefined cursor to undefined', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
  });

  it('returns no nextCursor when rows fit within the limit', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const page = buildPage(rows, 5);
    expect(page.nextCursor).toBeNull();
    expect(page.data).toHaveLength(2);
  });

  it('drops the extra row and exposes its predecessor as nextCursor', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const page = buildPage(rows, 2);
    expect(page.data).toHaveLength(2);
    expect(page.data.map((r) => r.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).toBe(encodeCursor('b'));
  });
});
