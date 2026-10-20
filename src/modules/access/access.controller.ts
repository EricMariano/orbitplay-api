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
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import type { Request } from 'express';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role, STUDIO_ROLES } from '../../shared/auth/roles';
import { AccessService } from './access.service';
import {
  CreateGroupDto,
  GameAccessListDto,
  GroupDto,
  GroupListDto,
  SetGameAccessDto,
  UpdateGroupDto,
} from './dto/access.dto';

/** Grupos de membros da organização — gestão restrita a owner/admin. */
@ApiTags('access')
@ApiBearerAuth()
@Controller('orgs/groups')
export class OrgGroupsController {
  constructor(private readonly access: AccessService) {}

  @Get()
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: GroupListDto })
  list(@CurrentUser('organizationId') organizationId: string) {
    return this.access.listGroups(organizationId);
  }

  @Post()
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: GroupDto })
  create(
    @CurrentUser('organizationId') organizationId: string,
    @Body() dto: CreateGroupDto,
    @Req() req: Request,
  ) {
    return this.access.createGroup(organizationId, dto, req);
  }

  @Patch(':id')
  @Roles(Role.OWNER, Role.ADMIN)
  @ZodResponse({ type: GroupDto })
  update(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: UpdateGroupDto,
    @Req() req: Request,
  ) {
    return this.access.updateGroup(organizationId, id, dto, req);
  }

  @Delete(':id')
  @Roles(Role.OWNER, Role.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    await this.access.removeGroup(organizationId, id, req);
  }
}

/** Permissões por jogo (matriz de grupos e membros da Tela 04). */
@ApiTags('access')
@ApiBearerAuth()
@Controller('games/:gameId/access')
export class GameAccessController {
  constructor(private readonly access: AccessService) {}

  @Get()
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: GameAccessListDto })
  get(@CurrentUser('organizationId') organizationId: string, @Param('gameId') gameId: string) {
    return this.access.getGameAccess(organizationId, gameId);
  }

  @Put()
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: GameAccessListDto })
  set(
    @CurrentUser('organizationId') organizationId: string,
    @Param('gameId') gameId: string,
    @Body() dto: SetGameAccessDto,
    @Req() req: Request,
  ) {
    return this.access.setGameAccess(organizationId, gameId, dto, req);
  }
}
