-- Reversible producer rollback: retains every queued message and domain record.
BEGIN;
SET LOCAL lock_timeout='3s';
DROP TRIGGER IF EXISTS enrichment_capture_warehouse ON public."Warehouse";
DROP TRIGGER IF EXISTS enrichment_capture_coordinates ON public."WarehouseData";
COMMIT;
