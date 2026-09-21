import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import type { Request } from 'express';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { STUDIO_ROLES, type AuthUser } from '../../shared/auth/roles';
import { PaginationQueryDto } from '../../shared/pagination/pagination';
import { ChatService } from './chat.service';
import {
  ChatChannelDto,
  ChatChannelListDto,
  ChatMessageDto,
  ChatMessageListDto,
  CreateChatChannelRequestDto,
  ModerateChatMessageRequestDto,
  SendChatMessageRequestDto,
  UpdateChatChannelRequestDto,
} from './dto/chat.dto';

/**
 * REST half of the real-time community. Everything a client needs that isn't
 * live traffic: the channel list, history paging, channel management and
 * moderation — plus a `POST` fallback for sending when no socket is open.
 *
 * Global content like `community`: any authenticated user reads and talks in
 * any game's channels; only the owning studio creates, edits and moderates.
 */
@ApiTags('chat')
@ApiBearerAuth()
@Controller()
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  @Get('games/:gameId/chat/channels')
  @ZodResponse({ type: ChatChannelListDto })
  listChannels(@Param('gameId') gameId: string, @Query() query: PaginationQueryDto) {
    return this.chat.listChannels(gameId, query);
  }

  @Post('games/:gameId/chat/channels')
  @Roles(...STUDIO_ROLES)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: ChatChannelDto })
  createChannel(
    @Param('gameId') gameId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateChatChannelRequestDto,
  ) {
    return this.chat.createChannel(gameId, user, dto);
  }

  @Patch('chat/channels/:id')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: ChatChannelDto })
  updateChannel(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateChatChannelRequestDto,
  ) {
    return this.chat.updateChannel(id, user, dto);
  }

  @Get('chat/channels/:id/messages')
  @ZodResponse({ type: ChatMessageListDto })
  listMessages(@Param('id') id: string, @Query() query: PaginationQueryDto) {
    return this.chat.listMessages(id, query);
  }

  /** Same path as `message:send` over the socket — both broadcast to the room. */
  @Post('chat/channels/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: ChatMessageDto })
  sendMessage(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SendChatMessageRequestDto,
  ) {
    return this.chat.sendMessage(id, user.userId, dto);
  }

  @Patch('chat/messages/:id/moderate')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: ChatMessageDto })
  moderateMessage(
    @Param('id') id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ModerateChatMessageRequestDto,
    @Req() req: Request,
  ) {
    return this.chat.moderateMessage(id, user, dto, req);
  }
}
