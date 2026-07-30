CREATE TABLE "subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"source" text DEFAULT 'signup-form' NOT NULL,
	"token" text NOT NULL,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"phone" text,
	"announcements_opt_in" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "user_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_email_key" ON "subscribers" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_token_key" ON "subscribers" USING btree ("token");--> statement-breakpoint
CREATE INDEX "subscribers_confirmed_idx" ON "subscribers" USING btree ("confirmed_at","unsubscribed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "orders_user_id_idx" ON "orders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_buyer_email_idx" ON "orders" USING btree ("buyer_email");