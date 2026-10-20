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

/** Evento bruto exibido no detalhe de uma sessão, ordenado por `tMs`. */
export interface SessionTelemetryEvent extends TelemetryEvent {
  receivedAt: string;
}

export interface TelemetryStorePort {
  /**
   * Append events. Resends must not inflate metrics — implementations upsert on
   * (session_id, event_id) so duplicates are ignored.
   */
  append(events: TelemetryEvent[]): Promise<void>;
  countForSession(sessionId: string): Promise<number>;
  /** Sessões distintas de um teste com ao menos um evento recebido. */
  countSessionsWithEvents(testId: string): Promise<number>;
  /** Eventos brutos de uma sessão para a linha do tempo do estúdio. */
  listForSession(sessionId: string, limit: number): Promise<SessionTelemetryEvent[]>;
}

export const TELEMETRY_STORE_PORT = Symbol('TELEMETRY_STORE_PORT');
