import { Controller, Get, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ZodResponse } from 'nestjs-zod';
import { Roles } from '../../shared/decorators/roles.decorator';
import { STUDIO_ROLES } from '../../shared/auth/roles';
import { TestModelDto, TestModelListDto } from './dto/test-model.dto';
import { TestModelsService } from './test-models.service';

/**
 * M4 — static, backend-owned catalog of test models (Tela 06). No tenancy: the
 * catalog is the same for every organization.
 */
@ApiTags('test-models')
@ApiBearerAuth()
@Controller('test-models')
export class TestModelsController {
  constructor(private readonly testModels: TestModelsService) {}

  @Get()
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: TestModelListDto })
  list() {
    return { data: this.testModels.list() };
  }

  @Get(':key')
  @Roles(...STUDIO_ROLES)
  @ZodResponse({ type: TestModelDto })
  get(@Param('key') key: string) {
    return this.testModels.get(key);
  }
}
