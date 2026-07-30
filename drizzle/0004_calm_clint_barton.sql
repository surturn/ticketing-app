ALTER TYPE "public"."ledger_entity" ADD VALUE 'event';--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "archived_at" timestamp with time zone;