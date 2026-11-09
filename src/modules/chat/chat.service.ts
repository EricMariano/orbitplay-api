import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../../infra/redis/redis.module';
import type { ChatChannelRow } from '../../infra/database/schema/chat';
import { recordAudit } from '../../shared/audit/audit-context';
import type { AuthUser } from '../../shared/auth/roles';
import { AppException } from '../../shared/errors/app.exception';
import { ErrorCode } from '../../shared/errors/error-envelope';
import type { Page, PaginationQuery } from '../../shared/pagination/pagination';
import { slugify } from '../../shared/util/slugify';
import { GamesService } from '../games/games.service';
import type { PostStatus } from '../community/dto/community.dto';
import { ChatRealtimeService } from './chat.realtime';
import { ChatRepository, type MessageRecord } from './chat.repository';
import type {
  ChatChannelView,
  ChatMessageView,
  CreateChatChannelDto,
  ModerateChatMessageDto,
  SendChatMessageDto,
  UpdateChatChannelDto,
} from './dto/chat.dto';

const MODERATE_ACTION_TO_STATUS: Record<ModerateChatMessageDto['action'], PostStatus> = {
  hide: 'hidden',
  restore: 'visible',
  remove: 'removed',
};

/** Who is looking at a channel: only the organization matters for a game's visibility. */
type ChatViewer = Pick<AuthUser, 'organizationId'>;

/** Socket events (join, leave, typing, presence) per user, per window — see `enforceSocketEventLimit`. */
const SOCKET_EVENT_LIMIT = 30;
const SOCKET_EVENT_WINDOW_SECONDS = 60;

@Injectable()
export class ChatService {
  constructor(
    private readonly repo: ChatRepository,
    private readonly games: GamesService,
    private readonly realtime: ChatRealtimeService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async listChannels(
    gameId: string,
    viewer: ChatViewer,
    query: PaginationQuery,
  ): Promise<Page<ChatChannelView>> {
    await this.getVisibleGame(gameId, viewer);
    const page = await this.repo.listChannels(gameId, query);
    return { data: page.data.map(toChannelView), nextCursor: page.nextCursor };
  }

  async createChannel(
    gameId: string,
    user: AuthUser,
    dto: CreateChatChannelDto,
  ): Promise<ChatChannelView> {
    await this.assertOwnsGame(gameId, user);

    const slug = slugify(dto.name, 60);
    if (!slug) {
      throw AppException.validation('Dados inválidos', { name: 'Nome do canal inválido' });
    }

    try {
      const created = await this.repo.createChannel({
        gameId,
        slug,
        name: dto.name,
        topic: dto.topic ?? null,
        createdBy: user.userId,
      });
      return toChannelView(created);
    } catch (err) {
      if (isUniqueViolation(err)) throw AppException.conflict('Já existe um canal com esse nome');
      throw err;
    }
  }

  async updateChannel(
    channelId: string,
    user: AuthUser,
    dto: UpdateChatChannelDto,
  ): Promise<ChatChannelView> {
    const channel = await this.getChannelOrThrow(channelId, user);
    await this.assertOwnsGame(channel.gameId, user);

    const updated = await this.repo.updateChannel(channelId, {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.topic !== undefined ? { topic: dto.topic } : {}),
      ...(dto.archived !== undefined ? { archivedAt: dto.archived ? new Date() : null } : {}),
    });

    const view = toChannelView(updated);
    this.realtime.channelUpdated(view);
    return view;
  }

  async listMessages(
    channelId: string,
    viewer: ChatViewer,
    query: PaginationQuery,
  ): Promise<Page<ChatMessageView>> {
    await this.getChannelOrThrow(channelId, viewer);
    const page = await this.repo.listVisibleMessages(channelId, query);
    return { data: page.data.map(toMessageView), nextCursor: page.nextCursor };
  }

  /**
   * The single write path for a message, whether it arrived over REST or over
   * the socket — so the broadcast can't be forgotten on one of them.
   */
  async sendMessage(
    channelId: string,
    author: Pick<AuthUser, 'userId' | 'organizationId'>,
    dto: SendChatMessageDto,
  ): Promise<ChatMessageView> {
    const channel = await this.getChannelOrThrow(channelId, author);
    if (channel.archivedAt) throw AppException.conflict('Canal arquivado');

    await this.enforceMessageLimit(author.userId);

    const created = await this.repo.createMessage(channelId, author.userId, dto.body);
    const view = toMessageView(created);
    this.realtime.messageCreated(view);
    return view;
  }

  /**
   * Same rule as the mural (`CommunityService.moderatePost`): a message in
   * another studio's game is visible but not moderable — 403, not 404.
   */
  async moderateMessage(
    messageId: string,
    moderator: AuthUser,
    dto: ModerateChatMessageDto,
    req: Request,
  ): Promise<ChatMessageView> {
    const message = await this.repo.findMessageRowById(messageId);
    if (!message) throw AppException.notFound();

    const channel = await this.getChannelOrThrow(message.channelId, moderator);
    await this.assertOwnsGame(channel.gameId, moderator);

    const before = await this.repo.findMessageById(messageId);
    const updated = await this.repo.moderateMessage(
      messageId,
      moderator.userId,
      MODERATE_ACTION_TO_STATUS[dto.action],
    );

    recordAudit(req, {
      action: 'chat.message_moderated',
      entity: 'chat_messages',
      entityId: messageId,
      before,
      after: updated,
    });

    const view = toMessageView(updated);
    this.realtime.messageModerated(view);
    return view;
  }

  /**
   * Resolved once per socket at handshake time so the member list can name
   * people who haven't spoken yet — the access token carries no display name.
   */
  async resolveDisplayName(userId: string): Promise<string | null> {
    return this.repo.findUserDisplayName(userId);
  }

  /**
   * Used by the gateway before putting a socket into a channel room. A
   * channel lives as long as its game, like the mural: once the game is
   * deleted, reading, writing and joining all 404 — before, the channel kept
   * taking messages that nobody, not even the studio, could moderate anymore.
   * Same for a game that isn't `active`, except for its own studio
   * (`getVisibleGame`).
   */
  async getChannelOrThrow(channelId: string, viewer: ChatViewer): Promise<ChatChannelRow> {
    const channel = await this.repo.findChannelById(channelId);
    if (!channel) throw AppException.notFound('Canal não encontrado');
    try {
      await this.getVisibleGame(channel.gameId, viewer);
    } catch (err) {
      if (err instanceof AppException && err.getStatus() === HttpStatus.NOT_FOUND) {
        throw AppException.notFound('Canal não encontrado');
      }
      throw err;
    }
    return channel;
  }

  private async assertOwnsGame(gameId: string, user: AuthUser): Promise<void> {
    const game = await this.getVisibleGame(gameId, user);
    if (game.organizationId !== user.organizationId) {
      throw AppException.forbidden('Seu estúdio não é dono deste jogo');
    }
  }

  /**
   * A game that isn't `active` (draft, archived) is the studio's private state
   * — like the player catalog (DECISIONS.md M8-03), its chat answers 404 to
   * everyone except members of the organization that owns it, who keep
   * reading, talking and moderating there.
   */
  private async getVisibleGame(
    gameId: string,
    viewer: ChatViewer,
  ): Promise<{ id: string; organizationId: string; status: string }> {
    const game = await this.games.existsAnyOrg(gameId);
    if (game.status !== 'active' && game.organizationId !== viewer.organizationId) {
      throw AppException.notFound();
    }
    return game;
  }

  /**
   * Flood control. Chat is the one surface where a single client can write
   * hundreds of rows a second, so the limit is per user and counted in Redis —
   * it holds across replicas and across the REST and socket entry points.
   */
  private async enforceMessageLimit(userId: string): Promise<void> {
    await this.enforceLimit(
      `chat:rate:${userId}`,
      this.config.get<number>('chat.messageThrottleLimit')!,
      this.config.get<number>('chat.messageThrottleTtl')!,
      'Muitas mensagens seguidas. Aguarde alguns instantes.',
    );
  }

  /**
   * Join/leave/typing/presence write nothing, but each one asks every replica
   * who is in the room (`fetchSockets` over the Redis adapter) and broadcasts
   * to all of it — unthrottled, one client could flood a channel and the
   * pub/sub. A real client joins once per channel, so the budget is generous.
   */
  async enforceSocketEventLimit(userId: string): Promise<void> {
    await this.enforceLimit(
      `chat:events:${userId}`,
      SOCKET_EVENT_LIMIT,
      SOCKET_EVENT_WINDOW_SECONDS,
      'Muitas ações seguidas no chat. Aguarde alguns instantes.',
    );
  }

  private async enforceLimit(key: string, limit: number, ttl: number, message: string) {
    const count = await this.redis.incr(key);
    if (count === 1 || (await this.redis.ttl(key)) === -1) await this.redis.expire(key, ttl);
    if (count > limit) {
      throw new AppException(HttpStatus.TOO_MANY_REQUESTS, ErrorCode.TOO_MANY_REQUESTS, message);
    }
  }
}

function toChannelView(row: ChatChannelRow): ChatChannelView {
  return {
    id: row.id,
    gameId: row.gameId,
    slug: row.slug,
    name: row.name,
    topic: row.topic,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toMessageView(row: MessageRecord): ChatMessageView {
  return {
    id: row.id,
    channelId: row.channelId,
    authorUserId: row.authorUserId,
    authorDisplayName: row.authorDisplayName,
    body: row.body,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Drizzle wraps the driver error in a `DrizzleQueryError` whose own `.code`
 * is `undefined` — the real `PostgresError` (with `.code`) sits on `.cause`.
 */
function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const causeCode = (err as { cause?: { code?: string } } | null)?.cause?.code;
  return code === '23505' || causeCode === '23505';
}
