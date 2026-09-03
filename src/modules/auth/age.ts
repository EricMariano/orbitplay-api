/**
 * Platform is 18+ (DECISIONS.md §1.4). Birthdate is an ISO date string
 * (`YYYY-MM-DD`). Comparison is done in UTC so the result is independent of
 * the server's local timezone.
 */
export function isAtLeast18(birthdate: string, now: Date = new Date()): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthdate);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const birth = new Date(Date.UTC(year, month - 1, day));
  // Reject invalid calendar dates (e.g. 2020-02-30 → rolls to March).
  if (
    birth.getUTCFullYear() !== year ||
    birth.getUTCMonth() !== month - 1 ||
    birth.getUTCDate() !== day
  ) {
    return false;
  }

  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (birth.getTime() > todayUtc.getTime()) return false;

  const eighteenth = new Date(Date.UTC(year + 18, month - 1, day));
  return eighteenth.getTime() <= todayUtc.getTime();
}
