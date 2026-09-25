import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { ReportsService } from './reports.service';

/**
 * QUEUE_PORT and STORAGE_PORT come from the global `QueueModule` /
 * `StorageModule` — no import needed here, same as `TestsModule`.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, ReportsRepository],
})
export class ReportsModule {}
