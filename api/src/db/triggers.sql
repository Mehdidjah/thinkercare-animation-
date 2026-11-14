-- ThinkerCare Terrain integrity triggers, ported from the SQLite originals in
-- app/migrations/0002_terrain.sql, 0004_terrain_workflow.sql and
-- 0005_service_primes_terrain.sql to PL/pgSQL. Applied by dist/db/migrate.js
-- AFTER the Drizzle schema migrations. Idempotent (CREATE OR REPLACE + drop/recreate).
--
-- Semantics preserved exactly:
--   tf_no_overlap        -> SCHEDULE_CONFLICT  (animatrice / Dermoscan double-booking)
--   tf_counts_editable   -> REPORT_LOCKED      (stock edits only while report editable)
--   tf_tickets_editable  -> REPORT_LOCKED      (sales edits only while report editable)
--   tf_ticket_stock      -> STOCK_INSUFFICIENT (no overselling counted stock)
--   tf_field_photo_limit -> FIELD_PHOTO_LIMIT  (<=5 photos per field observation)
-- SQLite json_each(lines) -> Postgres jsonb_array_elements(lines).

-- ---------------------------------------------------------------------------
-- Schedule overlap: no two non-cancelled missions may overlap in time for the
-- same field agent, nor for the same Dermoscan device.
CREATE OR REPLACE FUNCTION tf_no_overlap() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> 'cancelled' AND EXISTS (
    SELECT 1 FROM tf_missions m
    WHERE m.id <> NEW.id
      AND m.status <> 'cancelled'
      AND NEW.start_at < m.end_at
      AND NEW.end_at > m.start_at
      AND (m.field_id = NEW.field_id
           OR (NEW.device_id IS NOT NULL AND m.device_id = NEW.device_id))
  ) THEN
    RAISE EXCEPTION 'SCHEDULE_CONFLICT';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tf_no_overlap ON tf_missions;
CREATE TRIGGER tf_no_overlap
  BEFORE INSERT OR UPDATE ON tf_missions
  FOR EACH ROW EXECUTE FUNCTION tf_no_overlap();

-- ---------------------------------------------------------------------------
-- Report lock: counts may only be written while the mission is ongoing, or
-- completed with an editable report (draft / changes).
CREATE OR REPLACE FUNCTION tf_counts_editable() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tf_missions m
    WHERE m.id = NEW.mission_id
      AND (m.status = 'ongoing'
           OR (m.status = 'completed' AND m.report_status IN ('draft','changes')))
  ) THEN
    RAISE EXCEPTION 'REPORT_LOCKED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tf_counts_editable ON tf_counts;
CREATE TRIGGER tf_counts_editable
  BEFORE INSERT OR UPDATE ON tf_counts
  FOR EACH ROW EXECUTE FUNCTION tf_counts_editable();

-- ---------------------------------------------------------------------------
-- Report lock for sales tickets (same editable window).
CREATE OR REPLACE FUNCTION tf_tickets_editable() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM tf_missions m
    WHERE m.id = NEW.mission_id
      AND (m.status = 'ongoing'
           OR (m.status = 'completed' AND m.report_status IN ('draft','changes')))
  ) THEN
    RAISE EXCEPTION 'REPORT_LOCKED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tf_tickets_editable ON tf_tickets;
CREATE TRIGGER tf_tickets_editable
  BEFORE INSERT OR UPDATE ON tf_tickets
  FOR EACH ROW EXECUTE FUNCTION tf_tickets_editable();

-- ---------------------------------------------------------------------------
-- Oversell prevention (0004 revision): for each sold line that HAS a count row,
-- available (opening + received - other_out) must cover this line's qty plus the
-- qty already sold (valid tickets) of the same product in this mission.
CREATE OR REPLACE FUNCTION tf_ticket_stock() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'valid' AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.lines) l
    JOIN tf_counts s
      ON s.mission_id = NEW.mission_id
     AND s.product_id = (l.value->>'product_id')
    WHERE s.opening + s.received - s.other_out
          < (l.value->>'qty')::numeric
            + COALESCE((
                SELECT SUM((x.value->>'qty')::numeric)
                FROM tf_tickets t, jsonb_array_elements(t.lines) x
                WHERE t.mission_id = NEW.mission_id
                  AND t.status = 'valid'
                  AND (x.value->>'product_id') = s.product_id
              ), 0)
  ) THEN
    RAISE EXCEPTION 'STOCK_INSUFFICIENT';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tf_ticket_stock ON tf_tickets;
CREATE TRIGGER tf_ticket_stock
  BEFORE INSERT ON tf_tickets
  FOR EACH ROW EXECUTE FUNCTION tf_ticket_stock();

-- ---------------------------------------------------------------------------
-- Field-observation photo cap: at most 5 photos per note.
CREATE OR REPLACE FUNCTION tf_field_photo_limit() RETURNS trigger AS $$
BEGIN
  IF (SELECT COUNT(*) FROM tf_field_photos WHERE note_id = NEW.note_id) >= 5 THEN
    RAISE EXCEPTION 'FIELD_PHOTO_LIMIT';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tf_field_photo_limit ON tf_field_photos;
CREATE TRIGGER tf_field_photo_limit
  BEFORE INSERT ON tf_field_photos
  FOR EACH ROW EXECUTE FUNCTION tf_field_photo_limit();
