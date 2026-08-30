/**
 * Telemetry storage capability. Postgres implementation now (writing to the
 * day-partitioned telemetry_events table); ClickHouse later. No ingestion
 * endpoint in this task — the port and its Postgres adapter exist so the first
 * consumer can't invent a direct call.
 */
export interface TelemetryEvent {
  id: string;
  sessionId: string;
  triggerKey: string;
  type: 'counter' | 'timer' | 'ui_event' | 'vector' | 'input';
  valueNum?: number | null;
  valueJson?: unknown;
  tMs?: number | null;
  eventId: string;
}

export interface TelemetryStorePort {
  /**
   * Append events. Resends must not inflate metrics — implementations upsert on
   * (session_id, event_id) so duplicates are ignored.
   */
  append(events: TelemetryEvent[]): Promise<void>;
  countForSession(sessionId: string): Promise<number>;
}

export const TELEMETRY_STORE_PORT = Symbol('TELEMETRY_STORE_PORT');
