import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { ZodResponse } from 'nestjs-zod';
import { STUDIO_ROLES } from '../../shared/auth/roles';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import {
  CreateReportExportDto,
  RateSessionDto,
  ReportExportDto,
  ReportSessionListDto,
  ReportSessionQueryDto,
  SessionEvaluationDto,
  SessionRatingDto,
  TestReportDto,
} from './dto/report.dto';
import { ReportsService } from './reports.service';

/**
 * M10-03 — avaliação da sessão pelo estúdio (`POST /sessions/:id/rate`). Fica
 * fora do prefixo `tests/:testId/report` porque a rota do contrato é
 * `/sessions/{id}/rate`; a sessão é resolvida pela organização do token.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('sessions')
export class SessionRatingsController {
  constructor(private readonly reports: ReportsService) {}

  @Post(':id/rate')
  @Roles(...STUDIO_ROLES)
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: SessionRatingDto })
  rate(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Body() dto: RateSessionDto,
    @Req() req: Request,
  ) {
    return this.reports.rateSession(organizationId, userId, id, dto, req);
  }
}

/**
 * M10 — relatórios do estúdio (Telas 11 e 12). Toda rota é restrita a
 * papéis de estúdio e escopada à organização do token: um teste de outra
 * organização responde 404, nunca 403.
 */
@ApiTags('reports')
@ApiBearerAuth()
@Controller('tests/:testId/report')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: TestReportDto })
  getReport(
    @CurrentUser('organizationId') organizationId: string,
    @Param('testId') testId: string,
  ) {
    return this.reports.getReport(organizationId, testId);
  }

  @Get('sessions')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: ReportSessionListDto })
  listSessions(
    @CurrentUser('organizationId') organizationId: string,
    @Param('testId') testId: string,
    @Query() query: ReportSessionQueryDto,
  ) {
    return this.reports.listSessions(organizationId, testId, query);
  }

  @Get('sessions/:sessionId')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: SessionEvaluationDto })
  getSessionEvaluation(
    @CurrentUser('organizationId') organizationId: string,
    @Param('testId') testId: string,
    @Param('sessionId') sessionId: string,
  ) {
    return this.reports.getSessionEvaluation(organizationId, testId, sessionId);
  }

  @Post('exports')
  @Roles(...STUDIO_ROLES)
  @HttpCode(HttpStatus.ACCEPTED)
  @ZodResponse({ status: HttpStatus.ACCEPTED, type: ReportExportDto })
  requestExport(
    @CurrentUser('organizationId') organizationId: string,
    @CurrentUser('userId') userId: string,
    @Param('testId') testId: string,
    @Body() dto: CreateReportExportDto,
    @Req() req: Request,
  ) {
    return this.reports.requestExport(organizationId, userId, testId, dto, req);
  }

  @Get('exports/:exportId')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: ReportExportDto })
  getExport(
    @CurrentUser('organizationId') organizationId: string,
    @Param('testId') testId: string,
    @Param('exportId') exportId: string,
  ) {
    return this.reports.getExport(organizationId, testId, exportId);
  }
}
