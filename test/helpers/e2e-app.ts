import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';
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
  await app.init();
  return app;
}
