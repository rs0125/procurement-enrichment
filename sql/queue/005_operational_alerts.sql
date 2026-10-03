-- Database flags only: no external services, notification delivery or new cron.
-- Heartbeat is one bounded row. The view remains truthful if EC2 stops entirely.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
SELECT pg_advisory_xact_lock(19870430,1);

CREATE TABLE IF NOT EXISTS enrichment.worker_heartbeat (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  started_at timestamptz NOT NULL,
  seen_at timestamptz NOT NULL,
  last_poll_at timestamptz,
  last_completed_at timestamptz,
  healthy boolean NOT NULL
);
REVOKE ALL ON enrichment.worker_heartbeat FROM PUBLIC;

CREATE OR REPLACE FUNCTION enrichment.record_worker_heartbeat(
  p_leader_pid integer,p_started_at timestamptz,p_last_poll_at timestamptz,
  p_last_completed_at timestamptz,p_healthy boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_started_at IS NULL OR p_healthy IS NULL THEN
    RAISE EXCEPTION 'invalid_worker_heartbeat' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT FROM pg_locks WHERE locktype='advisory' AND pid=p_leader_pid
    AND classid=19870430 AND objid=2 AND objsubid=2 AND granted
    AND database=(SELECT oid FROM pg_database WHERE datname=current_database())) THEN
    RETURN false;
  END IF;
  INSERT INTO enrichment.worker_heartbeat(singleton,started_at,seen_at,last_poll_at,last_completed_at,healthy)
    VALUES(true,p_started_at,clock_timestamp(),p_last_poll_at,p_last_completed_at,p_healthy)
    ON CONFLICT(singleton) DO UPDATE SET started_at=excluded.started_at,seen_at=excluded.seen_at,
      last_poll_at=excluded.last_poll_at,last_completed_at=excluded.last_completed_at,healthy=excluded.healthy;
  RETURN true;
END $$;

CREATE OR REPLACE VIEW enrichment.alert_status AS
WITH snapshot AS (
  SELECT clock_timestamp() AS checked_at,
    (SELECT seen_at FROM enrichment.worker_heartbeat WHERE singleton) AS seen_at,
    (SELECT coalesce(last_poll_at,started_at) FROM enrichment.worker_heartbeat WHERE singleton) AS poll_at,
    (SELECT healthy FROM enrichment.worker_heartbeat WHERE singleton) AS healthy,
    (SELECT max("ranAt") AT TIME ZONE 'UTC' FROM public."CronRunLog"
      WHERE "jobName"='backup-db' AND lower(status)='success') AS backup_at,
    (SELECT count(*) FROM pgmq.q_enrichment_dead) AS dead_letters,
    -- VT is the eligibility time. Enqueue age would count intentional cooldowns.
    (SELECT min(vt) FROM pgmq.q_enrichment_jobs WHERE vt<=clock_timestamp() AND message->>'lane'='live') AS live_at,
    (SELECT min(vt) FROM pgmq.q_enrichment_jobs WHERE vt<=clock_timestamp() AND message->>'lane'='backfill') AS backfill_at
), flags AS (
  SELECT s.checked_at,v.* FROM snapshot s CROSS JOIN LATERAL (VALUES
    ('worker_heartbeat_stale',extract(epoch FROM s.checked_at-s.seen_at)::float8,180::float8,'seconds',s.seen_at IS NULL),
    ('worker_poll_stale',extract(epoch FROM s.checked_at-s.poll_at)::float8,300::float8,'seconds',s.poll_at IS NULL),
    ('worker_unhealthy',CASE WHEN s.healthy THEN 0 ELSE 1 END::float8,0::float8,'count',false),
    ('queue_live_delayed',coalesce(extract(epoch FROM s.checked_at-s.live_at),0)::float8,900::float8,'seconds',false),
    ('queue_backfill_delayed',coalesce(extract(epoch FROM s.checked_at-s.backfill_at),0)::float8,3600::float8,'seconds',false),
    ('dead_letters',s.dead_letters::float8,0::float8,'count',false),
    ('backup_overdue',extract(epoch FROM s.checked_at-s.backup_at)::float8,93600::float8,'seconds',s.backup_at IS NULL)
  ) v(code,observed_value,threshold,unit,missing)
)
SELECT code,(missing OR observed_value>threshold) AS active,
  CASE WHEN observed_value IS NULL THEN NULL ELSE greatest(0,observed_value) END AS observed_value,
  threshold,unit,missing AS missing_observation,checked_at
FROM flags;

REVOKE ALL ON enrichment.alert_status FROM PUBLIC;
REVOKE ALL ON FUNCTION enrichment.record_worker_heartbeat(integer,timestamptz,timestamptz,timestamptz,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enrichment.record_worker_heartbeat(integer,timestamptz,timestamptz,timestamptz,boolean) TO enrichment_queue_worker;
GRANT SELECT ON enrichment.alert_status TO enrichment_queue_worker;
DO $$ DECLARE r text; BEGIN
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON enrichment.worker_heartbeat,enrichment.alert_status FROM %I',r);
      EXECUTE format('REVOKE ALL ON FUNCTION enrichment.record_worker_heartbeat(integer,timestamptz,timestamptz,timestamptz,boolean) FROM %I',r);
    END IF;
  END LOOP;
END $$;
COMMIT;
