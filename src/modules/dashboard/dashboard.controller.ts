import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { STUDIO_ROLES } from '../../shared/auth/roles';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { DashboardService } from './dashboard.service';
import { StudioBenchmarkDto, StudioDashboardDto } from './dto/dashboard.dto';
import { PaginationQueryDto } from '../../shared/pagination/pagination';

/**
 * M11 — dashboard do estúdio (Tela 02). Studio roles only; everything is
 * scoped to the token's organization (RN-01), so a player gets 403 and a
 * studio never sees another org's numbers.
 */
@ApiTags('dashboard')
@ApiBearerAuth()
@Controller('studio')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: StudioDashboardDto })
  getDashboard(@CurrentUser('organizationId') organizationId: string) {
    return this.dashboard.getDashboard(organizationId);
  }

  @Get('benchmark')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: StudioBenchmarkDto })
  getBenchmark(
    @CurrentUser('organizationId') organizationId: string,
    @Query() query: PaginationQueryDto,
  ) {
    return this.dashboard.getBenchmark(organizationId, query);
  }
}
