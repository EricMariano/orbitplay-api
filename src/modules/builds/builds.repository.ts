import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { newId } from '../../infra/database/schema/_helpers';
import { ACTIVE_PARTICIPATION_STATUSES } from '../../infra/database/schema/enums';
import { participations } from '../../infra/database/schema/participations';
import {
  buildValidationSteps,
  builds,
  type BuildRow,
  type BuildValidationStepRow,
  type NewBuildRow,
} from '../../infra/database/schema/tests';
import { OrgScopedRepository } from '../../infra/database/base.repository';
import { isUuid } from '../../shared/util/uuid';

export interface BuildWithSteps {
  build: BuildRow;
  steps: BuildValidationStepRow[];
}

/**
 * Single owner of the `builds`/`build_validation_steps` tables — both the
 * `builds` module (cross-org reads: compatibility, download) and `tests`
 * (the wizard's build step) go through this repository instead of each
 * keeping their own slice of build persistence.
 */
@Injectable()
export class BuildsRepository extends OrgScopedRepository<BuildRow, NewBuildRow> {
  constructor(@Inject(DRIZZLE) db: Database) {
    super(db, builds);
  }

  async findLatestBuild(testId: string): Promise<BuildWithSteps | null> {
    // DAT-02: ascending order + limit(1) returned the OLDEST build, the
    // opposite of what "latest" promises — harmless today (the unique
    // constraint on test_id means at most one row exists), but wrong on its
    // own terms and a landmine if that constraint is ever relaxed.
    const rows = await this.db
      .select()
      .from(builds)
      .where(eq(builds.testId, testId))
      .orderBy(desc(builds.createdAt))
      .limit(1);
    const build = rows[0];
    if (!build) return null;
    const steps = await this.db
      .select()
      .from(buildValidationSteps)
      .where(eq(buildValidationSteps.buildId, build.id));
    return { build, steps };
  }

  async createBuildWithSteps(
    values: NewBuildRow,
    stepKeys: readonly ('checksum' | 'malware_scan' | 'metadata')[],
  ): Promise<BuildWithSteps> {
    return this.db.transaction(async (tx) => {
      const [build] = await tx.insert(builds).values(values).returning();
      const steps = await tx
        .insert(buildValidationSteps)
        .values(
          stepKeys.map((key) => ({
            id: newId(),
            buildId: build.id,
            key,
            status: 'processing' as const,
          })),
        )
        .returning();
      return { build, steps };
    });
  }

  async deleteBuild(buildId: string): Promise<void> {
    await this.db.delete(builds).where(eq(builds.id, buildId));
  }

  /**
   * Used when enqueueing `build.validate` fails right after the insert
   * (OPS-01) — surfaces the build as `failed` immediately (with a reason)
   * instead of leaving it silently stuck in `processing`, and reuses the
   * existing "a failed build is replaced automatically on retry" rule
   * (`confirmBuild`) so the client's natural retry just works.
   */
  async markBuildFailed(buildId: string, reason: string): Promise<BuildRow> {
    const rows = await this.db
      .update(builds)
      .set({ status: 'failed', failureReason: reason })
      .where(eq(builds.id, buildId))
      .returning();
    return rows[0];
  }

  /**
   * Cross-org lookup — `compatibility` (any authenticated user) and
   * `download-url` (a player, whose org is never the studio's) both need to
   * read a build that doesn't belong to their own org. Mirrors
   * `GamesRepository.findByIdAnyOrg` (DECISIONS.md §3).
   */
  async findByIdAnyOrg(id: string): Promise<BuildRow | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db.select().from(builds).where(eq(builds.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findValidationSteps(buildId: string): Promise<BuildValidationStepRow[]> {
    return this.db
      .select()
      .from(buildValidationSteps)
      .where(eq(buildValidationSteps.buildId, buildId));
  }

  /**
   * RN (Tela 16): download only with an active participation on the build's
   * test. Reads `participations` directly — M8's application layer doesn't
   * exist yet, same pre-M8 pattern as `CommunityRepository.hasValidSessionForGame`.
   */
  async hasActiveParticipation(testId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: participations.id })
      .from(participations)
      .where(
        and(
          eq(participations.testId, testId),
          eq(participations.userId, userId),
          inArray(participations.status, ACTIVE_PARTICIPATION_STATUSES),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
