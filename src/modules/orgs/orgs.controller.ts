import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import type { Request } from 'express';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role, STUDIO_ROLES, type RoleValue } from '../../shared/auth/roles';
import { ChangeRoleDto, InviteMemberDto, MemberDto, MemberListDto, OrgDto } from './dto/org.dto';
import { OrgsService } from './orgs.service';

@ApiTags('orgs')
@ApiBearerAuth()
@Controller('orgs')
export class OrgsController {
  constructor(private readonly orgs: OrgsService) {}

  @Get('current')
  @ZodResponse({ type: OrgDto })
  current(@CurrentUser('organizationId') organizationId: string) {
    return this.orgs.getCurrent(organizationId);
  }

  @Get('members')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: MemberListDto })
  members(@CurrentUser('organizationId') organizationId: string) {
    return this.orgs.listMembers(organizationId);
  }

  /** Member management is the Owner's area; Admin shares it (Tela 20 RN-01). */
  @Post('members/invite')
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: MemberDto })
  invite(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('role') callerRole: RoleValue,
    @Body() dto: InviteMemberDto,
    @Req() req: Request,
  ) {
    return this.orgs.inviteMember(organizationId, callerRole, dto, req);
  }

  /**
   * Owner-only (Tela 20 RN-01). The rule allows "Admin com permissão
   * específica", but per-user permissions do not exist in the project — only
   * roles — so the buildable reading is the Owner alone (DECISIONS.md §3).
   */
  @Patch('members/:userId/role')
  @Roles(Role.OWNER)
  @ZodResponse({ type: MemberDto })
  changeRole(
    @CurrentUser('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Body() dto: ChangeRoleDto,
    @Req() req: Request,
  ) {
    return this.orgs.changeMemberRole(organizationId, userId, dto, req);
  }
}
