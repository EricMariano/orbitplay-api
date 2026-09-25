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
  ReportExportDto,
  ReportSessionListDto,
  ReportSessionQueryDto,
  SessionEvaluationDto,
  TestReportDto,
} from './dto/report.dto';
import { ReportsService } from './reports.service';

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
