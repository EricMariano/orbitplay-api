import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { primaryId, timestamps } from './_helpers';
import {
  buildStatusEnum,
  buildStepKeyEnum,
  processingStatusEnum,
  questionTypeEnum,
  reportStageEnum,
  testModelKeyEnum,
  testStatusEnum,
  wizardStepEnum,
} from './enums';
import { games } from './games';
import { organizations } from './organizations';

/**
 * A playtest owned by one game/org. Born as `draft`; the wizard is a
 * server-persisted draft (`current_step`). `slots_taken` is a concurrent
 * counter — increment with `UPDATE … WHERE slots_taken < slots_total`.
 */
export const tests = pgTable(
  'tests',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // No single-column .references() here on purpose — the composite FK
    // below (gameId, organizationId) is what actually enforces the
    // relationship (DAT-03).
    gameId: uuid('game_id').notNull(),
    name: text('name'),
    modelKey: testModelKeyEnum('model_key').notNull(),
    status: testStatusEnum('status').notNull().default('draft'),
    currentStep: wizardStepEnum('current_step').notNull().default('model'),
    slotsTotal: integer('slots_total').notNull().default(0),
    slotsTaken: integer('slots_taken').notNull().default(0),
    durationDays: integer('duration_days'),
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    publishIdempotencyKey: text('publish_idempotency_key'),
    rewardAmountCents: integer('reward_amount_cents'),
    rewardCurrency: text('reward_currency'),
    reportStage: reportStageEnum('report_stage').notNull().default('none'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('tests_publish_idempotency_key_unique').on(t.publishIdempotencyKey),
    index('tests_org_idx').on(t.organizationId),
    index('tests_game_status_idx').on(t.gameId, t.status),
    index('tests_feed_idx').on(t.status, t.endsAt),
    // DAT-03: composite FK — a test's organizationId must match the org
    // that actually owns its game; a plain gameId → games.id FK can't see
    // that mismatch at all.
    foreignKey({
      name: 'tests_game_org_fk',
      columns: [t.gameId, t.organizationId],
      foreignColumns: [games.id, games.organizationId],
    }).onDelete('cascade'),
    // Referenced by builds' own composite FK below, the same way
    // games_id_org_unique backs this table's own FK into games.
    uniqueIndex('tests_id_org_unique').on(t.id, t.organizationId),
  ],
);

export const testAudienceCriteria = pgTable('test_audience_criteria', {
  testId: uuid('test_id')
    .primaryKey()
    .references(() => tests.id, { onDelete: 'cascade' }),
  countries: text('countries').array(),
  archetypes: text('archetypes').array(),
  platforms: text('platforms').array(),
  ageMin: integer('age_min'),
  ageMax: integer('age_max'),
  testerCount: integer('tester_count'),
  keepActive: boolean('keep_active').notNull().default(true),
  estimatedReach: integer('estimated_reach'),
});

export const testFormQuestions = pgTable(
  'test_form_questions',
  {
    id: primaryId(),
    testId: uuid('test_id')
      .notNull()
      .references(() => tests.id, { onDelete: 'cascade' }),
    type: questionTypeEnum('type').notNull(),
    label: text('label').notNull(),
    helpText: text('help_text'),
    required: boolean('required').notNull().default(false),
    position: integer('position').notNull(),
    scaleMin: integer('scale_min'),
    scaleMax: integer('scale_max'),
  },
  (t) => [uniqueIndex('test_form_questions_order_unique').on(t.testId, t.position)],
);

export const testFormOptions = pgTable(
  'test_form_options',
  {
    id: primaryId(),
    questionId: uuid('question_id')
      .notNull()
      .references(() => testFormQuestions.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [uniqueIndex('test_form_options_order_unique').on(t.questionId, t.position)],
);

/**
 * One build per test (DECISIONS.md §1.3) — a hard DB invariant, not just an
 * application-level check (DAT-02): `confirmBuild` always deletes the
 * previous row (failed build auto-replaced, or explicit `DELETE`) before
 * inserting a new one, so there is never a legitimate reason for two build
 * rows to exist for the same test at once. `builds_test_id_unique` makes
 * that a guarantee the database itself enforces — a concurrent insert (or
 * any future write path that forgets the app-level rule) fails with a
 * constraint violation instead of silently leaving two rows behind. Bytes
 * live in MinIO; the API only issues presigned PUTs and never proxies the
 * file.
 */
export const builds = pgTable(
  'builds',
  {
    id: primaryId(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // No single-column .references() here on purpose — the composite FK
    // below (testId, organizationId) is what actually enforces the
    // relationship (DAT-03).
    testId: uuid('test_id').notNull(),
    fileName: text('file_name').notNull(),
    version: text('version'),
    platform: text('platform'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    checksum: text('checksum'),
    storageKey: text('storage_key').notNull(),
    status: buildStatusEnum('status').notNull().default('awaiting_upload'),
    failureReason: text('failure_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('builds_test_id_unique').on(t.testId),
    // DAT-03: a build's organizationId must match the org that actually
    // owns the test it belongs to.
    foreignKey({
      name: 'builds_test_org_fk',
      columns: [t.testId, t.organizationId],
      foreignColumns: [tests.id, tests.organizationId],
    }).onDelete('cascade'),
  ],
);

/**
 * Validation is a list of steps, not a boolean — `plugin_manifest` is already
 * in the enum so the plug-in step can land later without a schema change.
 */
export const buildValidationSteps = pgTable(
  'build_validation_steps',
  {
    id: primaryId(),
    buildId: uuid('build_id')
      .notNull()
      .references(() => builds.id, { onDelete: 'cascade' }),
    key: buildStepKeyEnum('key').notNull(),
    status: processingStatusEnum('status').notNull().default('processing'),
    message: text('message'),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('build_validation_steps_unique').on(t.buildId, t.key)],
);

export type TestRow = typeof tests.$inferSelect;
export type NewTestRow = typeof tests.$inferInsert;
export type TestAudienceCriteriaRow = typeof testAudienceCriteria.$inferSelect;
export type TestFormQuestionRow = typeof testFormQuestions.$inferSelect;
export type TestFormOptionRow = typeof testFormOptions.$inferSelect;
export type BuildRow = typeof builds.$inferSelect;
export type NewBuildRow = typeof builds.$inferInsert;
export type BuildValidationStepRow = typeof buildValidationSteps.$inferSelect;
