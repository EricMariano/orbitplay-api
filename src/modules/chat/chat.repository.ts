import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, lt } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../../infra/database/database.module';
import {
  chatChannels,
  chatMessages,
  type ChatChannelRow,
  type ChatMessageRow,
} from '../../infra/database/schema/chat';
import { users } from '../../infra/database/schema/users';
import { AppException } from '../../shared/errors/app.exception';
import {
  buildPage,
  decodeCursor,
  type Page,
  type PaginationQuery,
} from '../../shared/pagination/pagination';
import { isUuid } from '../../shared/util/uuid';
import type { PostStatus } from '../community/dto/community.dto';

export interface MessageRecord {
  id: string;
  channelId: string;
  authorUserId: string;
  authorDisplayName: string;
  body: string;
  status: PostStatus;
  createdAt: Date;
}

export interface ChannelPatch {
  name?: string;
  topic?: string | null;
  archivedAt?: Date | null;
}

@Injectable()
export class ChatRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Ascending: a channel list reads top-to-bottom in creation order, like a sidebar. */
  async listChannels(gameId: string, query: PaginationQuery): Promise<Page<ChatChannelRow>> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [eq(chatChannels.gameId, gameId)];
    if (cursorId) filters.push(gt(chatChannels.id, cursorId));

    const rows = await this.db
      .select()
      .from(chatChannels)
      .where(and(...filters))
      .orderBy(asc(chatChannels.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
  }

  async findChannelById(id: string): Promise<ChatChannelRow | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(chatChannels)
      .where(eq(chatChannels.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async createChannel(values: {
    gameId: string;
    slug: string;
    name: string;
    topic: string | null;
    createdBy: string;
  }): Promise<ChatChannelRow> {
    const [created] = await this.db.insert(chatChannels).values(values).returning();
    return created;
  }

  async updateChannel(id: string, patch: ChannelPatch): Promise<ChatChannelRow> {
    const [updated] = await this.db
      .update(chatChannels)
      .set(patch)
      .where(eq(chatChannels.id, id))
      .returning();
    if (!updated) throw AppException.notFound();
    return updated;
  }

  async findUserDisplayName(userId: string): Promise<string | null> {
    if (!isUuid(userId)) return null;
    const rows = await this.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return rows[0]?.displayName ?? null;
  }

  private messageSelect() {
    return {
      id: chatMessages.id,
      channelId: chatMessages.channelId,
      authorUserId: chatMessages.authorUserId,
      authorDisplayName: users.displayName,
      body: chatMessages.body,
      status: chatMessages.status,
      createdAt: chatMessages.createdAt,
    };
  }

  /** Newest first — a chat opens at the bottom and pages backwards into history. */
  async listVisibleMessages(
    channelId: string,
    query: PaginationQuery,
  ): Promise<Page<MessageRecord>> {
    const cursorId = decodeCursor(query.cursor);
    const filters = [eq(chatMessages.channelId, channelId), eq(chatMessages.status, 'visible')];
    if (cursorId) filters.push(lt(chatMessages.id, cursorId));

    const rows = await this.db
      .select(this.messageSelect())
      .from(chatMessages)
      .innerJoin(users, eq(chatMessages.authorUserId, users.id))
      .where(and(...filters))
      .orderBy(desc(chatMessages.id))
      .limit(query.limit + 1);

    return buildPage(rows, query.limit);
  }

  async createMessage(
    channelId: string,
    authorUserId: string,
    body: string,
  ): Promise<MessageRecord> {
    const [inserted] = await this.db
      .insert(chatMessages)
      .values({ channelId, authorUserId, body })
      .returning({ id: chatMessages.id });

    const created = await this.findMessageById(inserted.id);
    if (!created) throw new Error('Mensagem recém-criada não encontrada');
    return created;
  }

  async findMessageById(id: string): Promise<MessageRecord | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select(this.messageSelect())
      .from(chatMessages)
      .innerJoin(users, eq(chatMessages.authorUserId, users.id))
      .where(eq(chatMessages.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Raw row (no author join) — used to resolve the owning channel for moderation. */
  async findMessageRowById(id: string): Promise<ChatMessageRow | null> {
    if (!isUuid(id)) return null;
    const rows = await this.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, id))
      .limit(1);
    return rows[0] ?? null;
  }

  async moderateMessage(
    id: string,
    moderatorUserId: string,
    status: PostStatus,
  ): Promise<MessageRecord> {
    const rows = await this.db
      .update(chatMessages)
      .set({ status, moderatedBy: moderatorUserId, moderatedAt: new Date() })
      .where(eq(chatMessages.id, id))
      .returning({ id: chatMessages.id });
    if (rows.length === 0) throw AppException.notFound();

    const updated = await this.findMessageById(id);
    if (!updated) throw AppException.notFound();
    return updated;
  }
}
