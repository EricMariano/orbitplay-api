import { describe, expect, it } from 'vitest';
import { groupEvolutionByWeek } from './report-weeks';

describe('groupEvolutionByWeek', () => {
  it('returns no weeks without sessions', () => {
    expect(groupEvolutionByWeek([], '2026-01-01')).toEqual([]);
  });

  it('counts weeks from the test start and fills idle weeks with zero', () => {
    const weeks = groupEvolutionByWeek(
      [
        { date: '2026-01-01', sessions: 2 },
        { date: '2026-01-07', sessions: 1 },
        { date: '2026-01-20', sessions: 4 },
      ],
      '2026-01-01',
    );

    expect(weeks).toEqual([
      { week: 1, startDate: '2026-01-01', sessions: 3 },
      { week: 2, startDate: '2026-01-08', sessions: 0 },
      { week: 3, startDate: '2026-01-15', sessions: 4 },
    ]);
  });

  it('starts at the first session when the test has no start date', () => {
    expect(groupEvolutionByWeek([{ date: '2026-03-10', sessions: 5 }], null)).toEqual([
      { week: 1, startDate: '2026-03-10', sessions: 5 },
    ]);
  });

  it('puts sessions before the start date in week 1', () => {
    expect(groupEvolutionByWeek([{ date: '2025-12-30', sessions: 1 }], '2026-01-01')).toEqual([
      { week: 1, startDate: '2026-01-01', sessions: 1 },
    ]);
  });
});
