import { Module } from '@nestjs/common';
import { ReportSnapshotCache } from '../../infra/database/report-snapshot-cache';
import { BuildsModule } from '../builds/builds.module';
import { GamesModule } from '../games/games.module';
import { ParticipationsController } from './participations.controller';
import { ParticipationsRepository } from './participations.repository';
import { ParticipationsService } from './participations.service';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';

@Module({
  imports: [BuildsModule, GamesModule],
  controllers: [ParticipationsController, SessionsController],
  providers: [
    ParticipationsService,
    SessionsService,
    ParticipationsRepository,
    // M10: drops the test's cached report blocks on the writes below (DRIZZLE is global).
    ReportSnapshotCache,
  ],
  exports: [ParticipationsService],
})
export class ParticipationsModule {}
