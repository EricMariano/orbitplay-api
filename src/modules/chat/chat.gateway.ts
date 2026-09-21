import { HttpException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { DefaultEventsMap } from 'socket.io/dist/typed-events';
import type { ZodType } from 'zod';
import type { AccessTokenPayload } from '../../shared/auth/jwt-payload';
import { codeForStatus, ErrorCode } from '../../shared/errors/error-envelope';
import {
  CHANNEL_ROOM_PREFIX,
  channelRoom,
  ChatRealtimeService,
  type ChatSocketData,
  type ChatSocketUser,
} from './chat.realtime';
import { ChatService } from './chat.service';
import {
  wsChannelRefSchema,
  wsSendMessageSchema,
  type ChatMessageView,
  type ChatPresenceView,
} from './dto/chat.dto';

interface WsError {
  code: string;
  message: string;
  fieldErrors?: Record<string, string>;
}

/** Every handler answers through this, so a client has one shape to branch on. */
type Ack<T> = { ok: true; data: T } | { ok: false; error: WsError };

type ChatSocket = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  ChatSocketData & { leavingChannels?: string[] }
>;

/**
 * Real-time half of the community. The socket carries only the live traffic —
 * history, channel management and moderation stay on REST (`ChatController`),
 * which is also where a message sent without a socket comes in.
 *
 * Authentication happens once, at the handshake: an unauthenticated socket is
 * disconnected before it can subscribe to anything.
 */
@WebSocketGateway({ namespace: '/chat' })
export class ChatGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly chat: ChatService,
    private readonly realtime: ChatRealtimeService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  afterInit(server: Server): void {
    this.realtime.bind(server);
  }

  async handleConnection(client: ChatSocket): Promise<void> {
    const token = extractToken(client);
    if (!token) return this.reject(client, 'Não autenticado');

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get<string>('jwt.accessSecret'),
      });
    } catch {
      return this.reject(client, 'Sessão inválida ou expirada');
    }

    const displayName = await this.chat.resolveDisplayName(payload.sub);
    if (!displayName) return this.reject(client, 'Sessão inválida ou expirada');

    client.data.user = {
      userId: payload.sub,
      organizationId: payload.org,
      role: payload.role,
      displayName,
    };

    // `client.rooms` is already empty by the time handleDisconnect runs, so
    // remember which channels this socket is leaving while it still knows.
    client.on('disconnecting', () => {
      client.data.leavingChannels = [...client.rooms]
        .filter((room) => room.startsWith(CHANNEL_ROOM_PREFIX))
        .map((room) => room.slice(CHANNEL_ROOM_PREFIX.length));
    });

    client.emit('connected', { userId: payload.sub, displayName });
  }

  handleDisconnect(client: ChatSocket): void {
    for (const channelId of client.data.leavingChannels ?? []) {
      void this.realtime.broadcastPresence(channelId);
    }
  }

  @SubscribeMessage('channel:join')
  async join(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack<ChatPresenceView>> {
    return this.run(async () => {
      const { channelId } = parse(wsChannelRefSchema, body);
      await this.chat.getChannelOrThrow(channelId);

      await client.join(channelRoom(channelId));
      const presence = await this.realtime.presence(channelId);
      // Everyone already in the room sees the arrival; the joiner gets the ack.
      client.to(channelRoom(channelId)).emit('channel:presence', presence);
      return presence;
    });
  }

  @SubscribeMessage('channel:leave')
  async leave(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack<{ channelId: string }>> {
    return this.run(async () => {
      const { channelId } = parse(wsChannelRefSchema, body);
      await client.leave(channelRoom(channelId));
      await this.realtime.broadcastPresence(channelId);
      return { channelId };
    });
  }

  @SubscribeMessage('message:send')
  async send(
    @ConnectedSocket() client: ChatSocket,
    @MessageBody() body: unknown,
  ): Promise<Ack<ChatMessageView>> {
    return this.run(async () => {
      const payload = parse(wsSendMessageSchema, body);
      const user = requireUser(client);

      // The service broadcasts to the room; the ack just confirms to the sender
      // (and carries the persisted id, so an optimistic bubble can reconcile).
      return this.chat.sendMessage(payload.channelId, user.userId, { body: payload.body });
    });
  }

  @SubscribeMessage('typing:start')
  typing(@ConnectedSocket() client: ChatSocket, @MessageBody() body: unknown): Ack<null> {
    try {
      const { channelId } = parse(wsChannelRefSchema, body);
      const user = requireUser(client);
      // Ignore typing for a channel this socket never joined — it would leak
      // presence into a room the user isn't in.
      if (client.rooms.has(channelRoom(channelId))) {
        client.to(channelRoom(channelId)).emit('user:typing', {
          channelId,
          userId: user.userId,
          displayName: user.displayName,
        });
      }
      return { ok: true, data: null };
    } catch (err) {
      return { ok: false, error: this.toWsError(err) };
    }
  }

  @SubscribeMessage('channel:presence')
  async whoIsHere(@MessageBody() body: unknown): Promise<Ack<ChatPresenceView>> {
    return this.run(async () => {
      const { channelId } = parse(wsChannelRefSchema, body);
      return this.realtime.presence(channelId);
    });
  }

  private async run<T>(fn: () => Promise<T>): Promise<Ack<T>> {
    try {
      return { ok: true, data: await fn() };
    } catch (err) {
      return { ok: false, error: this.toWsError(err) };
    }
  }

  private toWsError(err: unknown): WsError {
    if (err instanceof WsValidationError) {
      return {
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Dados inválidos',
        fieldErrors: err.fieldErrors,
      };
    }

    if (err instanceof HttpException) {
      const status = err.getStatus();
      const res = err.getResponse();
      if (typeof res === 'string') {
        return { code: codeForStatus(status), message: res };
      }
      const payload = res as { code?: string; message?: string | string[] };
      const message = Array.isArray(payload.message)
        ? payload.message.join(', ')
        : (payload.message ?? 'Erro');
      return { code: payload.code ?? codeForStatus(status), message };
    }

    this.logger.error(
      err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      err instanceof Error ? err.stack : undefined,
    );
    return { code: ErrorCode.INTERNAL_ERROR, message: 'Erro interno do servidor' };
  }

  private reject(client: ChatSocket, message: string): void {
    client.emit('chat:error', { code: ErrorCode.UNAUTHORIZED, message });
    client.disconnect(true);
  }
}

class WsValidationError extends Error {
  constructor(readonly fieldErrors: Record<string, string>) {
    super('Dados inválidos');
  }
}

/** Same Zod schemas the REST side uses — the global pipe just doesn't reach here. */
function parse<T>(schema: ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length ? issue.path.join('.') : '_';
    if (!(key in fieldErrors)) fieldErrors[key] = issue.message;
  }
  throw new WsValidationError(fieldErrors);
}

function requireUser(client: ChatSocket): ChatSocketUser {
  const user = client.data.user;
  if (!user) throw new WsValidationError({ _: 'Não autenticado' });
  return user;
}

/**
 * Browsers can't set headers on a WebSocket handshake, so `auth.token` is the
 * primary channel; the Authorization header is accepted for non-browser
 * clients. The token never goes in the query string — it would land in logs.
 */
function extractToken(client: ChatSocket): string | null {
  const fromAuth = (client.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof fromAuth === 'string' && fromAuth) return fromAuth;

  const header = client.handshake.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme === 'Bearer' && value ? value : null;
}
