import { Module } from '@nestjs/common';
import { TestModelsController } from './test-models.controller';
import { TestModelsService } from './test-models.service';

@Module({
  controllers: [TestModelsController],
  providers: [TestModelsService],
  exports: [TestModelsService],
})
export class TestModelsModule {}
