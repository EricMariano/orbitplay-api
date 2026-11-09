import { Module } from '@nestjs/common';
import { ReportRecomputeLock } from '../../infra/database/report-snapshot-cache';
import {
  ReportsController,
  SessionRatingsController,
  TestInsightsController,
} from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

/**
 * QUEUE_PORT, STORAGE_PORT and TELEMETRY_STORE_PORT come from the global `QueueModule` /
 * `StorageModule` / `TelemetryModule` — no import needed here, same as `TestsModule`.
 * `ReportRecomputeLock` needs only the global `REDIS_CLIENT`.
 */
@Module({
  controllers: [ReportsController, SessionRatingsController, TestInsightsController],
  providers: [ReportsService, ReportsRepository, ReportRecomputeLock],
})
export class ReportsModule {}
