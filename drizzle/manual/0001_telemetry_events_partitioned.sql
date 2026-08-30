-- MANUAL migration (section 7 exception): day-partitioned telemetry_events.
--
-- WHY THIS IS NOT GENERATED: Drizzle cannot express `PARTITION BY RANGE`, so
-- this table is owned here, in drizzle/manual/, and applied by the same runner
-- (src/infra/database/migrate.ts) AFTER the generated migrations — which is why
-- the `trigger_type` enum it references already exists. Never fold this into a
-- generated file; the next `db:generate` would overwrite it.
--
-- DEDUP NOTE: the frozen contract (section 9) wants UNIQUE (session_id,
-- event_id) so plug-in resends can't inflate metrics. Postgres requires a
-- unique index on a partitioned table to include the partition key, so the
-- index below is (session_id, event_id, received_at). Cross-day exactness is
-- guaranteed at ingestion time via ON CONFLICT upsert on this key (there is no
-- ingestion endpoint in this task — model + port only).

CREATE TABLE IF NOT EXISTS telemetry_events (
  id          uuid        NOT NULL,
  session_id  uuid        NOT NULL,
  trigger_key text        NOT NULL,
  type        trigger_type NOT NULL,
  value_num   double precision,
  value_json  jsonb,
  t_ms        bigint,
  event_id    text        NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, received_at)
) PARTITION BY RANGE (received_at);

-- Catch-all partition so inserts work before a daily-partition job exists.
CREATE TABLE IF NOT EXISTS telemetry_events_default
  PARTITION OF telemetry_events DEFAULT;

-- Resend-dedup key (includes partition column, per Postgres rules).
CREATE UNIQUE INDEX IF NOT EXISTS telemetry_events_session_event_uq
  ON telemetry_events (session_id, event_id, received_at);

-- Common read path: a session's events over time.
CREATE INDEX IF NOT EXISTS telemetry_events_session_time_idx
  ON telemetry_events (session_id, received_at);
