-- Tenancy: events gain an owner.
--
-- Written by hand rather than left as generated. The generated version was
-- `ALTER TABLE events ADD COLUMN organisation_id uuid NOT NULL`, which is only
-- valid on an empty table — against production, where events already exist, it
-- fails outright because there is no default to give the existing rows. The
-- column therefore arrives nullable, is backfilled, and is only then tightened.
--
-- The order matters and is the whole content of this file: create the owner,
-- give every existing row that owner, and make the column NOT NULL last. Doing
-- the constraint first is the version that takes the deploy down.

CREATE TABLE "organisations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint

CREATE TABLE "organisation_members" (
	"organisation_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'staff' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_members_organisation_id_user_id_pk" PRIMARY KEY("organisation_id","user_id")
);
--> statement-breakpoint

ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organisation_members_user_idx" ON "organisation_members" USING btree ("user_id");--> statement-breakpoint

-- The organisation every existing event is assigned to.
--
-- `ON CONFLICT DO NOTHING` so re-running this migration against a database that
-- already has it is harmless — the slug is unique, and a second insert would
-- otherwise abort the whole transaction.
INSERT INTO "organisations" ("name", "slug")
VALUES ('Eventify', 'eventify')
ON CONFLICT ("slug") DO NOTHING;
--> statement-breakpoint

-- Nullable first, so the ALTER succeeds whatever is already in the table.
ALTER TABLE "events" ADD COLUMN "organisation_id" uuid;--> statement-breakpoint

UPDATE "events"
SET "organisation_id" = (SELECT "id" FROM "organisations" WHERE "slug" = 'eventify')
WHERE "organisation_id" IS NULL;
--> statement-breakpoint

-- Only now, once every row has an owner.
ALTER TABLE "events" ALTER COLUMN "organisation_id" SET NOT NULL;--> statement-breakpoint

ALTER TABLE "events" ADD CONSTRAINT "events_organisation_id_organisations_id_fk" FOREIGN KEY ("organisation_id") REFERENCES "public"."organisations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- Every tenancy-scoped query filters on this.
CREATE INDEX "events_organisation_idx" ON "events" USING btree ("organisation_id");
