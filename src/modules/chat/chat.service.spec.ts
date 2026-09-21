import { HttpStatus } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatChannelRow } from '../../infra/database/schema/chat';
import type { AuthUser } from '../../shared/auth/roles';
import { AppException } from '../../shared/errors/app.exception';
import type { GamesService } from '../games/games.service';
import { ChatRealtimeService } from './chat.realtime';
import type { ChatRepository, MessageRecord } from './chat.repository';
import { ChatService } from './chat.service';

const OWNER_ORG = 'org-owner';
const GAME_ID = 'game-1';
const CHANNEL_ID = 'channel-1';

const studio: AuthUser = {
  userId: 'user-studio',
  organizationId: OWNER_ORG,
  role: 'studio',
  email: 'studio@orbitplay.dev',
};

const rival: AuthUser = { ...studio, userId: 'user-rival', organizationId: 'org-rival' };

function channel(overrides: Partial<ChatChannelRow> = {}): ChatChannelRow {
  return {
    id: CHANNEL_ID,
    gameId: GAME_ID,
    slug: 'geral',
    name: 'Geral',
    topic: null,
    archivedAt: null,
    createdBy: studio.userId,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function message(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: 'msg-1',
    channelId: CHANNEL_ID,
    authorUserId: 'user-player',
    authorDisplayName: 'Player',
    body: 'olá',
    status: 'visible',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('ChatService', () => {
  let repo: ChatRepository;
  let games: GamesService;
  let realtime: ChatRealtimeService;
  let redis: Redis;
  let service: ChatService;

  beforeEach(() => {
    repo = {
      findChannelById: vi.fn().mockResolvedValue(channel()),
      createChannel: vi.fn().mockImplementation((v) => Promise.resolve(channel(v))),
      createMessage: vi.fn().mockResolvedValue(message()),
      findMessageRowById: vi.fn(),
      findMessageById: vi.fn().mockResolvedValue(message()),
      moderateMessage: vi.fn().mockResolvedValue(message({ status: 'hidden' })),
    } as unknown as ChatRepository;

    games = {
      existsAnyOrg: vi.fn().mockResolvedValue({
        id: GAME_ID,
        organizationId: OWNER_ORG,
        status: 'active',
      }),
    } as unknown as GamesService;

    realtime = new ChatRealtimeService();
    redis = { incr: vi.fn().mockResolvedValue(1), expire: vi.fn() } as unknown as Redis;

    const config = {
      get: (key: string) => (key === 'chat.messageThrottleTtl' ? 10 : 10),
    } as unknown as ConfigService;

    service = new ChatService(repo, games, realtime, config, redis);
  });

  describe('createChannel', () => {
    it('derives the slug from the name', async () => {
      const created = await service.createChannel(GAME_ID, studio, { name: 'Bugs & Crashes' });
      expect(created.slug).toBe('bugs-crashes');
    });

    it('rejects a studio that does not own the game', async () => {
      await expect(service.createChannel(GAME_ID, rival, { name: 'Geral' })).rejects.toMatchObject({
        status: HttpStatus.FORBIDDEN,
      });
    });

    it('turns a duplicate slug into a conflict, not a 500', async () => {
      const duplicate = Object.assign(new Error('dup'), { cause: { code: '23505' } });
      vi.mocked(repo.createChannel).mockRejectedValueOnce(duplicate);

      await expect(service.createChannel(GAME_ID, studio, { name: 'Geral' })).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
      });
    });

    it('rejects a name that slugifies to nothing', async () => {
      await expect(service.createChannel(GAME_ID, studio, { name: '###' })).rejects.toMatchObject({
        status: HttpStatus.UNPROCESSABLE_ENTITY,
      });
    });
  });

  describe('sendMessage', () => {
    it('broadcasts the persisted message to the channel room', async () => {
      const spy = vi.spyOn(realtime, 'messageCreated');
      const view = await service.sendMessage(CHANNEL_ID, 'user-player', { body: 'olá' });

      expect(view.body).toBe('olá');
      expect(spy).toHaveBeenCalledWith(view);
    });

    it('refuses an archived channel', async () => {
      vi.mocked(repo.findChannelById).mockResolvedValueOnce(channel({ archivedAt: new Date() }));

      await expect(
        service.sendMessage(CHANNEL_ID, 'user-player', { body: 'olá' }),
      ).rejects.toMatchObject({ status: HttpStatus.CONFLICT });
    });

    it('404s an unknown channel', async () => {
      vi.mocked(repo.findChannelById).mockResolvedValueOnce(null);

      await expect(
        service.sendMessage('nope', 'user-player', { body: 'olá' }),
      ).rejects.toMatchObject({ status: HttpStatus.NOT_FOUND });
    });

    it('throttles a user past the configured limit', async () => {
      vi.mocked(redis.incr).mockResolvedValueOnce(11);

      await expect(
        service.sendMessage(CHANNEL_ID, 'user-player', { body: 'flood' }),
      ).rejects.toMatchObject({ status: HttpStatus.TOO_MANY_REQUESTS });
      expect(repo.createMessage).not.toHaveBeenCalled();
    });

    it('starts the throttle window only on the first message', async () => {
      await service.sendMessage(CHANNEL_ID, 'user-player', { body: 'um' });
      expect(redis.expire).toHaveBeenCalledWith('chat:rate:user-player', 10);

      vi.mocked(redis.incr).mockResolvedValueOnce(2);
      vi.mocked(redis.expire).mockClear();
      await service.sendMessage(CHANNEL_ID, 'user-player', { body: 'dois' });
      expect(redis.expire).not.toHaveBeenCalled();
    });
  });

  describe('moderateMessage', () => {
    const req = {} as never;

    it('lets the owning studio hide a message and broadcasts it', async () => {
      vi.mocked(repo.findMessageRowById).mockResolvedValueOnce({
        id: 'msg-1',
        channelId: CHANNEL_ID,
      } as never);
      const spy = vi.spyOn(realtime, 'messageModerated');

      const view = await service.moderateMessage('msg-1', studio, { action: 'hide' }, req);

      expect(view.status).toBe('hidden');
      expect(spy).toHaveBeenCalledWith(view);
    });

    it('forbids moderating another studio\'s game — visible but not moderable', async () => {
      vi.mocked(repo.findMessageRowById).mockResolvedValueOnce({
        id: 'msg-1',
        channelId: CHANNEL_ID,
      } as never);

      await expect(
        service.moderateMessage('msg-1', rival, { action: 'hide' }, req),
      ).rejects.toMatchObject({ status: HttpStatus.FORBIDDEN });
    });

    it('404s an unknown message', async () => {
      vi.mocked(repo.findMessageRowById).mockResolvedValueOnce(null);

      await expect(
        service.moderateMessage('nope', studio, { action: 'hide' }, req),
      ).rejects.toBeInstanceOf(AppException);
    });
  });
});
