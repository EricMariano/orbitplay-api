import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull, lt } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import { notifications, type NotificationRow } from '../../infra/database/schema/community';
import { buildPage, decodeCursor, type Page } from '../../shared/pagination/pagination';
import { isUuid } from '../../shared/util/uuid';
import type { NotificationQuery } from './dto/notification.dto';

@Injectable()
export class NotificationsRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async listForUser(userId: string, query: NotificationQuery): Promise<Page<NotificationRow>> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [eq(notifications.userId, userId)];
    if (query.unreadOnly) filters.push(isNull(notifications.readAt));
    if (cursorId) filters.push(lt(notifications.id, cursorId));

    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(...filters))
      .orderBy(desc(notifications.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
  }

  /** Total unread for the user, independent of the current page and filter. */
  async countUnread(userId: string): Promise<number> {
    const result = await this.db
      .select({ value: count() })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return result[0]?.value ?? 0;
  }

  /**
   * Marks the caller's notification as read. A second call is a no-op that
   * still returns the row. Missing, malformed, or another user's id returns
   * null so the service can answer 404 without revealing existence.
   */
  async markRead(userId: string, id: string): Promise<NotificationRow | null> {
    if (!isUuid(id) || !isUuid(userId)) return null;

    const updated = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.id, id),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
        ),
      )
      .returning();
    if (updated[0]) return updated[0];

    const existing = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)))
      .limit(1);
    return existing[0] ?? null;
  }
}
