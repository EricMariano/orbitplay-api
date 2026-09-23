import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role } from '../../shared/auth/roles';
import {
  DeviceEventRequestDto,
  FinishSessionRequestDto,
  FormResponseDto,
  FormResponseRequestDto,
  HeartbeatRequestDto,
  SessionDto,
  SessionSummaryDto,
} from './dto/session.dto';
import { SessionsService } from './sessions.service';

/** M7-04/05 — ciclo de vida da sessão. Toda rota é `player`-only e escopada ao dono da sessão (outro jogador → 404). */
@ApiTags('participations')
@ApiBearerAuth()
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Patch(':id/devices')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.NO_CONTENT)
  devices(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: DeviceEventRequestDto,
  ) {
    return this.sessions.recordDeviceEvent(id, userId, dto);
  }

  @Post(':id/heartbeat')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.NO_CONTENT)
  heartbeat(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: HeartbeatRequestDto,
  ) {
    return this.sessions.heartbeat(id, userId, dto);
  }

  @Post(':id/finish')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: SessionDto })
  finish(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: FinishSessionRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.sessions.finish(id, userId, dto, idempotencyKey);
  }

  @Get(':id/summary')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: SessionSummaryDto })
  summary(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.sessions.summary(id, userId);
  }

  @Post(':id/form-response')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ type: FormResponseDto })
  formResponse(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: FormResponseRequestDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
  ) {
    return this.sessions.submitFormResponse(id, userId, dto, idempotencyKey);
  }
}
