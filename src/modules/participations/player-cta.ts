import type { TestRow } from '../../infra/database/schema/tests';
import type { ParticipationStatus } from './dto/participation.dto';
import type { TestCta } from './dto/player-catalog.dto';

type AvailabilityFields = Pick<TestRow, 'status' | 'endsAt' | 'slotsTotal' | 'slotsTaken'>;

/**
 * Tela 13 RN-04 / Tela 14 RN-01: why a player can't join this test right now,
 * or `null` when it's open. The "open" branch is mirrored in SQL by
 * `ParticipationsRepository.findOpenTestStats` — keep both in sync.
 */
export function testUnavailableReason(test: AvailabilityFields, now: Date): string | null {
  switch (test.status) {
    case 'paused':
      return 'Teste pausado pelo estúdio';
    case 'finished':
      return 'Teste encerrado';
    case 'expired':
      return 'Teste expirado';
    case 'published':
      break;
    default:
      return 'Teste indisponível';
  }
  if (test.endsAt && test.endsAt.getTime() <= now.getTime()) return 'Teste expirado';
  if (test.slotsTaken >= test.slotsTotal) return 'Vagas esgotadas';
  return null;
}

/**
 * Tela 15 RN-01: the CTA is decided here, never inferred by the UI.
 *
 * An active participation wins over the test's availability — a player who
 * already holds a slot can resume even if the test filled up or got paused
 * since. `abandoned`/`rejected` don't hold a slot (see
 * `participations_active_test_user_unique`), so they fall back to whether a
 * new participation could start.
 */
export function testCta(
  participationStatus: ParticipationStatus | null,
  unavailableReason: string | null,
): { cta: TestCta; disabledReason: string | null } {
  switch (participationStatus) {
    case 'completed':
      return { cta: 'completed', disabledReason: null };
    case 'in_review':
      return { cta: 'in_review', disabledReason: null };
    case 'downloading':
      return { cta: 'downloading', disabledReason: null };
    case 'reserved':
    case 'tutorial':
    case 'ready':
    case 'playing':
    case 'form_pending':
      return { cta: 'continue', disabledReason: null };
    default:
      return unavailableReason
        ? { cta: 'unavailable', disabledReason: unavailableReason }
        : { cta: 'start', disabledReason: null };
  }
}
