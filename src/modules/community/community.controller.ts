import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import type { Request } from 'express';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role, STUDIO_ROLES, type AuthUser } from '../../shared/auth/roles';
import { PaginationQueryDto } from '../../shared/pagination/pagination';
import { CommunityService } from './community.service';
import {
  CommunityPostDto,
  CommunityPostListDto,
  CreateCommunityPostRequestDto,
  CreateReviewRequestDto,
  ModeratePostRequestDto,
  ReportPostRequestDto,
  ReviewDto,
  ReviewListDto,
} from './dto/community.dto';

/**
 * M13 — comunidade e avaliações do jogo (Tela 15). Global content: unlike
 * `games`/`tests`, posts and reviews are readable across organizations (any
 * authenticated user browses any published game's community), and only
 * `POST`/moderation are role-restricted.
 */
@ApiTags('community')
@ApiBearerAuth()
@Controller()
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Get('games/:gameId/community/posts')
  @ZodResponse({ type: CommunityPostListDto })
  listPosts(@Param('gameId') gameId: string, @Query() query: PaginationQueryDto) {
    return this.community.listPosts(gameId, query);
  }

  @Post('games/:gameId/community/posts')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: CommunityPostDto })
  createPost(
    @Param('gameId') gameId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCommunityPostRequestDto,
  ) {
    return this.community.createPost(gameId, user, dto);
  }

  @Post('community/posts/:id/report')
  @HttpCode(HttpStatus.ACCEPTED)
  async reportPost(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ReportPostRequestDto,
  ) {
    await this.community.reportPost(id, user, dto);
  }

  @Patch('community/posts/:id/moderate')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: CommunityPostDto })
  moderatePost(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ModeratePostRequestDto,
    @Req() req: Request,
  ) {
    return this.community.moderatePost(id, user, dto, req);
  }

  @Get('games/:gameId/reviews')
  @ZodResponse({ type: ReviewListDto })
  listReviews(@Param('gameId') gameId: string, @Query() query: PaginationQueryDto) {
    return this.community.listReviews(gameId, query);
  }

  @Post('games/:gameId/reviews')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: ReviewDto })
  createReview(
    @Param('gameId') gameId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReviewRequestDto,
  ) {
    return this.community.createReview(gameId, user, dto);
  }
}
