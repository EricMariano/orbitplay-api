import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AUDIT_RECORDER } from '../../shared/audit/audit-recorder';
import { AuditInterceptor } from '../../shared/interceptors/audit.interceptor';
import { AuditController } from './audit.controller';
import { AuditRepository } from './audit.repository';
import { AuditService } from './audit.service';

/**
 * Provides the audit recorder and registers the AuditInterceptor globally, so
 * the audit trail exists from day one (Tela 20). Global so any module's
 * services can declare audit intents via recordAudit(). Also exposes
 * GET /audit-logs (ORB-M2-08) to read that trail back.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [
    AuditRepository,
    AuditService,
    { provide: AUDIT_RECORDER, useExisting: AuditService },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
  exports: [AUDIT_RECORDER, AuditService],
})
export class AuditModule {}
