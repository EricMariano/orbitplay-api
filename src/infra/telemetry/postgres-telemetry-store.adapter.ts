import { Inject, Injectable } from '@nestjs/common';
import type postgres from 'postgres';
import { v7 as uuidv7 } from 'uuid';
import type { TelemetryEvent, TelemetryStorePort } from '../../shared/ports/telemetry-store.port';
import { PG_CLIENT } from '../database/database.module';

/**
 * Postgres implementation of TelemetryStorePort. Writes to the day-partitioned
 * telemetry_events table via raw SQL (the table is not part of the Drizzle
 * schema — see section 7). ClickHouse can replace this later behind the port.
 *
 * Resends are ignored via ON CONFLICT on the resend-dedup index, so a plug-in
 * re-sending a queued event cannot inflate metrics.
 */
@Injectable()
export class PostgresTelemetryStoreAdapter implements TelemetryStorePort {
  constructor(@Inject(PG_CLIENT) private readonly sql: postgres.Sql) {}

  async append(events: TelemetryEvent[]): Promise<void> {
    if (events.length === 0) return;
    const rows = events.map((e) => ({
      id: e.id || uuidv7(),
      session_id: e.sessionId,
      trigger_key: e.triggerKey,
      type: e.type,
      value_num: e.valueNum ?? null,
      value_json: e.valueJson ?? null,
      t_ms: e.tMs ?? null,
      event_id: e.eventId,
    }));

    // `sql(rows, ...cols)` is postgres-js's bulk-insert helper. jsonb values
    // widen to `unknown`, which the helper's generic types reject, so we cast.
    const insertRows = this.sql(
      rows as unknown as readonly Record<string, never>[],
      'id',
      'session_id',
      'trigger_key',
      'type',
      'value_num',
      'value_json',
      't_ms',
      'event_id',
    );
    await this.sql`
      INSERT INTO telemetry_events ${insertRows}
      ON CONFLICT (session_id, event_id, received_at) DO NOTHING
    `;
  }

  async countForSession(sessionId: string): Promise<number> {
    const result = await this.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM telemetry_events WHERE session_id = ${sessionId}
    `;
    return result[0]?.count ?? 0;
  }
}
