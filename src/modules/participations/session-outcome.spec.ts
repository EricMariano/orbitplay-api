import { describe, expect, it } from 'vitest';
import { participationStatusValues } from './dto/participation.dto';
import { holdsSlot } from './session-outcome';

describe('holdsSlot (M8-03)', () => {
  it('only abandoned and rejected participations leave their slot free', () => {
    const free = participationStatusValues.filter((status) => !holdsSlot(status));
    expect(free.sort()).toEqual(['abandoned', 'rejected']);
  });

  it('a completed participation keeps its slot', () => {
    expect(holdsSlot('completed')).toBe(true);
  });
});
