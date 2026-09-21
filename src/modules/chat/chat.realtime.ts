import { Injectable } from '@nestjs/common';
import type { Server } from 'socket.io';
import type { RoleValue } from '../../shared/auth/roles';
import type { ChatChannelView, ChatMessageView, ChatPresenceView } from './dto/chat.dto';

/** What the gateway stores on an authenticated socket. */
export interface ChatSocketUser {
  userId: string;
  organizationId: string;
  role: RoleValue;
  displayName: string;
}

export interface ChatSocketData {
  user: ChatSocketUser;
}

export const CHANNEL_ROOM_PREFIX = 'chat:channel:';

export const channelRoom = (channelId: string): string => `${CHANNEL_ROOM_PREFIX}${channelId}`;

/**
 * Owns the Socket.IO server handle and every outbound emit. Sits between
 * {@link ChatService} and {@link ChatGateway} so the service can broadcast
 * without depending on the gateway that depends on it.
 *
 * Every write path goes through here, so a message sent over REST reaches the
 * open sockets exactly like one sent over the socket itself.
 */
@Injectable()
export class ChatRealtimeService {
  private server: Server | null = null;

  bind(server: Server): void {
    this.server = server;
  }

  messageCreated(message: ChatMessageView): void {
    this.server?.to(channelRoom(message.channelId)).emit('message:new', message);
  }

  messageModerated(message: ChatMessageView): void {
    this.server?.to(channelRoom(message.channelId)).emit('message:moderated', message);
  }

  /** Channel renamed/archived — open clients update their sidebar without a refetch. */
  channelUpdated(channel: ChatChannelView): void {
    this.server?.to(channelRoom(channel.id)).emit('channel:updated', channel);
  }

  typing(channelId: string, user: ChatSocketUser): void {
    this.server?.to(channelRoom(channelId)).emit('user:typing', {
      channelId,
      userId: user.userId,
      displayName: user.displayName,
    });
  }

  /**
   * Who is in the channel right now. `fetchSockets()` asks every node through
   * the Redis adapter, so this stays correct with more than one replica. A
   * user with two tabs open is one member.
   */
  async presence(channelId: string): Promise<ChatPresenceView> {
    if (!this.server) return { channelId, members: [] };

    const sockets = await this.server.in(channelRoom(channelId)).fetchSockets();
    const byUserId = new Map<string, { userId: string; displayName: string }>();
    for (const socket of sockets) {
      const user = (socket.data as ChatSocketData).user;
      if (user) byUserId.set(user.userId, { userId: user.userId, displayName: user.displayName });
    }
    return { channelId, members: [...byUserId.values()] };
  }

  async broadcastPresence(channelId: string): Promise<void> {
    if (!this.server) return;
    this.server.to(channelRoom(channelId)).emit('channel:presence', await this.presence(channelId));
  }
}
