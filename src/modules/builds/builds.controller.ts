import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ZodResponse } from 'nestjs-zod';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Public } from '../../shared/decorators/public.decorator';
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
  constructor(
    private readonly builds: BuildsService,
    private readonly config: ConfigService,
  ) {}

  @Get(':id')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: BuildDto })
  get(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.builds.get(organizationId, id);
  }

  @Get(':id/compatibility')
  @ZodResponse({ type: CompatibilityReportDto })
  checkCompatibility(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Query() query: CompatibilityQueryDto,
  ) {
    return this.builds.checkCompatibility(organizationId, id, query);
  }

  @Get(':id/download-url')
  @Roles(Role.PLAYER)
  @ZodResponse({ type: DownloadUrlResponseDto })
  getDownloadUrl(
    @CurrentUser('userId') userId: string,
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Query() query: DownloadUrlQueryDto,
  ) {
    return this.builds.getDownloadUrl(userId, organizationId, id, query);
  }

  /**
   * Files of an unpacked web build, loaded by the player's sandboxed iframe.
   * Public on purpose — an iframe can't send the bearer token — and gated by
   * the signed, short-lived token in the path instead (`playLinkForTest`).
   * Studio code runs here, so the response locks it down: CSP `sandbox`
   * (opaque origin even if opened outside the iframe: no access to the
   * Orbit session), framing only by the web front, no network beyond its
   * own files.
   */
  @Public()
  @ApiExcludeEndpoint()
  @Get(':id/play/:token/*path')
  async play(
    @Param('id') id: string,
    @Param('token') token: string,
    @Param('path') path: string[] | string,
    @Res() res: Response,
  ): Promise<void> {
    const rawPath = Array.isArray(path) ? path.join('/') : path;
    const file = await this.builds.openPlayFile(id, token, rawPath);

    const frameAncestors = ["'self'", ...this.webOrigins].join(' ');
    res.removeHeader('X-Frame-Options');
    res.setHeader(
      'Content-Security-Policy',
      [
        'sandbox allow-scripts allow-pointer-lock',
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
        "connect-src 'self' data: blob:",
        "form-action 'none'",
        "base-uri 'self'",
        `frame-ancestors ${frameAncestors}`,
      ].join('; '),
    );
    // The sandboxed document has an opaque origin: its own asset requests
    // count as cross-origin, which `same-origin` (helmet's default) would block.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.sizeBytes));

    file.stream.on('error', () => res.destroy());
    file.stream.pipe(res);
  }

  private get webOrigins(): string[] {
    return this.config.get<string[]>('web.allowedOrigins') ?? [];
  }
}
