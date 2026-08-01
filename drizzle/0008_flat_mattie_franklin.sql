ALTER TABLE "users" ALTER COLUMN "announcements_opt_in" SET DEFAULT false;--> statement-breakpoint
--
-- Changing the default only affects rows created from here on, so every
-- existing account keeps an opt-in nobody ever asked it for: the column
-- defaulted to true and there was no screen on which to set it, which means not
-- one of those values records a decision a person actually made.
--
-- Under section 32 of the Data Protection Act the burden of proving consent
-- sits with us, and there is no proof to offer for any of them. They are reset
-- to false. Anyone who does want to hear from us can say so in account settings
-- or at checkout, and that tick will be a real one.
--
UPDATE "users" SET "announcements_opt_in" = false;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "terms_version" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_version" text;