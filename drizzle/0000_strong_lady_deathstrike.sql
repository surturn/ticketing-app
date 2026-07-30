CREATE TYPE "public"."event_status" AS ENUM('draft', 'published', 'closed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."ledger_entity" AS ENUM('order', 'payment', 'inventory', 'ticket', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."order_status" AS ENUM('pending', 'awaiting_payment', 'paid', 'failed', 'expired', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'cancelled', 'timeout');--> statement-breakpoint
CREATE TYPE "public"."ticket_status" AS ENUM('issued', 'checked_in', 'void');--> statement-breakpoint
CREATE TYPE "public"."tier_status" AS ENUM('active', 'paused', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."webhook_status" AS ENUM('received', 'processed', 'ignored', 'failed');--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"venue" text,
	"timezone" text DEFAULT 'Africa/Nairobi' NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_chain_tips" (
	"chain_key" text PRIMARY KEY NOT NULL,
	"last_hash" text NOT NULL,
	"last_seq" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"seq" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ledger_entries_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entity" "ledger_entity" NOT NULL,
	"entity_id" uuid NOT NULL,
	"event" text NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"actor" text NOT NULL,
	"order_id" uuid,
	"event_id" uuid,
	"amount_cents" bigint,
	"detail" jsonb,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"entry_hash" text NOT NULL,
	"prev_hash" text
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"tier_name" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_items_quantity_positive" CHECK ("order_items"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"buyer_name" text NOT NULL,
	"buyer_email" text NOT NULL,
	"buyer_phone" text NOT NULL,
	"subtotal_cents" bigint NOT NULL,
	"fee_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"status" "order_status" DEFAULT 'pending' NOT NULL,
	"reserved_until" timestamp with time zone NOT NULL,
	"idempotency_key" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	CONSTRAINT "orders_totals_non_negative" CHECK ("orders"."total_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"gateway" text DEFAULT 'mpesa' NOT NULL,
	"gateway_ref" text NOT NULL,
	"merchant_ref" text,
	"amount_cents" bigint NOT NULL,
	"currency" text DEFAULT 'KES' NOT NULL,
	"payer_phone" text,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"result_code" integer,
	"result_desc" text,
	"receipt" text,
	"transaction_date" timestamp with time zone,
	"reconcile_attempts" integer DEFAULT 0 NOT NULL,
	"last_reconciled_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"raw_request" jsonb,
	"raw_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "ticket_tiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"quantity_total" integer NOT NULL,
	"quantity_reserved" integer DEFAULT 0 NOT NULL,
	"quantity_sold" integer DEFAULT 0 NOT NULL,
	"min_per_order" integer DEFAULT 1 NOT NULL,
	"max_per_order" integer DEFAULT 10 NOT NULL,
	"sales_start_at" timestamp with time zone,
	"sales_end_at" timestamp with time zone,
	"status" "tier_status" DEFAULT 'active' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_tiers_no_oversell" CHECK ("ticket_tiers"."quantity_reserved" + "ticket_tiers"."quantity_sold" <= "ticket_tiers"."quantity_total"),
	CONSTRAINT "ticket_tiers_reserved_non_negative" CHECK ("ticket_tiers"."quantity_reserved" >= 0),
	CONSTRAINT "ticket_tiers_sold_non_negative" CHECK ("ticket_tiers"."quantity_sold" >= 0),
	CONSTRAINT "ticket_tiers_price_non_negative" CHECK ("ticket_tiers"."price_cents" >= 0),
	CONSTRAINT "ticket_tiers_order_bounds" CHECK ("ticket_tiers"."min_per_order" >= 1 AND "ticket_tiers"."max_per_order" >= "ticket_tiers"."min_per_order")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"order_item_id" uuid NOT NULL,
	"tier_id" uuid NOT NULL,
	"code" text NOT NULL,
	"holder_name" text,
	"holder_email" text,
	"status" "ticket_status" DEFAULT 'issued' NOT NULL,
	"checked_in_at" timestamp with time zone,
	"checked_in_by" text,
	"sequence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gateway" text DEFAULT 'mpesa' NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "webhook_status" DEFAULT 'received' NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_tier_id_ticket_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."ticket_tiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_tiers" ADD CONSTRAINT "ticket_tiers_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_order_item_id_order_items_id_fk" FOREIGN KEY ("order_item_id") REFERENCES "public"."order_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tier_id_ticket_tiers_id_fk" FOREIGN KEY ("tier_id") REFERENCES "public"."ticket_tiers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "events_slug_key" ON "events" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "events_status_starts_at_idx" ON "events" USING btree ("status","starts_at");--> statement-breakpoint
CREATE INDEX "ledger_entries_order_id_idx" ON "ledger_entries" USING btree ("order_id","seq");--> statement-breakpoint
CREATE INDEX "ledger_entries_entity_idx" ON "ledger_entries" USING btree ("entity","entity_id","seq");--> statement-breakpoint
CREATE INDEX "ledger_entries_event_idx" ON "ledger_entries" USING btree ("event","recorded_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_entry_hash_key" ON "ledger_entries" USING btree ("entry_hash");--> statement-breakpoint
CREATE INDEX "order_items_order_id_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "order_items_tier_id_idx" ON "order_items" USING btree ("tier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "order_items_order_id_tier_id_key" ON "order_items" USING btree ("order_id","tier_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_reference_key" ON "orders" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_idempotency_key_key" ON "orders" USING btree ("idempotency_key") WHERE "orders"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "orders_event_id_idx" ON "orders" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "orders_buyer_phone_idx" ON "orders" USING btree ("buyer_phone");--> statement-breakpoint
CREATE INDEX "orders_status_reserved_until_idx" ON "orders" USING btree ("status","reserved_until");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_gateway_ref_key" ON "payments" USING btree ("gateway","gateway_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_receipt_key" ON "payments" USING btree ("receipt") WHERE "payments"."receipt" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "payments_order_id_idx" ON "payments" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "payments_status_created_at_idx" ON "payments" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "ticket_tiers_event_id_idx" ON "ticket_tiers" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_tiers_event_id_name_key" ON "ticket_tiers" USING btree ("event_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_code_key" ON "tickets" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_order_item_sequence_key" ON "tickets" USING btree ("order_item_id","sequence");--> statement-breakpoint
CREATE INDEX "tickets_order_id_idx" ON "tickets" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "tickets_event_id_status_idx" ON "tickets" USING btree ("event_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_dedupe_key_key" ON "webhook_events" USING btree ("gateway","dedupe_key");--> statement-breakpoint
CREATE INDEX "webhook_events_status_idx" ON "webhook_events" USING btree ("status");