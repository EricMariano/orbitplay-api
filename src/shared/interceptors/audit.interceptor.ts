import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { concatMap } from 'rxjs/operators';
import { drainAuditDrafts } from '../audit/audit-context';
import { AUDIT_RECORDER, type AuditRecorder } from '../audit/audit-recorder';
import type { AuthUser } from '../auth/roles';

/**
 * Flushes audit intents declared by services (via recordAudit) after the
 * handler succeeds, stamping author, IP and requestId. Runs globally so the
 * audit trail exists from day one (Tela 20). Persistence failures never break
 * the request — they are logged instead.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(@Inject(AUDIT_RECORDER) private readonly recorder: AuditRecorder) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser; id?: string }>();

    // Persist the audit trail BEFORE the response is emitted, so a record is
    // never lost to a crash-after-response. flush() swallows its own errors, so
    // an audit failure still never breaks the request.
    return next.handle().pipe(
      concatMap(async (data) => {
        await this.flush(request);
        return data;
      }),
    );
  }

  private async flush(request: Request & { user?: AuthUser; id?: string }): Promise<void> {
    const drafts = drainAuditDrafts(request);
    if (drafts.length === 0) return;

    const user = request.user;
    const ip = request.ip ?? request.socket?.remoteAddress ?? null;
    try {
      await this.recorder.record(
        drafts.map((d) => ({
          ...d,
          organizationId: user?.organizationId ?? null,
          actorUserId: user?.userId ?? null,
          ip,
          requestId: request.id ?? null,
        })),
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist audit trail: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
