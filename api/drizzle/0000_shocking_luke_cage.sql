CREATE TABLE "tf_alert_ack" (
	"user_id" text NOT NULL,
	"mission_id" text NOT NULL,
	"kind" text NOT NULL,
	"ack_at" text NOT NULL,
	CONSTRAINT "tf_alert_ack_user_id_mission_id_kind_pk" PRIMARY KEY("user_id","mission_id","kind"),
	CONSTRAINT "tf_alert_ack_kind" CHECK ("tf_alert_ack"."kind" IN ('missing_start','late_start'))
);
--> statement-breakpoint
CREATE TABLE "tf_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"at" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tf_case_events" (
	"id" text PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"user_id" text NOT NULL,
	"at" text NOT NULL,
	"status" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"clinical" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tf_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text,
	"store_id" text,
	"store_label" text DEFAULT '' NOT NULL,
	"author_id" text NOT NULL,
	"product_id" text,
	"kind" text NOT NULL,
	"reason" text NOT NULL,
	"category" text NOT NULL,
	"channel" text DEFAULT 'onsite' NOT NULL,
	"lot" text DEFAULT '' NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"doctor_id" text,
	"assignee_id" text,
	"due_day" text DEFAULT '' NOT NULL,
	"description" text NOT NULL,
	"private_note" text DEFAULT '' NOT NULL,
	"public_note" text DEFAULT '' NOT NULL,
	"consent" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "tf_cases_kind" CHECK ("tf_cases"."kind" IN ('complaint','request')),
	CONSTRAINT "tf_cases_category" CHECK ("tf_cases"."category" IN ('quality','commercial','tolerance')),
	CONSTRAINT "tf_cases_status" CHECK ("tf_cases"."status" IN ('new','assigned','ongoing','waiting','resolved','closed')),
	CONSTRAINT "tf_cases_priority" CHECK ("tf_cases"."priority" IN ('normal','priority'))
);
--> statement-breakpoint
CREATE TABLE "tf_complaints" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"author_id" text NOT NULL,
	"product_id" text,
	"category" text NOT NULL,
	"lot" text DEFAULT '' NOT NULL,
	"code" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"doctor_id" text,
	"description" text NOT NULL,
	"private_note" text DEFAULT '' NOT NULL,
	"public_note" text DEFAULT '' NOT NULL,
	"consent" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "tf_complaints_category" CHECK ("tf_complaints"."category" IN ('quality','commercial','tolerance'))
);
--> statement-breakpoint
CREATE TABLE "tf_counts" (
	"mission_id" text NOT NULL,
	"product_id" text NOT NULL,
	"opening" integer NOT NULL,
	"received" integer DEFAULT 0 NOT NULL,
	"other_out" integer DEFAULT 0 NOT NULL,
	"closing" integer,
	"damaged" integer DEFAULT 0 NOT NULL,
	"expiring" integer DEFAULT 0 NOT NULL,
	"expiry" text DEFAULT '' NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "tf_counts_mission_id_product_id_pk" PRIMARY KEY("mission_id","product_id"),
	CONSTRAINT "tf_counts_opening" CHECK ("tf_counts"."opening" >= 0),
	CONSTRAINT "tf_counts_received" CHECK ("tf_counts"."received" >= 0),
	CONSTRAINT "tf_counts_other_out" CHECK ("tf_counts"."other_out" >= 0),
	CONSTRAINT "tf_counts_closing" CHECK ("tf_counts"."closing" IS NULL OR "tf_counts"."closing" >= 0),
	CONSTRAINT "tf_counts_damaged" CHECK ("tf_counts"."damaged" >= 0),
	CONSTRAINT "tf_counts_expiring" CHECK ("tf_counts"."expiring" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tf_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tf_devices_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "tf_field_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"author_id" text NOT NULL,
	"mission_id" text,
	"store_id" text,
	"store_label" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"product_id" text,
	"brand" text DEFAULT '' NOT NULL,
	"competitor" text DEFAULT '' NOT NULL,
	"sentiment" text DEFAULT 'neutral' NOT NULL,
	"description" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"manager_note" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "tf_field_notes_category" CHECK ("tf_field_notes"."category" IN ('shelf','competitor','feedback','availability','opportunity','other')),
	CONSTRAINT "tf_field_notes_sentiment" CHECK ("tf_field_notes"."sentiment" IN ('positive','neutral','negative')),
	CONSTRAINT "tf_field_notes_status" CHECK ("tf_field_notes"."status" IN ('new','seen','actioned'))
);
--> statement-breakpoint
CREATE TABLE "tf_field_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"user_id" text NOT NULL,
	"object_key" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "tf_field_photos_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "tf_missions" (
	"id" text PRIMARY KEY NOT NULL,
	"store_id" text NOT NULL,
	"field_id" text NOT NULL,
	"day" text NOT NULL,
	"start_at" text NOT NULL,
	"end_at" text NOT NULL,
	"brands" jsonb NOT NULL,
	"device_id" text,
	"device_location" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"actual_start" text,
	"actual_end" text,
	"cancel_reason" text DEFAULT '' NOT NULL,
	"report_status" text DEFAULT 'draft' NOT NULL,
	"report_notes" text DEFAULT '' NOT NULL,
	"review_note" text DEFAULT '' NOT NULL,
	"no_sales" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_at" text NOT NULL,
	"late_grace_minutes" integer DEFAULT 15 NOT NULL,
	"start_photo_id" text,
	"end_photo_id" text,
	CONSTRAINT "tf_missions_status" CHECK ("tf_missions"."status" IN ('planned','ongoing','completed','cancelled')),
	CONSTRAINT "tf_missions_report_status" CHECK ("tf_missions"."report_status" IN ('draft','submitted','approved','changes')),
	CONSTRAINT "tf_missions_time" CHECK ("tf_missions"."start_at" < "tf_missions"."end_at")
);
--> statement-breakpoint
CREATE TABLE "tf_ops" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tf_photos" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"caption" text DEFAULT '' NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"object_key" text NOT NULL,
	"purpose" text DEFAULT 'report' NOT NULL,
	CONSTRAINT "tf_photos_object_key_unique" UNIQUE("object_key")
);
--> statement-breakpoint
CREATE TABLE "tf_products" (
	"id" text PRIMARY KEY NOT NULL,
	"brand" text NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"unit" text DEFAULT 'pièce' NOT NULL,
	"price_hint" integer DEFAULT 0 NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"image_url" text DEFAULT '' NOT NULL,
	"source_url" text DEFAULT '' NOT NULL,
	"source_id" text DEFAULT '' NOT NULL,
	"is_bulk" integer DEFAULT 0 NOT NULL,
	"catalog_at" text DEFAULT '' NOT NULL,
	CONSTRAINT "tf_products_brand_sku" UNIQUE("brand","sku"),
	CONSTRAINT "tf_products_brand" CHECK ("tf_products"."brand" IN ('TOUCHE','BELNCO','NOOM')),
	CONSTRAINT "tf_products_price" CHECK ("tf_products"."price_hint" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tf_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tf_store_prices" (
	"store_id" text NOT NULL,
	"product_id" text NOT NULL,
	"unit_price" integer NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "tf_store_prices_store_id_product_id_pk" PRIMARY KEY("store_id","product_id"),
	CONSTRAINT "tf_store_prices_price" CHECK ("tf_store_prices"."unit_price" > 0)
);
--> statement-breakpoint
CREATE TABLE "tf_stores" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"city" text NOT NULL,
	"address" text NOT NULL,
	"contact" text DEFAULT '' NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"active" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tf_throttle" (
	"bucket" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tf_tickets" (
	"id" text PRIMARY KEY NOT NULL,
	"mission_id" text NOT NULL,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"lines" jsonb NOT NULL,
	"total" integer NOT NULL,
	"status" text DEFAULT 'valid' NOT NULL,
	"void_reason" text DEFAULT '' NOT NULL,
	"bonus_amount" integer DEFAULT 5000 NOT NULL,
	CONSTRAINT "tf_tickets_total" CHECK ("tf_tickets"."total" >= 0),
	CONSTRAINT "tf_tickets_status" CHECK ("tf_tickets"."status" IN ('valid','void')),
	CONSTRAINT "tf_tickets_bonus" CHECK ("tf_tickets"."bonus_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "tf_users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"label" text NOT NULL,
	"role" text NOT NULL,
	"active" integer DEFAULT 1 NOT NULL,
	"salt" text NOT NULL,
	"password_hash" text NOT NULL,
	"force_change" integer DEFAULT 1 NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "tf_users_username_unique" UNIQUE("username"),
	CONSTRAINT "tf_users_role" CHECK ("tf_users"."role" IN ('admin','manager','field','doctor'))
);
--> statement-breakpoint
ALTER TABLE "tf_alert_ack" ADD CONSTRAINT "tf_alert_ack_user_id_tf_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."tf_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_alert_ack" ADD CONSTRAINT "tf_alert_ack_mission_id_tf_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."tf_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_case_events" ADD CONSTRAINT "tf_case_events_case_id_tf_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."tf_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_case_events" ADD CONSTRAINT "tf_case_events_user_id_tf_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."tf_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_cases" ADD CONSTRAINT "tf_cases_mission_id_tf_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."tf_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_cases" ADD CONSTRAINT "tf_cases_store_id_tf_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."tf_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_cases" ADD CONSTRAINT "tf_cases_author_id_tf_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."tf_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_cases" ADD CONSTRAINT "tf_cases_product_id_tf_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."tf_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_cases" ADD CONSTRAINT "tf_cases_doctor_id_tf_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."tf_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_cases" ADD CONSTRAINT "tf_cases_assignee_id_tf_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."tf_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_complaints" ADD CONSTRAINT "tf_complaints_mission_id_tf_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."tf_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_complaints" ADD CONSTRAINT "tf_complaints_product_id_tf_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."tf_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_complaints" ADD CONSTRAINT "tf_complaints_doctor_id_tf_users_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."tf_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_counts" ADD CONSTRAINT "tf_counts_mission_id_tf_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."tf_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_counts" ADD CONSTRAINT "tf_counts_product_id_tf_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."tf_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_field_notes" ADD CONSTRAINT "tf_field_notes_author_id_tf_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."tf_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_field_notes" ADD CONSTRAINT "tf_field_notes_mission_id_tf_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."tf_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_field_notes" ADD CONSTRAINT "tf_field_notes_store_id_tf_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."tf_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_field_notes" ADD CONSTRAINT "tf_field_notes_product_id_tf_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."tf_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_field_photos" ADD CONSTRAINT "tf_field_photos_note_id_tf_field_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."tf_field_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_field_photos" ADD CONSTRAINT "tf_field_photos_user_id_tf_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."tf_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_missions" ADD CONSTRAINT "tf_missions_store_id_tf_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."tf_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_missions" ADD CONSTRAINT "tf_missions_field_id_tf_users_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."tf_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_missions" ADD CONSTRAINT "tf_missions_device_id_tf_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."tf_devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_photos" ADD CONSTRAINT "tf_photos_mission_id_tf_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."tf_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_sessions" ADD CONSTRAINT "tf_sessions_user_id_tf_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."tf_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_store_prices" ADD CONSTRAINT "tf_store_prices_store_id_tf_stores_id_fk" FOREIGN KEY ("store_id") REFERENCES "public"."tf_stores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_store_prices" ADD CONSTRAINT "tf_store_prices_product_id_tf_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."tf_products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tf_tickets" ADD CONSTRAINT "tf_tickets_mission_id_tf_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."tf_missions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tf_cases_created" ON "tf_cases" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tf_cases_author" ON "tf_cases" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "tf_complaints_time" ON "tf_complaints" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "tf_field_notes_date" ON "tf_field_notes" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "tf_mission_day" ON "tf_missions" USING btree ("day","field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tf_one_ongoing" ON "tf_missions" USING btree ("field_id") WHERE status = 'ongoing';--> statement-breakpoint
CREATE INDEX "tf_tickets_mission" ON "tf_tickets" USING btree ("mission_id","created_at");