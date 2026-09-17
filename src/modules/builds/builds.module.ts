import { Module } from '@nestjs/common';
import { BuildsController } from './builds.controller';
import { BuildsRepository } from './builds.repository';
import { BuildsService } from './builds.service';

@Module({
  controllers: [BuildsController],
  providers: [BuildsService, BuildsRepository],
})
export class BuildsModule {}
