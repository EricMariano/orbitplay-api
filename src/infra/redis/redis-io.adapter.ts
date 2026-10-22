import { Logger, type INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import { withTimeout } from '../../shared/util/with-timeout';
import { attachRedisErrorLogging } from './redis-error-logging';

/** How long boot waits for Redis before giving up (instead of hanging forever). */
const CONNECT_TIMEOUT_MS = 10_000;

/**
 * Socket.IO adapter backed by Redis pub/sub. Without it a broadcast only
 * reaches the clients connected to the node that emitted it — with more than
 * one API replica, two players in the same channel would silently stop seeing
 * each other's messages.
 *
 * Uses its own pub/sub pair instead of REDIS_CLIENT: a connection in
 * subscriber mode can't run normal commands, so sharing the app-wide client
 * would break the idempotency store and the rate limiters.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly redisLogger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  /**
   * Connects the pub/sub pair. These clients keep `maxRetriesPerRequest: null`
   * (the adapter must survive Redis restarts and re-subscribe on its own), so
   * the initial ping would queue forever if Redis is down at boot — hence the
   * explicit timeout: boot fails with a clear error and the orchestrator can
   * restart the container, instead of hanging silently.
   */
  async connect(timeoutMs = CONNECT_TIMEOUT_MS): Promise<void> {
    const url = this.app.get(ConfigService).get<string>('redis.url')!;
    const pub = new Redis(url, { maxRetriesPerRequest: null });
    const sub = pub.duplicate();
    const warn = (message: string) => this.redisLogger.warn(message);
    attachRedisErrorLogging(pub, 'socket.io pub', warn);
    attachRedisErrorLogging(sub, 'socket.io sub', warn);

    try {
      await withTimeout(
        Promise.all([pub.ping(), sub.ping()]),
        timeoutMs,
        'Redis (Socket.IO adapter) ping',
      );
    } catch (error) {
      pub.disconnect();
      sub.disconnect();
      throw error;
    }

    this.clients = [pub, sub];
    this.adapterConstructor = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: Partial<ServerOptions>): Server {
    const origin = this.app.get(ConfigService).get<string[]>('web.allowedOrigins');
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin, credentials: true },
    } as ServerOptions) as Server;

    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async close(server: Server): Promise<void> {
    await super.close(server);

    // Shutting down cancels whatever SUBSCRIBE the adapter still had in
    // flight, and ioredis surfaces that as a rejected command. It's noise on
    // an already-closing connection, so drop the pair without waiting for a
    // clean QUIT handshake.
    await Promise.all(
      this.clients.map(async (client) => {
        client.on('error', () => undefined);
        try {
          await client.quit();
        } catch {
          client.disconnect();
        }
      }),
    );
    this.clients = [];
  }
}
