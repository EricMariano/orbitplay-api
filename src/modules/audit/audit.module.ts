import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AUDIT_RECORDER } from '../../shared/audit/audit-recorder';
import { AuditInterceptor } from '../../shared/interceptors/audit.interceptor';
import { AuditController } from './audit.controller';
import { AuditQueryService } from './audit-query.service';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

/**
 * Provides the audit recorder and registers the AuditInterceptor globally, so
 * the audit trail exists from day one (Tela 20). Global so any module's
 * services can declare audit intents via recordAudit().
 *
 * Also exposes GET /audit-logs (ORB-M2-06) via AuditController /
 * AuditQueryService — the read side of the same trail, kept in this module
 * since it owns the audit_log table end to end.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditRepository,
    AuditService,
    AuditQueryService,
    { provide: AUDIT_RECORDER, useExisting: AuditService },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AUDIT_RECORDER, AuditService],
})
export class AuditModule {}
