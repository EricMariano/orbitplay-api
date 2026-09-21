import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role } from '../../shared/auth/roles';
import { PaginationQueryDto } from '../../shared/pagination/pagination';
import {
  PlayerAchievementListDto,
  PlayerMissionListDto,
  PlayerProgressDto,
  RankingListDto,
  RankingsQueryDto,
} from './dto/gamification.dto';
import { GamificationService } from './gamification.service';

/** M12 — XP/level, achievements, missions, player rankings (Telas 13, 19). */
@ApiTags('gamification')
@ApiBearerAuth()
@Controller()
export class GamificationController {
  constructor(private readonly gamification: GamificationService) {}

  @Get('player/progress')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: PlayerProgressDto })
  getProgress(@CurrentUser('userId') userId: string) {
    return this.gamification.getProgress(userId);
  }

  @Get('player/achievements')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: PlayerAchievementListDto })
  listAchievements(@CurrentUser('userId') userId: string, @Query() query: PaginationQueryDto) {
    return this.gamification.listAchievements(userId, query);
  }

  @Get('player/missions')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: PlayerMissionListDto })
  listMissions(@CurrentUser('userId') userId: string) {
    return this.gamification.listMissions(userId);
  }

  @Get('rankings')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: RankingListDto })
  getRankings(@CurrentUser('userId') userId: string, @Query() query: RankingsQueryDto) {
    return this.gamification.getRankings(userId, query);
  }
}
