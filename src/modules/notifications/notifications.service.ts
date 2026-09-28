import { Injectable } from '@nestjs/common';
import type { NotificationRow } from '../../infra/database/schema/community';
import { AppException } from '../../shared/errors/app.exception';
import type { NotificationQuery, NotificationView } from './dto/notification.dto';
import { NotificationsRepository } from './notifications.repository';

export interface NotificationList {
  data: NotificationView[];
  nextCursor: string | null;
  unreadCount: number;
}

@Injectable()
export class NotificationsService {
  constructor(private readonly repo: NotificationsRepository) {}

  async list(userId: string, query: NotificationQuery): Promise<NotificationList> {
    const [page, unreadCount] = await Promise.all([
      this.repo.listForUser(userId, query),
      this.repo.countUnread(userId),
    ]);
    return {
      data: page.data.map(toView),
      nextCursor: page.nextCursor,
      unreadCount,
    };
  }

  async markRead(userId: string, id: string): Promise<void> {
    const row = await this.repo.markRead(userId, id);
    if (!row) throw AppException.notFound('Notificação não encontrada');
  }
}

function toView(row: NotificationRow): NotificationView {
  return {
    id: row.id,
    type: row.kind,
    title: row.title,
    body: row.body,
    link: row.link,
    read: row.readAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}
