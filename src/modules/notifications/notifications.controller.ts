import { Controller, Get, HttpCode, HttpStatus, Param, Patch, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { NotificationListDto, NotificationQueryDto } from './dto/notification.dto';
import { NotificationsService } from './notifications.service';

/**
 * M14 — in-app inbox. Any authenticated role: the inbox is the caller's,
 * not the organization's. Another user's notification answers 404.
 */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ZodResponse({ type: NotificationListDto })
  list(@CurrentUser('userId') userId: string, @Query() query: NotificationQueryDto) {
    return this.notifications.list(userId, query);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Marcada como lida' })
  markRead(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.notifications.markRead(userId, id);
  }
}
