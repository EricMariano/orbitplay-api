/**
 * Session heartbeat liveness, kept in Redis instead of a DB column — no
 * schema change needed for something this ephemeral (mirrors how upload
 * sessions and idempotency results already live in Redis, not Postgres).
 * The worker's reconciliation sweep (`reconcile.processor.ts`) reads the same
 * key: a session in an open DB status with no key left is the timeout case
 * design describes ("sem heartbeat na janela configurada → encerrada por
 * timeout, entra na validação como incompleta").
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_SECONDS = 60;

export function heartbeatKey(sessionId: string): string {
  return `session:heartbeat:${sessionId}`;
}
