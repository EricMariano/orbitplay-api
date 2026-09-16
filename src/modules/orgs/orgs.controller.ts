import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import type { Request } from 'express';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role, STUDIO_ROLES, type RoleValue } from '../../shared/auth/roles';
import { MessageResponseDto } from '../auth/dto/auth.dto';
import {
  ChangeRoleDto,
  ChangeStatusDto,
  InviteMemberDto,
  MemberDto,
  MemberListDto,
  MemberListQueryDto,
  OrgDto,
  UpdateOrgDto,
} from './dto/org.dto';
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

  /** ORB-M2-02 (Tela 20): only owner/admin update the org's own data. */
  @Patch('current')
  @Roles(Role.OWNER, Role.ADMIN)
  @ZodResponse({ type: OrgDto })
  updateCurrent(
    @CurrentUser('organizationId') organizationId: string,
    @Body() dto: UpdateOrgDto,
    @Req() req: Request,
  ) {
    return this.orgs.updateCurrent(organizationId, dto, req);
  }

  @Get('members')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: MemberListDto })
  members(
    @CurrentUser('organizationId') organizationId: string,
    @Query() query: MemberListQueryDto,
  ) {
    return this.orgs.listMembers(organizationId, query);
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

  /** Owner/admin — activate/disable a member (Tela 20 RN-06). */
  @Patch('members/:userId/status')
  @Roles(Role.OWNER, Role.ADMIN)
  @ZodResponse({ type: MemberDto })
  changeStatus(
    @CurrentUser('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Body() dto: ChangeStatusDto,
    @Req() req: Request,
  ) {
    return this.orgs.changeMemberStatus(organizationId, userId, dto, req);
  }

  /** Owner/admin — never sets/sees the password, only dispatches the reset e-mail (RN-04). */
  @Post('members/:userId/password-reset')
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ZodResponse({ status: HttpStatus.ACCEPTED, type: MessageResponseDto })
  triggerPasswordReset(
    @CurrentUser('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ) {
    return this.orgs.triggerMemberPasswordReset(organizationId, userId, req);
  }

  /** Owner-only — logical deactivation, RN-06. */
  @Delete('members/:userId')
  @Roles(Role.OWNER)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeMember(
    @CurrentUser('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Req() req: Request,
  ) {
    await this.orgs.removeMember(organizationId, userId, req);
  }
}
