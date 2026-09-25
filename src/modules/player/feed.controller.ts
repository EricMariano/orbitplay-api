import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role } from '../../shared/auth/roles';
import { FeedListDto, FeedQueryDto } from './dto/feed.dto';
import { FeedService } from './feed.service';

/** M8 — Feed do jogador (ORB-M8-02). */
@ApiTags('player')
@ApiBearerAuth()
@Controller('player')
export class FeedController {
  constructor(private readonly feed: FeedService) {}

  @Get('feed')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: FeedListDto })
  getFeed(@CurrentUser('userId') userId: string, @Query() query: FeedQueryDto) {
    return this.feed.getFeed(userId, query);
  }
}
