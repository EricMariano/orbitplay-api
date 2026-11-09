import { Inject, Injectable } from '@nestjs/common';
import { and, count, countDistinct, desc, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import {
  DRIZZLE,
  type Database,
  type DbExecutor,
  type Transaction,
} from '../../infra/database/database.module';
import { memberships } from '../../infra/database/schema/memberships';
import { roles } from '../../infra/database/schema/roles';
import {
  testAudienceCriteria,
  testFormOptions,
  testFormQuestions,
  tests,
  type NewTestRow,
  type TestAudienceCriteriaRow,
  type TestFormOptionRow,
  type TestFormQuestionRow,
  type TestRow,
} from '../../infra/database/schema/tests';
import { newId } from '../../infra/database/schema/_helpers';
import { users } from '../../infra/database/schema/users';
import { OrgScopedRepository } from '../../infra/database/base.repository';
import { AppException } from '../../shared/errors/app.exception';
import { buildPage, decodeCursor, type Page } from '../../shared/pagination/pagination';
import { isUuid } from '../../shared/util/uuid';
import type { FormQuestionInput, PlayerTierValue, TestListQuery } from './dto/test.dto';

/** `tab=active` (default, Tela 05) — see the note on `testListQuerySchema`. */
const ACTIVE_TEST_STATUSES = ['draft', 'published', 'paused'] as const;

export interface FormQuestionWithOptions extends TestFormQuestionRow {
  options: TestFormOptionRow[];
}

export interface UpsertAudienceInput {
  countries: string[];
  archetypes: string[];
  platforms: string[];
  ageMin: number;
  ageMax: number;
  testerCount: number;
  keepActive: boolean;
  estimatedReach: number;
  playerTier: PlayerTierValue;
  boosted: boolean;
}

@Injectable()
export class TestsRepository extends OrgScopedRepository<TestRow, NewTestRow> {
  constructor(@Inject(DRIZZLE) db: Database) {
    super(db, tests);
  }

  /**
   * Locks the test row (`SELECT ... FOR UPDATE`) for the lifetime of one
   * transaction and hands the caller the locked row plus a scoped updater for
   * it. Any other call that also goes through `withRowLock` for the same
   * test — including `publish` — blocks on the same row lock until this
   * transaction commits or rolls back (CON-01): a wizard edit's child writes
   * (form/audience/build) can no longer land after a concurrent publish
   * already froze the test, because publish can't even read the row's
   * current status until the edit's transaction is done with it, and vice
   * versa.
   *
   * Every write that happens inside `fn` MUST go through `tx` (the third
   * argument), not the repository's pool. That includes child tables: an
   * INSERT into a table with an FK to `tests` (form questions, audience,
   * builds) takes `FOR KEY SHARE` on the parent row, which conflicts with
   * this `FOR UPDATE` — on a separate connection it would wait for `tx` to
   * release the lock while `tx` waits for that same write to resolve,
   * hanging the request forever. `updateTest` is a shortcut for the `tests`
   * row itself, already bound to `tx`.
   */
  async withRowLock<T>(
    organizationId: string,
    id: string,
    fn: (
      test: TestRow,
      updateTest: (patch: Partial<NewTestRow>) => Promise<TestRow>,
      tx: Transaction,
    ) => Promise<T>,
  ): Promise<T> {
    if (!isUuid(id)) throw AppException.notFound();
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(tests)
        .where(and(this.orgScope(organizationId), eq(tests.id, id)))
        .for('update')
        .limit(1);
      const test = rows[0];
      if (!test) throw AppException.notFound();

      const updateTest = async (patch: Partial<NewTestRow>): Promise<TestRow> => {
        const updated = await tx.update(tests).set(patch).where(eq(tests.id, id)).returning();
        return updated[0];
      };

      return fn(test, updateTest, tx);
    });
  }

  /** Tela 05 — cursor page of a game's tests, `tab`/`status` filters. */
  async listByGameInOrg(
    organizationId: string,
    gameId: string,
    query: TestListQuery,
  ): Promise<Page<TestRow>> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [this.orgScope(organizationId), eq(tests.gameId, gameId)];
    if (cursorId) filters.push(lt(tests.id, cursorId));
    if (query.status) {
      filters.push(eq(tests.status, query.status));
    } else if (query.tab === 'active') {
      filters.push(inArray(tests.status, ACTIVE_TEST_STATUSES));
    }

    const rows = await this.db
      .select()
      .from(tests)
      .where(and(...filters))
      .orderBy(desc(tests.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
  }

  async findFormQuestions(testId: string): Promise<FormQuestionWithOptions[]> {
    const questions = await this.db
      .select()
      .from(testFormQuestions)
      .where(eq(testFormQuestions.testId, testId))
      .orderBy(testFormQuestions.position);
    if (questions.length === 0) return [];

    const optionRows = await this.db
      .select()
      .from(testFormOptions)
      .where(
        inArray(
          testFormOptions.questionId,
          questions.map((q) => q.id),
        ),
      );

    const byQuestion = new Map<string, TestFormOptionRow[]>();
    for (const q of questions) byQuestion.set(q.id, []);
    for (const opt of optionRows) byQuestion.get(opt.questionId)?.push(opt);

    return questions.map((q) => ({
      ...q,
      options: (byQuestion.get(q.id) ?? []).sort((a, b) => a.position - b.position),
    }));
  }

  /**
   * Replaces the whole question set in one transaction (RN-03: atomic
   * reordering). `position` from the input is authoritative. Pass the
   * `withRowLock` transaction as `db` (see the note there).
   *
   * One multi-row INSERT for the questions and one for all their options —
   * not one round trip per question. Ids are generated here so options can
   * point at their question before it's inserted; with the DTO caps (100
   * questions × 50 options) both statements stay far below Postgres's 65535
   * bind parameters.
   */
  async replaceForm(
    testId: string,
    questions: FormQuestionInput[],
    db: DbExecutor = this.db,
  ): Promise<FormQuestionWithOptions[]> {
    return db.transaction(async (tx) => {
      await tx.delete(testFormQuestions).where(eq(testFormQuestions.testId, testId));
      if (questions.length === 0) return [];

      const questionValues = questions.map((q) => ({
        id: newId(),
        testId,
        type: q.type,
        label: q.prompt,
        helpText: q.helpText ?? null,
        required: q.required,
        position: q.position,
        scaleMin: q.scaleMin ?? null,
        scaleMax: q.scaleMax ?? null,
        scaleMinLabel: q.scaleMinLabel ?? null,
        scaleMaxLabel: q.scaleMaxLabel ?? null,
      }));
      const optionValues = questions.flatMap((q, index) =>
        (q.options ?? []).map((o) => ({
          id: newId(),
          questionId: questionValues[index].id,
          label: o.label,
          position: o.position,
        })),
      );

      const questionRows = await tx.insert(testFormQuestions).values(questionValues).returning();
      const optionRows =
        optionValues.length > 0
          ? await tx.insert(testFormOptions).values(optionValues).returning()
          : [];

      const byQuestion = new Map<string, TestFormOptionRow[]>();
      for (const opt of optionRows) {
        const list = byQuestion.get(opt.questionId) ?? [];
        list.push(opt);
        byQuestion.set(opt.questionId, list);
      }
      // Input order, as before — RETURNING's row order isn't something to lean on.
      const rowsById = new Map(questionRows.map((row) => [row.id, row]));
      return questionValues.flatMap(({ id }) => {
        const row = rowsById.get(id);
        if (!row) return [];
        const options = (byQuestion.get(id) ?? []).sort((a, b) => a.position - b.position);
        return [{ ...row, options }];
      });
    });
  }

  /** Batch audience lookup for a page of tests (`TestView`), keyed by test id. */
  async findAudiencesByTestIds(
    testIds: string[],
    db: DbExecutor = this.db,
  ): Promise<Map<string, TestAudienceCriteriaRow>> {
    if (testIds.length === 0) return new Map();
    const rows = await db
      .select()
      .from(testAudienceCriteria)
      .where(inArray(testAudienceCriteria.testId, testIds));
    return new Map(rows.map((row) => [row.testId, row]));
  }

  /**
   * Question count per test for a page of tests — `pendingValidations` only
   * asks whether the form is empty, so loading every question and option
   * (`findFormQuestions`) for it was waste. Tests without questions are absent.
   */
  async countFormQuestionsByTestIds(
    testIds: string[],
    db: DbExecutor = this.db,
  ): Promise<Map<string, number>> {
    if (testIds.length === 0) return new Map();
    const rows = await db
      .select({ testId: testFormQuestions.testId, total: count() })
      .from(testFormQuestions)
      .where(inArray(testFormQuestions.testId, testIds))
      .groupBy(testFormQuestions.testId);
    return new Map(rows.map((row) => [row.testId, row.total]));
  }

  /** Pass the `withRowLock` transaction as `db` (see the note there). */
  async upsertAudience(
    testId: string,
    values: UpsertAudienceInput,
    db: DbExecutor = this.db,
  ): Promise<TestAudienceCriteriaRow> {
    const rows = await db
      .insert(testAudienceCriteria)
      .values({ testId, ...values })
      .onConflictDoUpdate({ target: testAudienceCriteria.testId, set: values })
      .returning();
    return rows[0];
  }

  /**
   * Reach estimate (RN-01, Tela 09): count of active players whose birthdate
   * falls in (minBirthdate, maxBirthdate] (`YYYY-MM-DD`). For an age range
   * [ageMin, ageMax] the caller passes `minBirthdate = ageMax + 1 years ago`
   * and `maxBirthdate = ageMin years ago`: the lower bound is exclusive, since
   * someone born exactly ageMax + 1 years ago turns ageMax + 1 today. Location/
   * archetype/device filters are stored but not applied here yet — `users` has
   * no such columns in this phase (same stub pattern as `GameSpecs`).
   */
  async countEligiblePlayers(minBirthdate: string, maxBirthdate: string): Promise<number> {
    // Counted in SQL: pulling one row per eligible player into the API on
    // every audience save grew with the size of the platform's player base.
    const [row] = await this.db
      .select({ total: countDistinct(users.id) })
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(
        and(
          eq(roles.key, 'player'),
          eq(memberships.status, 'active'),
          isNull(memberships.deletedAt),
          eq(users.isActive, true),
          isNull(users.deletedAt),
          gt(users.birthdate, minBirthdate),
          lte(users.birthdate, maxBirthdate),
        ),
      );
    return row?.total ?? 0;
  }
}
