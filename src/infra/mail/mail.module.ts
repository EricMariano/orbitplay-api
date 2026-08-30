import { Global, Module } from '@nestjs/common';
import { NOTIFICATION_PORT } from '../../shared/ports/notification.port';
import { MailhogAdapter } from './mailhog.adapter';

@Global()
@Module({
  providers: [{ provide: NOTIFICATION_PORT, useClass: MailhogAdapter }],
  exports: [NOTIFICATION_PORT],
})
export class MailModule {}
