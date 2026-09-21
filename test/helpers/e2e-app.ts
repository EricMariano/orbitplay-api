import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:net';
import { AppModule } from '../../src/app.module';
import { RedisIoAdapter } from '../../src/infra/redis/redis-io.adapter';
import {
  NOTIFICATION_PORT,
  type EmailMessage,
  type NotificationPort,
} from '../../src/shared/ports/notification.port';

/** In-memory NotificationPort so e2e can assert on outbound mail without Mailhog. */
export class CapturingMailAdapter implements NotificationPort {
  readonly sent: EmailMessage[] = [];

  async sendEmail(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  clear(): void {
    this.sent.length = 0;
  }

  /** Pull the raw reset token from the last recovery e-mail body. */
  lastResetToken(): string | undefined {
    const last = this.sent.at(-1);
    if (!last) return undefined;
    const fromLink = /redefinir-senha\?token=([A-Za-z0-9_-]+)/.exec(last.text);
    if (fromLink) return fromLink[1];
    const fromPlain = /token diretamente: ([A-Za-z0-9_-]+)/.exec(last.text);
    return fromPlain?.[1];
  }
}

export interface E2EAppOptions {
  /** When set, replaces the real SMTP adapter with this capturing one. */
  mail?: CapturingMailAdapter;
  /**
   * Installs the Redis-backed Socket.IO adapter, like main.ts does. Opt-in so
   * the REST-only specs don't open Redis pub/sub connections they never use —
   * the chat spec needs it to exercise the real broadcast path.
   */
  realtime?: boolean;
}

/** Boots the full app for e2e (with cookie parsing, like main.ts). */
export async function createE2EApp(options: E2EAppOptions = {}): Promise<INestApplication> {
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (options.mail) {
    builder.overrideProvider(NOTIFICATION_PORT).useValue(options.mail);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.use(cookieParser());

  if (options.realtime) {
    const adapter = new RedisIoAdapter(app);
    await adapter.connect();
    app.useWebSocketAdapter(adapter);
  }

  await app.init();
  return app;
}

/** Starts listening on a free port and returns it — sockets need a real port. */
export async function listenOnRandomPort(app: INestApplication): Promise<number> {
  await app.listen(0);
  const address = (app.getHttpServer() as Server).address();
  if (!address || typeof address === 'string') throw new Error('Servidor sem porta TCP');
  return address.port;
}
