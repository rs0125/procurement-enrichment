-- FUTURE CUTOVER ONLY: requires atomic staged promotion, a tested consistent queue
-- backup, bounded reconciliation, and reviewed producer/consumer deployment gates.
-- Not part of initial Supabase setup. Enabling this captures real warehouse writes.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
CREATE OR REPLACE TRIGGER enrichment_capture_warehouse
  AFTER INSERT OR UPDATE OR DELETE ON public."Warehouse"
  FOR EACH ROW EXECUTE FUNCTION enrichment.capture_warehouse();
CREATE OR REPLACE TRIGGER enrichment_capture_coordinates
  AFTER INSERT OR UPDATE OR DELETE ON public."WarehouseData"
  FOR EACH ROW EXECUTE FUNCTION enrichment.capture_coordinates();
COMMIT;
