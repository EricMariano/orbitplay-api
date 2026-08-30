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
import { STUDIO_ROLES } from '../../shared/auth/roles';
import { PaginationQueryDto } from '../../shared/pagination/pagination';
import { CreateGameDto, GameDto, GameListDto, UpdateGameDto } from './dto/game.dto';
import { GamesService } from './games.service';

/**
 * Games — the reference vertical slice. Every mutating route is restricted to
 * studio roles; a player hitting these gets a 403 envelope. Reads and writes
 * are org-scoped by the repository (RN-01), so a token from org A never sees or
 * touches org B's games.
 */
@ApiTags('games')
@ApiBearerAuth()
@Controller('games')
export class GamesController {
  constructor(private readonly games: GamesService) {}

  @Get()
  @ZodResponse({ type: GameListDto })
  list(@CurrentUser('organizationId') organizationId: string, @Query() query: PaginationQueryDto) {
    return this.games.list(organizationId, query);
  }

  @Get(':id')
  @ZodResponse({ type: GameDto })
  get(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.games.get(organizationId, id);
  }

  @Post()
  @Roles(...STUDIO_ROLES)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: GameDto })
  create(
    @CurrentUser('organizationId') organizationId: string,
    @Body() dto: CreateGameDto,
    @Req() req: Request,
  ) {
    return this.games.create(organizationId, dto, req);
  }

  @Patch(':id')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: GameDto })
  update(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: UpdateGameDto,
    @Req() req: Request,
  ) {
    return this.games.update(organizationId, id, dto, req);
  }

  @Delete(':id')
  @Roles(...STUDIO_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    await this.games.remove(organizationId, id, req);
  }
}
