import { Module } from '@nestjs/common';
import { GamesModule } from '../games/games.module';
import { TestsModule } from '../tests/tests.module';
import { DashboardController } from './dashboard.controller';
import { DashboardRepository } from './dashboard.repository';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [GamesModule, TestsModule],
  controllers: [DashboardController],
  providers: [DashboardService, DashboardRepository],
})
export class DashboardModule {}
