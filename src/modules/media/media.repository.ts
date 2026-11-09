import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import {
  participations,
  sessionConsents,
  sessionRecordings,
  sessions,
  type NewSessionRecordingRow,
  type SessionConsentRow,
  type SessionRecordingRow,
  type SessionRow,
} from '../../infra/database/schema/participations';
import { isUuid } from '../../shared/util/uuid';

export type PlayerSession = SessionRow & { userId: string };

@Injectable()
export class MediaRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findSessionForPlayer(sessionId: string, userId: string): Promise<PlayerSession | null> {
    if (!isUuid(sessionId) || !isUuid(userId)) return null;
    const rows = await this.db
      .select({ session: sessions, userId: participations.userId })
      .from(sessions)
      .innerJoin(participations, eq(sessions.participationId, participations.id))
      .where(and(eq(sessions.id, sessionId), eq(participations.userId, userId)))
      .limit(1);
    const row = rows[0];
    return row ? { ...row.session, userId: row.userId } : null;
  }

  async findSessionInOrg(sessionId: string, organizationId: string): Promise<SessionRow | null> {
    if (!isUuid(sessionId)) return null;
    const rows = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.organizationId, organizationId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async findConsent(participationId: string): Promise<SessionConsentRow | null> {
    const rows = await this.db
      .select()
      .from(sessionConsents)
      .where(eq(sessionConsents.participationId, participationId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findRecordingById(recordingId: string): Promise<SessionRecordingRow | null> {
    if (!isUuid(recordingId)) return null;
    const rows = await this.db
      .select()
      .from(sessionRecordings)
      .where(eq(sessionRecordings.id, recordingId))
      .limit(1);
    return rows[0] ?? null;
  }

  async findRecordingByStorageKey(storageKey: string): Promise<SessionRecordingRow | null> {
    const rows = await this.db
      .select()
      .from(sessionRecordings)
      .where(eq(sessionRecordings.storageKey, storageKey))
      .limit(1);
    return rows[0] ?? null;
  }

  async countRecordingsForSession(sessionId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(sessionRecordings)
      .where(eq(sessionRecordings.sessionId, sessionId));
    return row?.n ?? 0;
  }

  /**
   * Inserts the recording unless its session already holds `max` of them —
   * `null` then. The session row is locked for the count + insert, so two
   * concurrent completes can't both take the last place. A duplicate
   * `storage_key` still surfaces as the unique violation (23505) for the
   * caller to resolve.
   */
  async insertRecordingWithinCap(
    values: NewSessionRecordingRow,
    max: number,
  ): Promise<SessionRecordingRow | null> {
    return this.db.transaction(async (tx) => {
      await tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, values.sessionId))
        .for('update');
      const [held] = await tx
        .select({ n: count() })
        .from(sessionRecordings)
        .where(eq(sessionRecordings.sessionId, values.sessionId));
      if ((held?.n ?? 0) >= max) return null;
      const rows = await tx.insert(sessionRecordings).values(values).returning();
      return rows[0];
    });
  }

  async updateRecording(
    recordingId: string,
    patch: Partial<NewSessionRecordingRow>,
  ): Promise<SessionRecordingRow | null> {
    const rows = await this.db
      .update(sessionRecordings)
      .set(patch)
      .where(eq(sessionRecordings.id, recordingId))
      .returning();
    return rows[0] ?? null;
  }
}
