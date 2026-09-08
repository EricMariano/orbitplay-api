import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role, STUDIO_ROLES } from '../../shared/auth/roles';
import {
  PlaybackUrlResponseDto,
  RecordingCompleteRequestDto,
  RecordingDto,
  RecordingUploadUrlRequestDto,
  UploadUrlResponseDto,
} from './dto/media.dto';
import { MediaService } from './media.service';

@ApiTags('media')
@ApiBearerAuth()
@Controller('sessions')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post(':id/recordings/upload-url')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: UploadUrlResponseDto })
  createUploadUrl(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: RecordingUploadUrlRequestDto,
  ) {
    return this.media.createUploadUrl(userId, id, dto);
  }

  @Post(':id/recordings/complete')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.ACCEPTED)
  @ZodResponse({ status: HttpStatus.ACCEPTED, type: RecordingDto })
  complete(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: RecordingCompleteRequestDto,
  ) {
    return this.media.completeUpload(userId, id, dto);
  }

  @Get(':id/recordings/:recordingId/playback-url')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: PlaybackUrlResponseDto })
  playbackUrl(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Param('recordingId') recordingId: string,
  ) {
    return this.media.playbackUrl(organizationId, id, recordingId);
  }
}
