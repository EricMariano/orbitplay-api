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

@Injectable()
export class ChatService {
  constructor(
    private readonly repo: ChatRepository,
    private readonly games: GamesService,
    private readonly realtime: ChatRealtimeService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async listChannels(gameId: string, query: PaginationQuery): Promise<Page<ChatChannelView>> {
    await this.games.existsAnyOrg(gameId);
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
    const channel = await this.getChannelOrThrow(channelId);
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
    query: PaginationQuery,
  ): Promise<Page<ChatMessageView>> {
    await this.getChannelOrThrow(channelId);
    const page = await this.repo.listVisibleMessages(channelId, query);
    return { data: page.data.map(toMessageView), nextCursor: page.nextCursor };
  }

  /**
   * The single write path for a message, whether it arrived over REST or over
   * the socket — so the broadcast can't be forgotten on one of them.
   */
  async sendMessage(
    channelId: string,
    authorUserId: string,
    dto: SendChatMessageDto,
  ): Promise<ChatMessageView> {
    const channel = await this.getChannelOrThrow(channelId);
    if (channel.archivedAt) throw AppException.conflict('Canal arquivado');

    await this.enforceMessageLimit(authorUserId);

    const created = await this.repo.createMessage(channelId, authorUserId, dto.body);
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

    const channel = await this.getChannelOrThrow(message.channelId);
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

  /** Used by the gateway before putting a socket into a channel room. */
  async getChannelOrThrow(channelId: string): Promise<ChatChannelRow> {
    const channel = await this.repo.findChannelById(channelId);
    if (!channel) throw AppException.notFound('Canal não encontrado');
    return channel;
  }

  private async assertOwnsGame(gameId: string, user: AuthUser): Promise<void> {
    const game = await this.games.existsAnyOrg(gameId);
    if (game.organizationId !== user.organizationId) {
      throw AppException.forbidden('Seu estúdio não é dono deste jogo');
    }
  }

  /**
   * Flood control. Chat is the one surface where a single client can write
   * hundreds of rows a second, so the limit is per user and counted in Redis —
   * it holds across replicas and across the REST and socket entry points.
   */
  private async enforceMessageLimit(userId: string): Promise<void> {
    const ttl = this.config.get<number>('chat.messageThrottleTtl')!;
    const limit = this.config.get<number>('chat.messageThrottleLimit')!;

    const key = `chat:rate:${userId}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, ttl);
    if (count > limit) {
      throw new AppException(
        HttpStatus.TOO_MANY_REQUESTS,
        ErrorCode.TOO_MANY_REQUESTS,
        'Muitas mensagens seguidas. Aguarde alguns instantes.',
      );
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
