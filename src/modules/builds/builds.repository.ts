import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
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

@Injectable()
export class BuildsRepository extends OrgScopedRepository<BuildRow, NewBuildRow> {
  constructor(@Inject(DRIZZLE) db: Database) {
    super(db, builds);
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
