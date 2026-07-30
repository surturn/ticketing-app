import { createHash } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/client.js';
import { ledgerEntries, type LedgerEntity, type LedgerEntry } from '../db/schema.js';
import { logger } from '../lib/logger.js';

// ---------------------------------------------------------------------------
// The append-only ledger.
//
// `recordTransition` takes a transaction handle and nothing else — deliberately.
// A ledger entry that commits separately from the change it describes is worse
// than no ledger: it can claim a settlement that rolled back. Passing `tx` makes
// the coupling impossible to forget at a call site.
//
// The hash chain is computed in Postgres, not here. Doing it in the application
// would need a read of the previous row, a hash, then an insert — three round
// trips holding a lock, plus a race between two concurrent writers producing two
// rows that claim the same predecessor. The BEFORE INSERT trigger in migration
// 0002 does it atomically inside the insert.
// ---------------------------------------------------------------------------

export interface TransitionInput {
  entity: LedgerEntity;
  entityId: string;
  /** Dotted transition name, e.g. `payment.settled`. */
  event: string;
  fromState: string | null;
  toState: string;
  actor: string;
  orderId?: string | null;
  eventId?: string | null;
  amountCents?: number | null;
  detail?: Record<string, unknown> | null;
}

/**
 * Appends one entry, inside the caller's transaction.
 *
 * `entryHash` is a placeholder — the `ledger_entries_hash_before_insert` trigger
 * overwrites it, and `prev_hash`, with the real chained digest. It is only
 * supplied because the column is NOT NULL.
 */
export async function recordTransition(
  tx: Tx,
  input: TransitionInput,
): Promise<void> {
  await tx.insert(ledgerEntries).values({
    entity: input.entity,
    entityId: input.entityId,
    event: input.event,
    fromState: input.fromState,
    toState: input.toState,
    actor: input.actor,
    orderId: input.orderId ?? null,
    eventId: input.eventId ?? null,
    amountCents: input.amountCents ?? null,
    detail: input.detail ?? null,
    entryHash: 'set-by-trigger',
  });
}

/**
 * Appends an entry in its own transaction.
 *
 * For the few transitions with no surrounding transaction — a callback arriving
 * for a reference we never issued, say. Prefer `recordTransition` everywhere
 * else, so the entry and the change it describes commit together.
 */
export async function recordStandaloneTransition(
  input: TransitionInput,
): Promise<void> {
  await db.insert(ledgerEntries).values({
    entity: input.entity,
    entityId: input.entityId,
    event: input.event,
    fromState: input.fromState,
    toState: input.toState,
    actor: input.actor,
    orderId: input.orderId ?? null,
    eventId: input.eventId ?? null,
    amountCents: input.amountCents ?? null,
    detail: input.detail ?? null,
    entryHash: 'set-by-trigger',
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getOrderHistory(orderId: string): Promise<LedgerEntry[]> {
  return db
    .select()
    .from(ledgerEntries)
    .where(eq(ledgerEntries.orderId, orderId))
    .orderBy(ledgerEntries.seq);
}

export async function getEntityHistory(
  entity: LedgerEntity,
  entityId: string,
): Promise<LedgerEntry[]> {
  return db
    .select()
    .from(ledgerEntries)
    .where(
      sql`${ledgerEntries.entity} = ${entity} AND ${ledgerEntries.entityId} = ${entityId}`,
    )
    .orderBy(ledgerEntries.seq);
}

/** Most recent entries, newest first — for an admin audit view. */
export async function getRecentEntries(limit = 100): Promise<LedgerEntry[]> {
  return db
    .select()
    .from(ledgerEntries)
    .orderBy(desc(ledgerEntries.seq))
    .limit(Math.min(limit, 500));
}

// ---------------------------------------------------------------------------
// Chain verification
//
// Two independent checks per entry:
//
//   * content — sha256 of the row's canonical preimage still equals entry_hash,
//     so no field was altered.
//   * linkage — prev_hash equals the entry_hash of the row that actually
//     precedes it in the same chain, so none was removed or reordered.
//
// The preimage comes from Postgres (`ledger_entry_preimage`) rather than being
// re-serialised here. jsonb has its own normalised text rendering that
// `JSON.stringify` does not reproduce — sorted keys, different spacing — so a
// JavaScript-side formula would disagree with the trigger on every row carrying
// a `detail` object and report tampering that never happened. The sha256 and the
// linkage logic are still computed here, independently of the database.
//
// Chains are per-order (see migration 0002), so linkage is verified within each
// chain rather than across the table as a whole.
// ---------------------------------------------------------------------------

export interface ChainVerification {
  valid: boolean;
  entriesChecked: number;
  chainsChecked: number;
  firstBrokenSeq?: number;
  reason?: string;
}

interface VerifiableRow {
  seq: string | number;
  chainKey: string;
  entryHash: string;
  prevHash: string | null;
  preimage: string;
}

export interface VerifyChainOptions {
  limit?: number;
  /**
   * Verify only this order's chain. Scoping matters: an unscoped call reports on
   * every chain in the table, so one damaged order makes the whole answer
   * `false` and tells an operator nothing about the order they are actually
   * investigating.
   */
  orderId?: string;
}

export async function verifyChain(
  options: VerifyChainOptions = {},
): Promise<ChainVerification> {
  const limit = options.limit ?? 100_000;

  const scope =
    options.orderId === undefined
      ? sql``
      : sql`WHERE coalesce(order_id::text, 'global') = ${options.orderId}`;

  const result = await db.execute(sql`
    SELECT seq,
           coalesce(order_id::text, 'global') AS "chainKey",
           entry_hash                         AS "entryHash",
           prev_hash                          AS "prevHash",
           ledger_entry_preimage(l.*)         AS preimage
      FROM ledger_entries l
     ${scope}
     ORDER BY seq
     LIMIT ${limit}
  `);

  const rows = result as unknown as VerifiableRow[];

  const byChain = new Map<string, VerifiableRow[]>();
  for (const row of rows) {
    const bucket = byChain.get(row.chainKey);
    if (bucket) bucket.push(row);
    else byChain.set(row.chainKey, [row]);
  }

  let checked = 0;

  for (const [chainKey, entries] of byChain) {
    const outcome = verifySingleChain(entries);
    checked += outcome.checked;
    if (!outcome.valid) {
      return {
        valid: false,
        entriesChecked: checked,
        chainsChecked: byChain.size,
        firstBrokenSeq: outcome.brokenSeq,
        reason: `chain ${chainKey}: ${outcome.reason}`,
      };
    }
  }

  logger.info(
    { entriesChecked: checked, chainsChecked: byChain.size },
    'ledger chain verified',
  );

  return { valid: true, entriesChecked: checked, chainsChecked: byChain.size };
}

interface SingleChainOutcome {
  valid: boolean;
  checked: number;
  brokenSeq?: number;
  reason?: string;
}

/**
 * Verifies one chain by walking its hash links from the root.
 *
 * Traversal follows `prev_hash`, not `seq`. Those orders are not the same: `seq`
 * is an identity default, evaluated when the INSERT starts, whereas the link is
 * assigned inside the trigger after it has taken the chain lock. Two concurrent
 * appends can therefore land in the opposite order to their sequence numbers.
 * `seq` is still useful as a stable row label and a cheap read ordering — it is
 * simply not the chain's order, and walking it as if it were was a bug this
 * function previously had.
 *
 * Because it is a walk, three distinct failures are separable: a fork (two
 * entries claiming one predecessor), an orphan (an entry no walk reaches), and
 * a broken digest.
 */
function verifySingleChain(entries: VerifiableRow[]): SingleChainOutcome {
  const byPrev = new Map<string, VerifiableRow[]>();
  const roots: VerifiableRow[] = [];

  for (const entry of entries) {
    if (entry.prevHash === null) {
      roots.push(entry);
      continue;
    }
    const bucket = byPrev.get(entry.prevHash);
    if (bucket) bucket.push(entry);
    else byPrev.set(entry.prevHash, [entry]);
  }

  if (roots.length === 0) {
    return {
      valid: false,
      checked: 0,
      brokenSeq: Number(entries[0]!.seq),
      reason: 'no root entry — the first entry in the chain was removed',
    };
  }

  if (roots.length > 1) {
    return {
      valid: false,
      checked: 0,
      brokenSeq: Number(roots[1]!.seq),
      reason: `${roots.length} root entries — the chain has more than one beginning`,
    };
  }

  let current: VerifiableRow | undefined = roots[0];
  let walked = 0;

  while (current) {
    const recomputed = createHash('sha256')
      .update(current.preimage, 'utf8')
      .digest('hex');

    if (recomputed !== current.entryHash) {
      return {
        valid: false,
        checked: walked,
        brokenSeq: Number(current.seq),
        reason: 'entry_hash does not match the entry contents — it was altered',
      };
    }

    walked += 1;

    const next = byPrev.get(current.entryHash);
    if (next && next.length > 1) {
      return {
        valid: false,
        checked: walked,
        brokenSeq: Number(next[1]!.seq),
        reason: `${next.length} entries claim the same predecessor — the chain forks`,
      };
    }

    current = next?.[0];
  }

  if (walked !== entries.length) {
    return {
      valid: false,
      checked: walked,
      reason: `walked ${walked} of ${entries.length} entries — ${
        entries.length - walked
      } are unreachable, so an entry in the middle was removed`,
    };
  }

  return { valid: true, checked: walked };
}
