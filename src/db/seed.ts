import { eq } from 'drizzle-orm';
import { closeDatabase, db } from './client.js';
import { events, organisations, ticketTiers } from './schema.js';
import { DEFAULT_ORGANISATION_SLUG } from '../services/tenancy.service.js';
import { logger } from '../lib/logger.js';

// Creates one published event with three tiers, so the API can be exercised
// end to end immediately after `npm run db:migrate`.

const SLUG = 'sample-summit-2026';

async function main(): Promise<void> {
  const [existing] = await db
    .select()
    .from(events)
    .where(eq(events.slug, SLUG))
    .limit(1);

  if (existing) {
    logger.info({ slug: SLUG }, 'seed event already exists, nothing to do');
    return;
  }

  // Events need an owner. The migration creates this organisation; seeding
  // against a database that has not been migrated should fail loudly here
  // rather than invent one.
  const [organisation] = await db
    .select({ id: organisations.id })
    .from(organisations)
    .where(eq(organisations.slug, DEFAULT_ORGANISATION_SLUG))
    .limit(1);

  if (!organisation) {
    throw new Error(
      `No "${DEFAULT_ORGANISATION_SLUG}" organisation — run the migrations first`,
    );
  }

  const [event] = await db
    .insert(events)
    .values({
      organisationId: organisation.id,
      slug: SLUG,
      name: 'Sample Summit 2026',
      description: 'A seeded event for exercising the ticketing API.',
      venue: 'KICC, Nairobi',
      timezone: 'Africa/Nairobi',
      currency: 'KES',
      startsAt: new Date(Date.now() + 30 * 24 * 3_600_000),
      endsAt: new Date(Date.now() + 30 * 24 * 3_600_000 + 8 * 3_600_000),
      status: 'published',
    })
    .returning();

  await db.insert(ticketTiers).values([
    {
      eventId: event!.id,
      name: 'Early Bird',
      description: 'Limited release — cheapest tier.',
      priceCents: 150_000, // KES 1,500
      quantityTotal: 50,
      maxPerOrder: 4,
      sortOrder: 1,
    },
    {
      eventId: event!.id,
      name: 'General Admission',
      priceCents: 250_000, // KES 2,500
      quantityTotal: 400,
      maxPerOrder: 10,
      sortOrder: 2,
    },
    {
      eventId: event!.id,
      name: 'VIP',
      description: 'Front section, includes lunch.',
      priceCents: 750_000, // KES 7,500
      quantityTotal: 30,
      maxPerOrder: 4,
      sortOrder: 3,
    },
  ]);

  logger.info({ slug: SLUG, eventId: event!.id }, 'seeded event with 3 tiers');
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'seed failed');
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });
