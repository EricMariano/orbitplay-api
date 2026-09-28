import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationRow } from '../../infra/database/schema/community';
import { AppException } from '../../shared/errors/app.exception';
import { NotificationsService } from './notifications.service';
import type { NotificationsRepository } from './notifications.repository';

const USER_ID = '01990000-0000-7000-8000-0000000000a1';
const NOTIFICATION_ID = '01990000-0000-7000-8000-0000000000c1';

function makeRow(overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id: NOTIFICATION_ID,
    userId: USER_ID,
    kind: 'session.validated',
    title: 'Sessão validada',
    body: 'Sua sessão foi aceita.',
    link: '/sessions/1',
    readAt: null,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('NotificationsService', () => {
  let repo: {
    listForUser: ReturnType<typeof vi.fn>;
    countUnread: ReturnType<typeof vi.fn>;
    markRead: ReturnType<typeof vi.fn>;
  };
  let service: NotificationsService;

  beforeEach(() => {
    repo = {
      listForUser: vi.fn(),
      countUnread: vi.fn(),
      markRead: vi.fn(),
    };
    service = new NotificationsService(repo as unknown as NotificationsRepository);
  });

  describe('list', () => {
    it('maps kind to type and readAt to read, and keeps unreadCount independent of the page', async () => {
      repo.listForUser.mockResolvedValue({
        data: [
          makeRow(),
          makeRow({
            id: '01990000-0000-7000-8000-0000000000c0',
            readAt: new Date('2026-01-01T00:00:00.000Z'),
            body: null,
            link: null,
          }),
        ],
        nextCursor: 'cursor-1',
      });
      repo.countUnread.mockResolvedValue(4);

      const page = await service.list(USER_ID, { limit: 20, unreadOnly: false });

      expect(page.nextCursor).toBe('cursor-1');
      expect(page.unreadCount).toBe(4);
      expect(page.data[0]).toEqual({
        id: NOTIFICATION_ID,
        type: 'session.validated',
        title: 'Sessão validada',
        body: 'Sua sessão foi aceita.',
        link: '/sessions/1',
        read: false,
        createdAt: '2026-01-02T00:00:00.000Z',
      });
      expect(page.data[1]).toMatchObject({ read: true, body: null, link: null });
    });

    it('forwards unreadOnly to the repository', async () => {
      repo.listForUser.mockResolvedValue({ data: [], nextCursor: null });
      repo.countUnread.mockResolvedValue(0);

      await service.list(USER_ID, { limit: 10, unreadOnly: true });

      expect(repo.listForUser).toHaveBeenCalledWith(USER_ID, { limit: 10, unreadOnly: true });
    });
  });

  describe('markRead', () => {
    it('resolves when the row was marked or was already read', async () => {
      repo.markRead.mockResolvedValue(makeRow({ readAt: new Date('2026-01-03T00:00:00.000Z') }));
      await expect(service.markRead(USER_ID, NOTIFICATION_ID)).resolves.toBeUndefined();
    });

    it('404 when the notification is missing, malformed, or belongs to someone else', async () => {
      repo.markRead.mockResolvedValue(null);
      await expect(service.markRead(USER_ID, NOTIFICATION_ID)).rejects.toSatisfy(
        (err: unknown) => err instanceof AppException && err.getStatus() === 404,
      );
    });
  });
});
