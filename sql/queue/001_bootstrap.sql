-- Additive PGMQ foundation only. No source triggers or processing are enabled.
-- Run as the schema/extension owner. No URLs, passwords or provider keys belong here.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(19870430, 1);

DO $bootstrap$
DECLARE installed text;
BEGIN
  SELECT extversion INTO installed FROM pg_extension WHERE extname = 'pgmq';
  IF installed IS NULL THEN
    CREATE EXTENSION pgmq VERSION '1.5.1';
  ELSIF installed <> '1.5.1' THEN
    RAISE EXCEPTION 'Unsupported PGMQ version; validate the adapter before upgrading';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'enrichment_queue_worker') THEN
    CREATE ROLE enrichment_queue_worker NOLOGIN;
  END IF;
END
$bootstrap$;

CREATE SCHEMA IF NOT EXISTS enrichment;
REVOKE ALL ON SCHEMA enrichment FROM PUBLIC;
SELECT pgmq.create('enrichment_jobs');
SELECT pgmq.create('enrichment_dead');
REVOKE ALL ON TABLE pgmq.q_enrichment_jobs, pgmq.a_enrichment_jobs,
  pgmq.q_enrichment_dead, pgmq.a_enrichment_dead FROM PUBLIC;

CREATE OR REPLACE FUNCTION enrichment.queue_contract_version()
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog
AS $$ SELECT 'pgmq-1.5.1-actions-v2'::text $$;

CREATE OR REPLACE FUNCTION enrichment.validate_message(p_message jsonb)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF jsonb_typeof(p_message) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid_queue_message' USING ERRCODE = '22023';
  END IF;
  IF octet_length(p_message::text) > 512 OR
    p_message - ARRAY['v','action','subjectId','lane'] <> '{}'::jsonb OR
    p_message->'v' IS DISTINCT FROM '1'::jsonb OR
    jsonb_typeof(p_message->'subjectId') IS DISTINCT FROM 'string' OR
    coalesce(p_message->>'subjectId','') !~ '^[1-9][0-9]{0,9}$' OR
    coalesce(p_message->>'action','') NOT IN ('refresh-warehouse','geocode','proximity',
      'image-label','document-kind','website-approval','webp','jpeg') OR
    coalesce(p_message->>'lane','') NOT IN ('live','backfill') THEN
    RAISE EXCEPTION 'invalid_queue_message' USING ERRCODE = '22023';
  END IF;
  IF (p_message->>'subjectId')::bigint > 2147483647 THEN
    RAISE EXCEPTION 'invalid_queue_subject' USING ERRCODE = '22023';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enrichment.enqueue(p_message jsonb, p_delay integer DEFAULT 0)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE sent bigint;
BEGIN
  PERFORM enrichment.validate_message(p_message);
  IF p_delay IS NULL OR p_delay < 0 OR p_delay > 604800 THEN
    RAISE EXCEPTION 'invalid_queue_delay' USING ERRCODE = '22023';
  END IF;
  SELECT pgmq.send('enrichment_jobs', p_message, p_delay) INTO sent;
  RETURN sent;
END $$;

CREATE OR REPLACE FUNCTION enrichment.claim(p_action text, p_lane text)
RETURNS TABLE(msg_id bigint, read_ct integer, enqueued_at timestamptz, vt timestamptz, message jsonb)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_action IS NOT NULL AND p_action NOT IN ('refresh-warehouse','geocode','proximity',
    'image-label','document-kind','website-approval','webp','jpeg') OR
    p_lane IS NULL OR p_lane NOT IN ('live','backfill') THEN
    RAISE EXCEPTION 'invalid_queue_filter' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY SELECT r.msg_id, r.read_ct, r.enqueued_at, r.vt, r.message
    FROM pgmq.read('enrichment_jobs', 300, 1,
      jsonb_strip_nulls(jsonb_build_object('action',p_action,'lane',p_lane))) r;
END $$;

-- Call inside the SAME transaction as a domain publication. Lock domain rows first.
CREATE OR REPLACE FUNCTION enrichment.owns_receipt(p_id bigint, p_read_ct integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE deadline timestamptz;
BEGIN
  IF p_id IS NULL OR p_id < 1 OR p_read_ct IS NULL OR p_read_ct < 1 THEN
    RAISE EXCEPTION 'invalid_queue_receipt' USING ERRCODE = '22023';
  END IF;
  SELECT q.vt INTO deadline FROM pgmq.q_enrichment_jobs q
    WHERE q.msg_id = p_id AND q.read_ct = p_read_ct
    FOR UPDATE;
  -- Check AFTER acquiring the lock: waiting for another transaction can use up VT.
  RETURN FOUND AND deadline > clock_timestamp();
END $$;

CREATE OR REPLACE FUNCTION enrichment.finish(p_id bigint, p_read_ct integer, p_followups jsonb DEFAULT '[]')
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE child jsonb;
BEGIN
  IF jsonb_typeof(p_followups) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid_queue_followups' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_followups) > 50 THEN
    RAISE EXCEPTION 'queue_fanout_limit' USING ERRCODE = '22023';
  END IF;
  IF NOT enrichment.owns_receipt(p_id, p_read_ct) THEN RETURN false; END IF;
  FOR child IN SELECT value FROM jsonb_array_elements(p_followups) LOOP
    PERFORM enrichment.enqueue(child);
  END LOOP;
  RETURN pgmq.archive('enrichment_jobs', p_id);
END $$;

CREATE OR REPLACE FUNCTION enrichment.defer(p_id bigint, p_read_ct integer, p_delay integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_delay IS NULL OR p_delay < 1 OR p_delay > 604800 THEN
    RAISE EXCEPTION 'invalid_queue_delay' USING ERRCODE = '22023';
  END IF;
  IF NOT enrichment.owns_receipt(p_id, p_read_ct) THEN RETURN false; END IF;
  PERFORM pgmq.set_vt('enrichment_jobs',p_id,p_delay);
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION enrichment.reject(p_id bigint, p_read_ct integer, p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE payload jsonb;
BEGIN
  IF p_reason IS NULL OR p_reason !~ '^[a-z][a-z0-9_]{0,63}$' THEN
    RAISE EXCEPTION 'invalid_queue_reason' USING ERRCODE = '22023';
  END IF;
  IF NOT enrichment.owns_receipt(p_id,p_read_ct) THEN RETURN false; END IF;
  SELECT jsonb_build_object('message',q.message,'sourceMessageId',q.msg_id::text,'reason',p_reason)
    INTO payload FROM pgmq.q_enrichment_jobs q WHERE q.msg_id=p_id;
  PERFORM pgmq.send('enrichment_dead',payload);
  RETURN pgmq.archive('enrichment_jobs',p_id);
END $$;

-- This counts caught delivery errors only. It is NOT the domain's paid-attempt budget.
CREATE OR REPLACE FUNCTION enrichment.fail_delivery(p_id bigint, p_read_ct integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE failures integer; seconds integer;
BEGIN
  IF NOT enrichment.owns_receipt(p_id,p_read_ct) THEN RETURN jsonb_build_object('kind','stale'); END IF;
  UPDATE pgmq.q_enrichment_jobs q SET headers = coalesce(q.headers,'{}'::jsonb)
    || jsonb_build_object('deliveryFailures',least(5,coalesce((q.headers->>'deliveryFailures')::integer,0)+1))
    WHERE q.msg_id=p_id RETURNING (headers->>'deliveryFailures')::integer INTO failures;
  IF failures >= 5 THEN
    PERFORM enrichment.reject(p_id,p_read_ct,'delivery_failures_exhausted');
    RETURN jsonb_build_object('kind','terminal','failures',failures);
  END IF;
  seconds := 300 * (2 ^ (failures-1))::integer;
  PERFORM enrichment.defer(p_id,p_read_ct,seconds);
  RETURN jsonb_build_object('kind','retry','failures',failures,'delaySeconds',seconds);
END $$;

CREATE OR REPLACE FUNCTION enrichment.queue_stats()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT jsonb_build_object(
    'pending',(SELECT count(*) FROM pgmq.q_enrichment_jobs),
    'runnable',(SELECT count(*) FROM pgmq.q_enrichment_jobs WHERE vt<=clock_timestamp()),
    'invisible',(SELECT count(*) FROM pgmq.q_enrichment_jobs WHERE vt>clock_timestamp()),
    'oldestRunnableAt',(SELECT min(enqueued_at) FROM pgmq.q_enrichment_jobs WHERE vt<=clock_timestamp()),
    'archived',(SELECT count(*) FROM pgmq.a_enrichment_jobs),
    'dead',(SELECT count(*) FROM pgmq.q_enrichment_dead));
$$;

CREATE OR REPLACE FUNCTION enrichment.prune_archive(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE removed integer;
BEGIN
  IF p_limit IS NULL OR p_limit<1 OR p_limit>1000 THEN
    RAISE EXCEPTION 'invalid_prune_limit' USING ERRCODE='22023';
  END IF;
  DELETE FROM pgmq.a_enrichment_jobs WHERE msg_id IN (
    SELECT msg_id FROM pgmq.a_enrichment_jobs WHERE archived_at<now()-interval '30 days'
    ORDER BY archived_at,msg_id LIMIT p_limit FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END $$;

-- Logical pending-job deduplication is only used by reconciliation and prerequisites.
-- Source-change capture always sends an independent immutable event.
CREATE INDEX IF NOT EXISTS enrichment_pending_subject ON pgmq.q_enrichment_jobs
  ((message->>'action'),(message->>'subjectId'));
CREATE OR REPLACE FUNCTION enrichment.ensure_pending(p_message jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE existing bigint;
BEGIN
  PERFORM enrichment.validate_message(p_message);
  PERFORM pg_advisory_xact_lock(hashtext('enrichment:'||(p_message->>'action')||':'||(p_message->>'subjectId')));
  SELECT msg_id INTO existing FROM pgmq.q_enrichment_jobs
    WHERE message->>'action'=p_message->>'action' AND message->>'subjectId'=p_message->>'subjectId'
    ORDER BY msg_id LIMIT 1;
  RETURN coalesce(existing,enrichment.enqueue(p_message));
END $$;
CREATE OR REPLACE FUNCTION enrichment.wait_for(p_id bigint,p_read_ct integer,p_delay integer,p_followups jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE child jsonb;
BEGIN
  IF jsonb_typeof(p_followups) IS DISTINCT FROM 'array' OR jsonb_array_length(p_followups)>50 THEN
    RAISE EXCEPTION 'invalid_queue_followups' USING ERRCODE='22023';
  END IF;
  IF NOT enrichment.owns_receipt(p_id,p_read_ct) THEN RETURN false; END IF;
  FOR child IN SELECT value FROM jsonb_array_elements(p_followups) LOOP
    PERFORM enrichment.ensure_pending(child);
  END LOOP;
  RETURN enrichment.defer(p_id,p_read_ct,p_delay);
END $$;
CREATE OR REPLACE FUNCTION enrichment.page_cursor(p_id bigint,p_read_ct integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NOT enrichment.owns_receipt(p_id,p_read_ct) THEN RETURN NULL; END IF;
  RETURN coalesce((SELECT (headers->>'afterImageId')::integer FROM pgmq.q_enrichment_jobs WHERE msg_id=p_id),0);
END $$;
CREATE OR REPLACE FUNCTION enrichment.advance_page(p_id bigint,p_read_ct integer,p_cursor integer,p_followups jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF p_cursor IS NULL OR p_cursor<1 THEN RAISE EXCEPTION 'invalid_cursor' USING ERRCODE='22023'; END IF;
  IF NOT enrichment.wait_for(p_id,p_read_ct,1,p_followups) THEN RETURN false; END IF;
  UPDATE pgmq.q_enrichment_jobs SET headers=coalesce(headers,'{}'::jsonb)||jsonb_build_object('afterImageId',p_cursor) WHERE msg_id=p_id;
  RETURN true;
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA enrichment FROM PUBLIC;
GRANT USAGE ON SCHEMA enrichment TO enrichment_queue_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA enrichment TO enrichment_queue_worker;
DO $permissions$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA enrichment FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA enrichment FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON TABLE pgmq.q_enrichment_jobs, pgmq.a_enrichment_jobs, pgmq.q_enrichment_dead, pgmq.a_enrichment_dead FROM %I',role_name);
    END IF;
  END LOOP;
END
$permissions$;
COMMIT;
