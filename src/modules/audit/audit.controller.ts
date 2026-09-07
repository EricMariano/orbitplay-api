import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role } from '../../shared/auth/roles';
import { AuditLogListDto, AuditLogQueryDto } from './dto/audit-log.dto';
import { AuditQueryService } from './audit-query.service';

/**
 * Read-only exposure of the audit trail (ORB-M2-06, Tela 20). Restricted to
 * Owner/Admin — same administrative area as /orgs/members (ORB-M2-05) — since
 * audit records can reveal sensitive before/after state across the org.
 * Org scoping happens in the repository (RN-01); the controller only
 * validates the query and delegates.
 */
@ApiTags('audit-logs')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly auditQuery: AuditQueryService) {}

  @Get()
  @Roles(Role.OWNER, Role.ADMIN)
  @ZodResponse({ type: AuditLogListDto })
  list(@CurrentUser('organizationId') organizationId: string, @Query() query: AuditLogQueryDto) {
    return this.auditQuery.list(organizationId, query);
  }
}
