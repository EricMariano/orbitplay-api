import { describe, expect, it } from 'vitest';
import { isAtLeast18 } from './age';

/** Fixed "today" so the suite is deterministic. */
const TODAY = new Date('2026-09-03T12:00:00.000Z');

describe('isAtLeast18', () => {
  it('rejects someone who turns 18 tomorrow (17 years + almost 1 year)', () => {
    expect(isAtLeast18('2008-09-04', TODAY)).toBe(false);
  });

  it('accepts someone who turns 18 today', () => {
    expect(isAtLeast18('2008-09-03', TODAY)).toBe(true);
  });

  it('accepts someone who turned 18 yesterday', () => {
    expect(isAtLeast18('2008-09-02', TODAY)).toBe(true);
  });

  it('rejects a future birthdate', () => {
    expect(isAtLeast18('2030-01-01', TODAY)).toBe(false);
  });

  it('rejects malformed or impossible dates', () => {
    expect(isAtLeast18('not-a-date', TODAY)).toBe(false);
    expect(isAtLeast18('2020-02-30', TODAY)).toBe(false);
  });
});
