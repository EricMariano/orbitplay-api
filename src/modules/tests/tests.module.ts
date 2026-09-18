import { Module } from '@nestjs/common';
import { BuildsModule } from '../builds/builds.module';
import { GamesModule } from '../games/games.module';
import { TestModelsModule } from '../test-models/test-models.module';
import { TestsController } from './tests.controller';
import { TestsRepository } from './tests.repository';
import { TestsService } from './tests.service';

@Module({
  imports: [TestModelsModule, GamesModule, BuildsModule],
  controllers: [TestsController],
  providers: [TestsService, TestsRepository],
  exports: [TestsService],
})
export class TestsModule {}
