import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

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
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private clients: Redis[] = [];

  constructor(private readonly app: INestApplicationContext) {
    super(app);
  }

  async connect(): Promise<void> {
    const url = this.app.get(ConfigService).get<string>('redis.url')!;
    const pub = new Redis(url, { maxRetriesPerRequest: null });
    const sub = pub.duplicate();
    await Promise.all([pub.ping(), sub.ping()]);
    this.clients = [pub, sub];
    this.adapterConstructor = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: Partial<ServerOptions>): Server {
    const origin = this.app.get(ConfigService).get<string>('web.origin');
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
