import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role } from '../../shared/auth/roles';
import { PaginationQueryDto } from '../../shared/pagination/pagination';
import { PlayerGameDto, PlayerTestDto, PlayerTestListDto } from './dto/player-catalog.dto';
import { PlayerCatalogService } from './player-catalog.service';

/** M8-03 — jogos, testes e participações vistos pelo jogador (Telas 14 e 15). Só `player`. */
@ApiTags('player')
@ApiBearerAuth()
@Controller('player')
export class PlayerCatalogController {
  constructor(private readonly catalog: PlayerCatalogService) {}

  @Get('games/:gameId')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: PlayerGameDto })
  getGame(@Param('gameId') gameId: string) {
    return this.catalog.getGame(gameId);
  }

  @Get('games/:gameId/tests')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: PlayerTestListDto })
  listGameTests(
    @CurrentUser('userId') userId: string,
    @Param('gameId') gameId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.catalog.listGameTests(gameId, userId, query);
  }

  @Get('tests/:testId')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: PlayerTestDto })
  getTest(@CurrentUser('userId') userId: string, @Param('testId') testId: string) {
    return this.catalog.getTest(testId, userId);
  }
}
