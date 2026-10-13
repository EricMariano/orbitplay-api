import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lt, lte } from 'drizzle-orm';
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
import type { FormQuestionInput, TestListQuery } from './dto/test.dto';

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
   */
  async replaceForm(
    testId: string,
    questions: FormQuestionInput[],
    db: DbExecutor = this.db,
  ): Promise<FormQuestionWithOptions[]> {
    return db.transaction(async (tx) => {
      await tx.delete(testFormQuestions).where(eq(testFormQuestions.testId, testId));

      const result: FormQuestionWithOptions[] = [];
      for (const q of questions) {
        const [row] = await tx
          .insert(testFormQuestions)
          .values({
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
          })
          .returning();

        let optionRows: TestFormOptionRow[] = [];
        if (q.options && q.options.length > 0) {
          optionRows = await tx
            .insert(testFormOptions)
            .values(
              q.options.map((o) => ({
                id: newId(),
                questionId: row.id,
                label: o.label,
                position: o.position,
              })),
            )
            .returning();
        }
        result.push({ ...row, options: optionRows.sort((a, b) => a.position - b.position) });
      }
      return result;
    });
  }

  async findAudience(testId: string): Promise<TestAudienceCriteriaRow | null> {
    const rows = await this.db
      .select()
      .from(testAudienceCriteria)
      .where(eq(testAudienceCriteria.testId, testId))
      .limit(1);
    return rows[0] ?? null;
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
   * falls in [minBirthdate, maxBirthdate] (inclusive, `YYYY-MM-DD`). Location/
   * archetype/device filters are stored but not applied here yet — `users` has
   * no such columns in this phase (same stub pattern as `GameSpecs`).
   */
  async countEligiblePlayers(minBirthdate: string, maxBirthdate: string): Promise<number> {
    const rows = await this.db
      .select({ id: users.id })
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
          gte(users.birthdate, minBirthdate),
          lte(users.birthdate, maxBirthdate),
        ),
      )
      .groupBy(users.id);
    return rows.length;
  }
}
