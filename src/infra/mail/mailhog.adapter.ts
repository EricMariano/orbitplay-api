import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import type { EmailMessage, NotificationPort } from '../../shared/ports/notification.port';

/**
 * Mailhog notification adapter (dev). Sends over plain SMTP to the Mailhog sink
 * (UI at http://localhost:8025). A real provider implements NotificationPort
 * later without touching callers.
 */
@Injectable()
export class MailhogAdapter implements NotificationPort {
  private readonly logger = new Logger(MailhogAdapter.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(private readonly config: ConfigService) {
    this.from = this.config.get<string>('mail.from')!;
    this.transporter = createTransport({
      host: this.config.get<string>('mail.host'),
      port: this.config.get<number>('mail.port'),
      secure: false,
      ignoreTLS: true,
    });
  }

  async sendEmail(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    this.logger.debug(`Sent email to ${message.to}: ${message.subject}`);
  }
}
