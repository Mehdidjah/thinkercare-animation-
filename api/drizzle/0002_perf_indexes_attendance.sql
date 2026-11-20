ALTER TABLE "tf_alert_ack" DROP CONSTRAINT IF EXISTS "tf_alert_ack_kind";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tf_audit_at" ON "tf_audit" USING btree ("at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tf_field_photos_note" ON "tf_field_photos" USING btree ("note_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tf_mission_field" ON "tf_missions" USING btree ("field_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tf_mission_store" ON "tf_missions" USING btree ("store_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tf_photos_mission" ON "tf_photos" USING btree ("mission_id","created_at");--> statement-breakpoint
ALTER TABLE "tf_alert_ack" ADD CONSTRAINT "tf_alert_ack_kind" CHECK ("tf_alert_ack"."kind" IN ('missing_start','late_start','missing_end'));