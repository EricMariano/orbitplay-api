import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
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

  async insertRecording(values: NewSessionRecordingRow): Promise<SessionRecordingRow> {
    const rows = await this.db.insert(sessionRecordings).values(values).returning();
    return rows[0];
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
