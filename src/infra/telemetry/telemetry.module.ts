import { Global, Module } from '@nestjs/common';
import { TELEMETRY_STORE_PORT } from '../../shared/ports/telemetry-store.port';
import { PostgresTelemetryStoreAdapter } from './postgres-telemetry-store.adapter';

@Global()
@Module({
  providers: [{ provide: TELEMETRY_STORE_PORT, useClass: PostgresTelemetryStoreAdapter }],
  exports: [TELEMETRY_STORE_PORT],
})
export class TelemetryModule {}
