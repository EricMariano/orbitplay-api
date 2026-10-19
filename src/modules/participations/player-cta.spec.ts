import { describe, expect, it } from 'vitest';
import { testCta, testUnavailableReason } from './player-cta';

const now = new Date('2026-10-12T12:00:00.000Z');
const open = {
  status: 'published' as const,
  endsAt: new Date('2026-10-20T00:00:00.000Z'),
  slotsTotal: 10,
  slotsTaken: 3,
};

describe('testUnavailableReason', () => {
  it('is null for a published test within the deadline with free slots', () => {
    expect(testUnavailableReason(open, now)).toBeNull();
    expect(testUnavailableReason({ ...open, endsAt: null }, now)).toBeNull();
  });

  it('explains why a test that is not published cannot be joined', () => {
    expect(testUnavailableReason({ ...open, status: 'paused' }, now)).toBe(
      'Teste pausado pelo estúdio',
    );
    expect(testUnavailableReason({ ...open, status: 'finished' }, now)).toBe('Teste encerrado');
    expect(testUnavailableReason({ ...open, status: 'expired' }, now)).toBe('Teste expirado');
    expect(testUnavailableReason({ ...open, status: 'draft' }, now)).toBe('Teste indisponível');
  });

  it('treats a passed deadline as expired, even while still published', () => {
    expect(testUnavailableReason({ ...open, endsAt: now }, now)).toBe('Teste expirado');
  });

  it('reports a full test', () => {
    expect(testUnavailableReason({ ...open, slotsTaken: 10 }, now)).toBe('Vagas esgotadas');
  });
});

describe('testCta', () => {
  it('offers start on an open test without participation', () => {
    expect(testCta(null, null)).toEqual({ cta: 'start', disabledReason: null });
  });

  it('is unavailable, with the reason, on a closed test without participation', () => {
    expect(testCta(null, 'Vagas esgotadas')).toEqual({
      cta: 'unavailable',
      disabledReason: 'Vagas esgotadas',
    });
  });

  it.each(['reserved', 'tutorial', 'ready', 'playing', 'form_pending'] as const)(
    'lets an active %s participation continue even if the test closed',
    (status) => {
      expect(testCta(status, 'Vagas esgotadas')).toEqual({ cta: 'continue', disabledReason: null });
    },
  );

  it('maps terminal and in-flight participation states to their own CTA', () => {
    expect(testCta('completed', null).cta).toBe('completed');
    expect(testCta('in_review', null).cta).toBe('in_review');
    expect(testCta('downloading', null).cta).toBe('downloading');
  });

  it('falls back to availability after an abandoned or rejected participation', () => {
    expect(testCta('abandoned', null).cta).toBe('start');
    expect(testCta('rejected', 'Teste encerrado')).toEqual({
      cta: 'unavailable',
      disabledReason: 'Teste encerrado',
    });
  });
});
