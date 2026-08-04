import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, db } from '../db/client.js';
import {
  events,
  orderItems,
  orders,
  organisationMembers,
  organisations,
  ticketTiers,
  tickets,
} from '../db/schema.js';
import { shouldRunDbTests } from '../test/disposable-db.js';
import {
  assertEventInScope,
  eventScopeFilter,
  loadScopedEvent,
  organisationForNewEvent,
  scopeForUser,
  verifyOrganisation,
  type AdminScope,
} from './tenancy.service.js';

// ---------------------------------------------------------------------------
// The isolation these tests exist for does not apply yet — there is one
// organisation in production — and that is exactly why they are worth having
// now. The day a second organiser is onboarded, twenty-odd admin routes start
// serving somebody else's data if this is wrong, and the failure is silent:
// every response looks like a valid response.
//
// Against a real Postgres, because what is being asserted is that a query
// returns nothing, and a mock that returns nothing proves only that the mock
// was written to.
// ---------------------------------------------------------------------------

const enabled = shouldRunDbTests();

describe.skipIf(!enabled)('tenancy', () => {
  let orgA: string;
  let orgB: string;
  let eventA: string;
  let eventB: string;

  beforeEach(async () => {
    await db.delete(tickets);
    await db.delete(orderItems);
    await db.delete(orders);
    await db.delete(ticketTiers);
    await db.delete(events);
    await db.delete(organisationMembers);
    await db.delete(organisations);

    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const [a] = await db
      .insert(organisations)
      .values({ name: 'Org A', slug: `org-a-${stamp}` })
      .returning();
    const [b] = await db
      .insert(organisations)
      .values({ name: 'Org B', slug: `org-b-${stamp}` })
      .returning();

    orgA = a!.id;
    orgB = b!.id;

    const [ea] = await db
      .insert(events)
      .values({
        organisationId: orgA,
        slug: `a-${stamp}`,
        name: "A's event",
        startsAt: new Date(Date.now() + 86_400_000),
        status: 'published',
      })
      .returning();
    const [eb] = await db
      .insert(events)
      .values({
        organisationId: orgB,
        slug: `b-${stamp}`,
        name: "B's event",
        startsAt: new Date(Date.now() + 86_400_000),
        status: 'published',
      })
      .returning();

    eventA = ea!.id;
    eventB = eb!.id;
  });

  afterAll(async () => {
    await closeDatabase();
  });

  const asOrg = (organisationId: string): AdminScope => ({
    kind: 'organisation',
    organisationId,
  });
  const asPlatform: AdminScope = { kind: 'platform' };

  it("refuses to load another organisation's event", async () => {
    await expect(loadScopedEvent(asOrg(orgA), eventB)).rejects.toThrow();
    await expect(assertEventInScope(asOrg(orgA), eventB)).rejects.toThrow();
  });

  it('loads its own', async () => {
    const event = await loadScopedEvent(asOrg(orgA), eventA);
    expect(event.id).toBe(eventA);
    expect(event.organisationId).toBe(orgA);
  });

  it("reports another organisation's event as absent rather than forbidden", async () => {
    // 404, not 403. A 403 would confirm the id exists, which turns this into a
    // way to enumerate another organiser's events by watching which ids answer
    // which way — the distinction is itself information.
    await expect(loadScopedEvent(asOrg(orgA), eventB)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('is indistinguishable from an id that does not exist at all', async () => {
    const absent = await loadScopedEvent(asOrg(orgA), crypto.randomUUID()).catch(
      (e: unknown) => e,
    );
    const foreign = await loadScopedEvent(asOrg(orgA), eventB).catch((e: unknown) => e);

    expect((absent as { statusCode?: number }).statusCode).toBe(
      (foreign as { statusCode?: number }).statusCode,
    );
  });

  it('filters a listing down to one organisation', async () => {
    const forA = await db.select().from(events).where(eventScopeFilter(asOrg(orgA)));
    expect(forA.map((e) => e.id)).toEqual([eventA]);

    const forB = await db.select().from(events).where(eventScopeFilter(asOrg(orgB)));
    expect(forB.map((e) => e.id)).toEqual([eventB]);
  });

  it('lets the platform key see everything, as it always has', async () => {
    // The shared API key is how the dashboard works today. Scoping it would
    // break the running deployment, so it is a deliberate exemption.
    const all = await db.select().from(events).where(eventScopeFilter(asPlatform));
    expect(all.map((e) => e.id).sort()).toEqual([eventA, eventB].sort());

    await expect(loadScopedEvent(asPlatform, eventA)).resolves.toBeDefined();
    await expect(loadScopedEvent(asPlatform, eventB)).resolves.toBeDefined();
  });

  describe('membership', () => {
    it('resolves an account to its organisation', async () => {
      await db
        .insert(organisationMembers)
        .values({ organisationId: orgB, userId: 'uid-b', role: 'owner' });

      expect(await scopeForUser('uid-b')).toEqual({
        kind: 'organisation',
        organisationId: orgB,
      });
    });

    it('returns nothing for an account that belongs to none', async () => {
      // The caller turns this into a 403: the account has proved who it is and
      // has nothing to manage, which is not the same as being unauthenticated.
      expect(await scopeForUser('uid-nobody')).toBeNull();
    });
  });

  describe('creating an event', () => {
    it('puts it in the creating organisation', async () => {
      expect(await organisationForNewEvent(asOrg(orgB))).toBe(orgB);
    });

    it('refuses when the platform key has no default organisation to use', async () => {
      // The migration creates the default organisation. Its absence means the
      // database is not the one the code expects, and writing an event with an
      // owner nobody chose would be worse than failing.
      await expect(organisationForNewEvent(asPlatform)).rejects.toThrow(
        /default organisation/i,
      );
    });
  });

  describe('verifying an organiser', () => {
    it('refuses an organisation-scoped caller, even against its own organisation', async () => {
      // The specific hole this closes: an organiser must not be able to vet
      // itself by passing its own id.
      await expect(verifyOrganisation(asOrg(orgA), orgA, true)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it("refuses an organisation-scoped caller against another organisation too", async () => {
      await expect(verifyOrganisation(asOrg(orgA), orgB, true)).rejects.toMatchObject({
        statusCode: 403,
      });
    });

    it('lets the platform verify an organisation', async () => {
      const result = await verifyOrganisation(asPlatform, orgA, true);
      expect(result).toEqual({ id: orgA, verified: true });

      const [row] = await db
        .select()
        .from(organisations)
        .where(eq(organisations.id, orgA));
      expect(row?.verifiedAt).not.toBeNull();
    });

    it('lets the platform withdraw verification, clearing verified_at back to null', async () => {
      await verifyOrganisation(asPlatform, orgA, true);

      const result = await verifyOrganisation(asPlatform, orgA, false);
      expect(result).toEqual({ id: orgA, verified: false });

      const [row] = await db
        .select()
        .from(organisations)
        .where(eq(organisations.id, orgA));
      expect(row?.verifiedAt).toBeNull();
    });
  });
});
