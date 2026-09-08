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

export const testStatusEnum = pgEnum('test_status', [
  'draft',
  'published',
  'paused',
  'finished',
  'expired',
]);

export const wizardStepEnum = pgEnum('wizard_step', [
  'model',
  'form',
  'build',
  'audience',
  'review',
]);

export const testModelKeyEnum = pgEnum('test_model_key', [
  'free_exploration_telemetry',
  'free_exploration',
  'ab_test',
  'ab_test_images',
]);

export const questionTypeEnum = pgEnum('question_type', [
  'scale',
  'single_choice',
  'multiple_choice',
  'open_text',
  'boolean',
  'nps',
]);

export const buildStatusEnum = pgEnum('build_status', [
  'awaiting_upload',
  'uploading',
  'processing',
  'validated',
  'failed',
]);

export const buildStepKeyEnum = pgEnum('build_step_key', [
  'checksum',
  'malware_scan',
  'metadata',
  'plugin_manifest',
]);

export const processingStatusEnum = pgEnum('processing_status', [
  'processing',
  'ready',
  'failed',
  'unavailable',
]);

export const participationStatusEnum = pgEnum('participation_status', [
  'reserved',
  'tutorial',
  'downloading',
  'ready',
  'playing',
  'form_pending',
  'in_review',
  'completed',
  'rejected',
  'abandoned',
]);

/** Statuses that still occupy a (test, user) slot — used by the partial unique. */
export const ACTIVE_PARTICIPATION_STATUSES = [
  'reserved',
  'tutorial',
  'downloading',
  'ready',
  'playing',
  'form_pending',
  'in_review',
] as const;

export const sessionStatusEnum = pgEnum('session_status', [
  'starting',
  'recording',
  'paused',
  'finishing',
  'processing',
  'completed',
  'invalidated',
]);

/**
 * Stored recording kinds. SQL keeps `screen | webcam | microphone` — OpenAPI
 * uses `screen_recording | audio | microphone | webcam`. Map at the API
 * boundary; do not add a fourth SQL value. `audio` is a consent flag and the
 * extracted sidecar for future ASR, not a `session_recordings.kind`.
 */
export const recordingKindEnum = pgEnum('recording_kind', ['screen', 'webcam', 'microphone']);

export const assetKindEnum = pgEnum('asset_kind', ['cover', 'banner', 'screenshot']);

export const postStatusEnum = pgEnum('post_status', ['visible', 'hidden', 'removed']);

export const reportStageEnum = pgEnum('report_stage', ['none', 'partial', 'final']);
