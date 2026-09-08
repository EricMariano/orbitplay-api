import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_helpers';
import {
  participationStatusEnum,
  processingStatusEnum,
  recordingKindEnum,
  sessionStatusEnum,
} from './enums';
import { organizations } from './organizations';
import { testFormQuestions, tests } from './tests';
import { users } from './users';

/**
 * A player occupying a slot on a test. The partial unique on (test_id, user_id)
 * while status is active is what stops two simultaneous reservations (Tela 14
 * RN-02) — a race is not solvable in service code.
 */
export const participations = pgTable(
  'participations',
  {
    id: primaryId(),
    testId: uuid('test_id')
      .notNull()
      .references(() => tests.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: participationStatusEnum('status').notNull().default('reserved'),
    resumePoint: text('resume_point'),
    idempotencyKey: text('idempotency_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('participations_test_user_idx').on(t.testId, t.userId),
    uniqueIndex('participations_active_test_user_unique')
      .on(t.testId, t.userId)
      .where(
        sql`${t.status} IN ('reserved', 'tutorial', 'downloading', 'ready', 'playing', 'form_pending', 'in_review')`,
      ),
  ],
);

/** Consent recorded BEFORE the session when required. Append-only proof. */
export const sessionConsents = pgTable('session_consents', {
  participationId: uuid('participation_id')
    .primaryKey()
    .references(() => participations.id, { onDelete: 'cascade' }),
  screenRecording: boolean('screen_recording').notNull().default(false),
  audio: boolean('audio').notNull().default(false),
  microphone: boolean('microphone').notNull().default(false),
  webcam: boolean('webcam').notNull().default(false),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  ip: text('ip'),
  userAgent: text('user_agent'),
});

export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    participationId: uuid('participation_id')
      .notNull()
      .references(() => participations.id, { onDelete: 'cascade' }),
    testId: uuid('test_id')
      .notNull()
      .references(() => tests.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    status: sessionStatusEnum('status').notNull().default('starting'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),
    finishIdempotencyKey: text('finish_idempotency_key'),
  },
  (t) => [index('sessions_test_idx').on(t.testId)],
);

export const sessionDeviceEvents = pgTable(
  'session_device_events',
  {
    id: primaryId(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    tMs: integer('t_ms').notNull(),
    kind: text('kind').notNull(),
    value: boolean('value').notNull(),
  },
  (t) => [index('session_device_events_idx').on(t.sessionId, t.tMs)],
);

/**
 * One media object belonging to a session. Missing / failed / still-processing
 * recordings do NOT take the rest of the session down (Tela 12 RN-03) — the
 * status lives on this row, never on `sessions`. `t_ms` is not a column here;
 * the temporal anchor stays on `session_device_events` (M8).
 */
export const sessionRecordings = pgTable(
  'session_recordings',
  {
    id: primaryId(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: recordingKindEnum('kind').notNull(),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    durationMs: integer('duration_ms'),
    status: processingStatusEnum('status').notNull().default('processing'),
    thumbnailKey: text('thumbnail_key'),
  },
  (t) => [index('session_recordings_session_idx').on(t.sessionId)],
);

/**
 * Trigger for XP, achievement and reward. Own table (not a field on sessions)
 * so the transition is a single transactional insert (Tela 19 RN-03).
 */
export const sessionValidations = pgTable('session_validations', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => sessions.id, { onDelete: 'cascade' }),
  valid: boolean('valid'),
  reason: text('reason'),
  validatorVersion: text('validator_version'),
  validatedAt: timestamp('validated_at', { withTimezone: true }),
});

export const formResponses = pgTable(
  'form_responses',
  {
    id: primaryId(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key'),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('form_responses_session_unique').on(t.sessionId)],
);

export const formAnswers = pgTable('form_answers', {
  id: primaryId(),
  responseId: uuid('response_id')
    .notNull()
    .references(() => formResponses.id, { onDelete: 'cascade' }),
  questionId: uuid('question_id')
    .notNull()
    .references(() => testFormQuestions.id),
  valueText: text('value_text'),
  valueNumber: numeric('value_number'),
  valueBoolean: boolean('value_boolean'),
  optionIds: uuid('option_ids').array(),
});

export type ParticipationRow = typeof participations.$inferSelect;
export type NewParticipationRow = typeof participations.$inferInsert;
export type SessionConsentRow = typeof sessionConsents.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type SessionDeviceEventRow = typeof sessionDeviceEvents.$inferSelect;
export type SessionRecordingRow = typeof sessionRecordings.$inferSelect;
export type NewSessionRecordingRow = typeof sessionRecordings.$inferInsert;
export type SessionValidationRow = typeof sessionValidations.$inferSelect;
export type FormResponseRow = typeof formResponses.$inferSelect;
export type FormAnswerRow = typeof formAnswers.$inferSelect;
