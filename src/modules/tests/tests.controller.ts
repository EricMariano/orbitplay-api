import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import type { Request } from 'express';
import { CurrentUser } from '../../shared/decorators/current-user.decorator';
import { Roles } from '../../shared/decorators/roles.decorator';
import { STUDIO_ROLES } from '../../shared/auth/roles';
import {
  BuildDto,
  BuildUploadUrlRequestDto,
  ConfirmBuildRequestDto,
  CreateTestDto,
  PutFormDto,
  AudienceRequestDto,
  SetModelDto,
  SetStatusDto,
  TestDto,
  TestFormDto,
  UploadUrlResponseDto,
} from './dto/test.dto';
import { TestsService } from './tests.service';

/**
 * The wizard (M5). Every route is org-scoped through the repository (cross-org
 * access 404s, same as `games`) and restricted to studio roles — a player
 * token never sees a studio's draft.
 */
@ApiTags('tests')
@ApiBearerAuth()
@Controller()
export class TestsController {
  constructor(private readonly tests: TestsService) {}

  @Post('games/:gameId/tests')
  @Roles(...STUDIO_ROLES)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: TestDto })
  create(
    @CurrentUser('organizationId') organizationId: string,
    @Param('gameId') gameId: string,
    @Body() dto: CreateTestDto,
    @Req() req: Request,
  ) {
    return this.tests.create(organizationId, gameId, dto, req);
  }

  @Get('tests/:id')
  @ZodResponse({ type: TestDto })
  get(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.tests.get(organizationId, id);
  }

  @Patch('tests/:id/model')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: TestDto })
  setModel(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: SetModelDto,
    @Req() req: Request,
  ) {
    return this.tests.setModel(organizationId, id, dto, req);
  }

  @Put('tests/:id/form')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: TestFormDto })
  putForm(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: PutFormDto,
    @Req() req: Request,
  ) {
    return this.tests.putForm(organizationId, id, dto.questions, req);
  }

  @Get('tests/:id/form/preview')
  @ZodResponse({ type: TestFormDto })
  formPreview(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.tests.formPreview(organizationId, id);
  }

  @Post('tests/:id/build/upload-url')
  @Roles(...STUDIO_ROLES)
  @HttpCode(HttpStatus.CREATED)
  @ZodResponse({ status: HttpStatus.CREATED, type: UploadUrlResponseDto })
  createBuildUploadUrl(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: BuildUploadUrlRequestDto,
  ) {
    return this.tests.createBuildUploadUrl(organizationId, id, dto);
  }

  @Post('tests/:id/build')
  @Roles(...STUDIO_ROLES)
  @HttpCode(HttpStatus.ACCEPTED)
  @ZodResponse({ status: HttpStatus.ACCEPTED, type: BuildDto })
  confirmBuild(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: ConfirmBuildRequestDto,
    @Req() req: Request,
  ) {
    return this.tests.confirmBuild(organizationId, id, dto, req);
  }

  @Get('tests/:id/build')
  @ZodResponse({ type: BuildDto })
  getBuild(@CurrentUser('organizationId') organizationId: string, @Param('id') id: string) {
    return this.tests.getBuild(organizationId, id);
  }

  @Delete('tests/:id/build')
  @Roles(...STUDIO_ROLES)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteBuild(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Req() req: Request,
  ) {
    await this.tests.deleteBuild(organizationId, id, req);
  }

  @Patch('tests/:id/audience')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: TestDto })
  setAudience(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: AudienceRequestDto,
    @Req() req: Request,
  ) {
    return this.tests.setAudience(organizationId, id, dto, req);
  }

  @Post('tests/:id/publish')
  @Roles(...STUDIO_ROLES)
  @HttpCode(HttpStatus.OK)
  @ZodResponse({ type: TestDto })
  publish(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
  ) {
    return this.tests.publish(organizationId, id, idempotencyKey, req);
  }

  @Patch('tests/:id/status')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: TestDto })
  setStatus(
    @CurrentUser('organizationId') organizationId: string,
    @Param('id') id: string,
    @Body() dto: SetStatusDto,
    @Req() req: Request,
  ) {
    return this.tests.setStatus(organizationId, id, dto, req);
  }
}
