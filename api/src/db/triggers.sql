-- ThinkerCare Terrain integrity triggers, ported from the SQLite originals
-- 0002_terrain.sql, 0004_terrain_workflow.sql and 0005_service_primes_terrain.sql
-- (git history: 710d9ea:app/migrations/) to PL/pgSQL. Applied by dist/db/migrate.js
-- AFTER the Drizzle schema migrations, on every boot. Idempotent and lock-light:
-- functions are CREATE OR REPLACE'd, and a trigger is only created when missing,
-- so an unchanged boot takes no table lock (DROP TRIGGER would take an ACCESS
-- EXCLUSIVE lock on the table). To change a trigger's events or timing, drop it
-- explicitly above its CREATE so the next boot recreates it.
--
-- Semantics preserved exactly:
--   tf_no_overlap        -> SCHEDULE_CONFLICT  (animatrice / Dermoscan double-booking)
--   tf_counts_editable   -> REPORT_LOCKED      (stock edits only while report editable)
--   tf_tickets_editable  -> REPORT_LOCKED      (sales edits only while report editable)
--   tf_ticket_stock      -> STOCK_INSUFFICIENT (no overselling counted stock)
--   tf_field_photo_limit -> FIELD_PHOTO_LIMIT  (<=5 photos per field observation)
-- SQLite json_each(lines) -> Postgres jsonb_array_elements(lines).

-- ---------------------------------------------------------------------------
-- Schedule overlap check: DISABLED by request. Overlapping missions are now
-- allowed — the same animatrice (or the same Dermoscan) may be programmed on
-- overlapping horaires. We drop both the trigger AND its function so that
-- existing databases have the restriction removed on the next deploy, and
-- fresh databases never install it. Both steps are no-ops once done.
-- To re-enable: restore the tf_no_overlap() function and a BEFORE INSERT OR
-- UPDATE trigger on tf_missions that RAISE EXCEPTION 'SCHEDULE_CONFLICT' when a
-- non-cancelled mission overlaps another for the same field_id or device_id.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tf_no_overlap' AND tgrelid = 'tf_missions'::regclass) THEN
    DROP TRIGGER tf_no_overlap ON tf_missions;
  END IF;
END $$;
DROP FUNCTION IF EXISTS tf_no_overlap();

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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tf_counts_editable' AND tgrelid = 'tf_counts'::regclass) THEN
    CREATE TRIGGER tf_counts_editable
      BEFORE INSERT OR UPDATE ON tf_counts
      FOR EACH ROW EXECUTE FUNCTION tf_counts_editable();
  END IF;
END $$;

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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tf_tickets_editable' AND tgrelid = 'tf_tickets'::regclass) THEN
    CREATE TRIGGER tf_tickets_editable
      BEFORE INSERT OR UPDATE ON tf_tickets
      FOR EACH ROW EXECUTE FUNCTION tf_tickets_editable();
  END IF;
END $$;

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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tf_ticket_stock' AND tgrelid = 'tf_tickets'::regclass) THEN
    CREATE TRIGGER tf_ticket_stock
      BEFORE INSERT ON tf_tickets
      FOR EACH ROW EXECUTE FUNCTION tf_ticket_stock();
  END IF;
END $$;

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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tf_field_photo_limit' AND tgrelid = 'tf_field_photos'::regclass) THEN
    CREATE TRIGGER tf_field_photo_limit
      BEFORE INSERT ON tf_field_photos
      FOR EACH ROW EXECUTE FUNCTION tf_field_photo_limit();
  END IF;
END $$;
