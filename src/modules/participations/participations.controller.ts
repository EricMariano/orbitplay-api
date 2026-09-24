import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role } from '../../shared/auth/roles';
import { ConsentRecordDto, ConsentRequestDto, TutorialDto } from './dto/consent.dto';
import { ParticipationDto } from './dto/participation.dto';
import {
  ParticipationResultDto,
  SessionStartedDto,
  StartSessionRequestDto,
} from './dto/session.dto';
import { ParticipationsService } from './participations.service';
import { SessionsService } from './sessions.service';

/** M7 — participações. Toda rota é `player`-only; um estúdio hitting isso recebe 403. */
@ApiTags('participations')
@ApiBearerAuth()
@Controller()
export class ParticipationsController {
  constructor(
    private readonly participations: ParticipationsService,
    private readonly sessions: SessionsService,
  ) {}

  @Post('player/tests/:testId/participations')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ type: ParticipationDto })
  join(@CurrentUser('userId') userId: string, @Param('testId') testId: string) {
    return this.participations.join(testId, userId);
  }

  @Get('participations/:id')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: ParticipationDto })
  get(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.participations.get(id, userId);
  }

  @Get('participations/:id/tutorial')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: TutorialDto })
  tutorial(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.participations.tutorial(id, userId);
  }

  @Post('participations/:id/consents')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ type: ConsentRecordDto })
  consents(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: ConsentRequestDto,
    @Ip() ip: string,
    @Headers('user-agent') userAgent: string | undefined,
  ) {
    return this.participations.consents(id, userId, dto, {
      ip: ip ?? null,
      userAgent: userAgent ?? null,
    });
  }

  @Post('participations/:id/sessions')
  @Roles(Role.PLAYER)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ type: SessionStartedDto })
  startSession(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: StartSessionRequestDto,
  ) {
    return this.sessions.start(id, userId, dto);
  }

  @Get('participations/:id/result')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: ParticipationResultDto })
  result(@CurrentUser('userId') userId: string, @Param('id') id: string) {
    return this.participations.result(id, userId);
  }
}
