/**
 * Outbound notification capability. Mailhog adapter in dev; a real email
 * provider later.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface NotificationPort {
  sendEmail(message: EmailMessage): Promise<void>;
}

export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');
