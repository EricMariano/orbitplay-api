import { Injectable } from '@nestjs/common';
import { AppException } from '../../shared/errors/app.exception';
import type { TestModelView } from './dto/test-model.dto';
import { TEST_MODEL_CATALOG } from './test-models.catalog';

@Injectable()
export class TestModelsService {
  list(): TestModelView[] {
    return [...TEST_MODEL_CATALOG];
  }

  get(key: string): TestModelView {
    const model = TEST_MODEL_CATALOG.find((candidate) => candidate.key === key);
    if (!model) throw AppException.notFound('Modelo de teste não encontrado');
    return model;
  }
}
