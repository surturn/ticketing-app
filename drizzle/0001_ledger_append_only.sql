-- ---------------------------------------------------------------------------
-- Makes ledger_entries an append-only, hash-chained audit log.
--
--   1. ledger_entry_preimage()  -- canonical byte string for one entry.
--   2. ledger_entries_hash()    -- BEFORE INSERT: chains and digests the row.
--   3. ledger_entries_frozen()  -- BEFORE UPDATE/DELETE/TRUNCATE: always raises.
--
-- The preimage lives in its own function so the trigger and the application's
-- verifier hash *the same* bytes. Duplicating the formula in TypeScript would
-- drift the first time either side changed, and a verifier that disagrees with
-- the writer is worse than no verifier -- it reports tampering that never
-- happened.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ledger_entry_preimage(
  p_seq bigint,
  p_entity text,
  p_entity_id uuid,
  p_event text,
  p_from_state text,
  p_to_state text,
  p_actor text,
  p_order_id uuid,
  p_event_id uuid,
  p_amount_cents bigint,
  p_detail jsonb,
  p_recorded_at timestamptz,
  p_prev_hash text
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  -- Fields are joined with U+001F (unit separator). Cleaned input can never
  -- contain it -- src/lib/validation.ts strips the C0 range -- so no two
  -- distinct rows can produce the same preimage by shifting a delimiter.
  SELECT concat_ws(
    chr(31),
    p_seq::text,
    p_entity,
    p_entity_id::text,
    p_event,
    coalesce(p_from_state, ''),
    p_to_state,
    p_actor,
    coalesce(p_order_id::text, ''),
    coalesce(p_event_id::text, ''),
    coalesce(p_amount_cents::text, ''),
    -- jsonb::text is Postgres' own normalised rendering (sorted keys, its own
    -- spacing). The verifier reads this same rendering back rather than
    -- re-serialising the object in JavaScript, which would differ.
    coalesce(p_detail::text, ''),
    -- Fixed UTC format with milliseconds, matching JS toISOString().
    to_char(p_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    coalesce(p_prev_hash, '')
  );
$$;
--> statement-breakpoint

-- Wrapper so the verifier can ask for a stored row's preimage without
-- restating the column list.
CREATE OR REPLACE FUNCTION ledger_entry_preimage(l ledger_entries) RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT ledger_entry_preimage(
    l.seq, l.entity::text, l.entity_id, l.event, l.from_state, l.to_state,
    l.actor, l.order_id, l.event_id, l.amount_cents, l.detail,
    l.recorded_at, l.prev_hash
  );
$$;
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Hash chain
--
-- Chains are scoped per order, with one shared 'global' bucket for entries that
-- have no order (a callback for a reference we never issued, say). That is a
-- throughput decision: a single global chain would force every writer to
-- serialise on one tip, and because the lock is transaction-scoped a checkout
-- would hold it across its whole inventory transaction -- queueing every other
-- checkout in the system behind it and destroying the concurrency the tier
-- counters were built for. Per-order scoping makes contention per-buyer, and one
-- buyer's checkout is inherently serial anyway.
--
-- Integrity is therefore verified per chain, which is also the unit reconciled in
-- practice. See the internal engineering notes for the scope this covers.
--
-- On why the previous hash is read from ledger_chain_tips and not from
-- ledger_entries itself: under READ COMMITTED a plain SELECT is snapshot-
-- dependent. A transaction that waited on a lock can still fail to see the row
-- the winner inserted, and both then claim the same predecessor -- which is
-- exactly the duplicate-prev_hash bug this replaced. `INSERT … ON CONFLICT DO
-- UPDATE … RETURNING` against a tip row is snapshot-independent: it locks the
-- row, re-reads its latest committed version, and returns that. The row lock
-- also serialises the chain, so no advisory lock is needed.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ledger_entries_hash() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_chain_key text;
  v_prev_hash text;
BEGIN
  v_chain_key := coalesce(NEW.order_id::text, 'global');

  -- Claim the chain and read its current tip atomically. The DO UPDATE touches
  -- only updated_at; its purpose is to take the row lock and force a re-read.
  INSERT INTO ledger_chain_tips (chain_key, last_hash, last_seq)
  VALUES (v_chain_key, '', 0)
  ON CONFLICT (chain_key) DO UPDATE
    SET updated_at = now()
  RETURNING last_hash INTO v_prev_hash;

  -- '' is the sentinel for "chain claimed, nothing appended yet".
  IF v_prev_hash = '' THEN
    v_prev_hash := NULL;
  END IF;

  NEW.prev_hash := v_prev_hash;

  -- sha256() is built in from Postgres 11, so no pgcrypto dependency.
  NEW.entry_hash := encode(
    sha256(
      convert_to(
        ledger_entry_preimage(
          NEW.seq, NEW.entity::text, NEW.entity_id, NEW.event, NEW.from_state,
          NEW.to_state, NEW.actor, NEW.order_id, NEW.event_id,
          NEW.amount_cents, NEW.detail, NEW.recorded_at, v_prev_hash
        ),
        'UTF8'
      )
    ),
    'hex'
  );

  -- Advance the tip. The row lock from the upsert above is still held, so no
  -- other writer on this chain can interleave here.
  UPDATE ledger_chain_tips
     SET last_hash = NEW.entry_hash,
         last_seq  = NEW.seq,
         updated_at = now()
   WHERE chain_key = v_chain_key;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER ledger_entries_hash_before_insert
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_entries_hash();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Append-only enforcement
--
-- This is what makes the ledger trustworthy rather than merely conventional.
-- Application code cannot rewrite history whatever a future bug, migration or
-- hand-run UPDATE attempts -- including code running as the table owner, which
-- a plain REVOKE would not stop.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION ledger_entries_frozen() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entries is append-only; % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Correct a mistaken entry by appending a compensating one.';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER ledger_entries_no_update
  BEFORE UPDATE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_entries_frozen();
--> statement-breakpoint

CREATE TRIGGER ledger_entries_no_delete
  BEFORE DELETE ON ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION ledger_entries_frozen();
--> statement-breakpoint

-- TRUNCATE bypasses row-level triggers entirely, so it needs its own.
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT
  EXECUTE FUNCTION ledger_entries_frozen();
--> statement-breakpoint

-- Defence in depth for any role that is not the table owner: the triggers stop
-- the owner, these REVOKEs stop everyone else before a trigger is reached.
REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries FROM PUBLIC;
--> statement-breakpoint

-- entry_hash and prev_hash are set by the trigger and are never supplied by the
-- application, so remove the ability to write them directly.
REVOKE INSERT (entry_hash, prev_hash) ON ledger_entries FROM PUBLIC;
