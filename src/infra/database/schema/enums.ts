import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Trigger type enum — FROZEN now (section 9). The plug-in SDK and already-
 * published builds depend on these values; changing them later breaks them.
 *   counter  — integer
 *   timer    — milliseconds
 *   ui_event — integer + context
 *   vector   — x, y, z
 *   input    — integer
 */
export const triggerTypeEnum = pgEnum('trigger_type', [
  'counter',
  'timer',
  'ui_event',
  'vector',
  'input',
]);

/** Lifecycle status for a game. */
export const gameStatusEnum = pgEnum('game_status', ['draft', 'active', 'archived']);

/** Membership status (deactivation over deletion for history). */
export const membershipStatusEnum = pgEnum('membership_status', ['active', 'invited', 'disabled']);
