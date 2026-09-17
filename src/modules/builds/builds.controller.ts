import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { Role, STUDIO_ROLES } from '../../shared/auth/roles';
import { BuildDto } from '../tests/dto/test.dto';
import { BuildsService } from './builds.service';
import {
  CompatibilityQueryDto,
  CompatibilityReportDto,
  DownloadUrlQueryDto,
  DownloadUrlResponseDto,
} from './dto/build.dto';

/**
 * M6 — what's left of the wizard's build once M5 already covers upload and
 * confirmation: reading a build directly, checking device compatibility, and
 * issuing the short-lived download URL a player's game client uses.
 */
@ApiTags('builds')
@ApiBearerAuth()
@Controller('builds')
export class BuildsController {
  constructor(private readonly builds: BuildsService) {}

  @Get(':id')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: BuildDto })
  get(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.builds.get(organizationId, id);
  }

  @Get(':id/compatibility')
  @ZodResponse({ type: CompatibilityReportDto })
  checkCompatibility(@Param('id') id: string, @Query() query: CompatibilityQueryDto) {
    return this.builds.checkCompatibility(id, query);
  }

  @Get(':id/download-url')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: DownloadUrlResponseDto })
  getDownloadUrl(
    @CurrentUser('userId') userId: string,
    @Param('id') id: string,
    @Query() query: DownloadUrlQueryDto,
  ) {
    return this.builds.getDownloadUrl(userId, id, query);
  }
}
