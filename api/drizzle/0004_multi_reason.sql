ALTER TABLE "tf_cases" ADD COLUMN IF NOT EXISTS "reasons" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "tf_cases" SET "reasons"="reason" WHERE "reasons"='';