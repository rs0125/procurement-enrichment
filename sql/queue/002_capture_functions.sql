-- Define producers only. Source-table triggers are attached separately after rollout gates.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
CREATE OR REPLACE FUNCTION enrichment.capture_warehouse()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'Warehouse' THEN
    RAISE EXCEPTION 'invalid_capture_source';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(OLD.media::jsonb,OLD.photos,OLD."googleLocation",OLD.visibility,OLD."status_updated_at")
       IS NOT DISTINCT FROM ROW(NEW.media::jsonb,NEW.photos,NEW."googleLocation",NEW.visibility,NEW."status_updated_at") THEN
      RETURN NEW;
    END IF;
  END IF;
  PERFORM enrichment.enqueue(jsonb_build_object('v',1,'action','refresh-warehouse',
    'subjectId',CASE WHEN TG_OP='DELETE' THEN OLD.id ELSE NEW.id END::text,'lane','live'));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION enrichment.capture_coordinates()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_SCHEMA <> 'public' OR TG_TABLE_NAME <> 'WarehouseData' THEN
    RAISE EXCEPTION 'invalid_capture_source';
  END IF;
  IF TG_OP='UPDATE' THEN
    IF ROW(OLD."warehouseId",OLD.latitude,OLD.longitude)
       IS NOT DISTINCT FROM ROW(NEW."warehouseId",NEW.latitude,NEW.longitude) THEN RETURN NEW; END IF;
    IF OLD."warehouseId" IS DISTINCT FROM NEW."warehouseId" THEN
      PERFORM enrichment.enqueue(jsonb_build_object('v',1,'action','refresh-warehouse',
        'subjectId',OLD."warehouseId"::text,'lane','live'));
    END IF;
  END IF;
  PERFORM enrichment.enqueue(jsonb_build_object('v',1,'action','refresh-warehouse',
    'subjectId',CASE WHEN TG_OP='DELETE' THEN OLD."warehouseId" ELSE NEW."warehouseId" END::text,'lane','live'));
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enrichment.capture_warehouse(), enrichment.capture_coordinates() FROM PUBLIC;
DO $permissions$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION enrichment.capture_warehouse(), enrichment.capture_coordinates() FROM %I',role_name);
    END IF;
  END LOOP;
END $permissions$;
COMMIT;
