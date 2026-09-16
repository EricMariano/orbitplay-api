import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role } from '../../shared/auth/roles';
import { AuditLogListDto, AuditLogQueryDto } from './dto/audit-log.dto';
import { AuditService } from './audit.service';

/** ORB-M2-08 (Tela 20): audit trail, owner/admin, scoped to the caller's org. */
@ApiTags('orgs')
@ApiBearerAuth()
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Roles(Role.OWNER, Role.ADMIN)
  @ZodResponse({ type: AuditLogListDto })
  list(@CurrentUser('organizationId') organizationId: string, @Query() query: AuditLogQueryDto) {
    return this.audit.listForOrg(organizationId, query);
  }
}
