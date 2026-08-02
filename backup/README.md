# Database backups

A scheduled job that dumps Postgres, encrypts the dump, and stores it in object
storage. It runs once and exits, which is what makes it a cron job rather than a
service.

## Why it is its own image

`pg_dump` refuses to dump a server newer than itself. Production runs Postgres
18 and the application image is `node:22-alpine` with no Postgres client at all,
so this is built on `postgres:18-alpine` — the version match becomes a property
of the image instead of something to keep in step by hand.

It needs nothing from the application: no Node, no dependencies, no source. The
upload is signed by `curl --aws-sigv4`, so there is no SDK either.

## Schedule

`0 23 * * *` — 23:00 UTC, which is 02:00 in Nairobi. Railway cron is UTC.

`restartPolicyType: NEVER` matters: without it a failed run is retried in a
loop, and a job that cannot reach the database would keep trying all night.

## What it does, in order

1. `pg_dump --format=custom` piped through `gzip` and `openssl enc`
2. checks the result is large enough to plausibly be a dump
3. uploads it
4. **reads the object back and compares its size**
5. deletes objects older than the retention window

Steps 2 and 4 are the point. A job that exits 0 having written a 200-byte error
page is worse than one that never ran — the first is discovered during a
restore, the second by the absence of files.

`set -o pipefail` is load-bearing for the same reason. Without it the pipeline
reports openssl's exit status alone, so a failed `pg_dump` produces a perfectly
well-formed encrypted file containing nothing.

## Configuration

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Reference the Postgres service rather than pasting a string, so it survives a credential rotation |
| `R2_ACCOUNT_ID` | Same Cloudflare account as the poster bucket |
| `R2_BACKUP_BUCKET` | `eventify-backups` — **not** the poster bucket, which is public |
| `R2_BACKUP_ACCESS_KEY_ID` | From a token scoped to the backup bucket only |
| `R2_BACKUP_SECRET_ACCESS_KEY` | As above |
| `BACKUP_PASSPHRASE` | Encrypts the dump. **Lose this and the backups are unreadable** |
| `BACKUP_RETAIN_DAYS` | Optional, default 30 |
| `BACKUP_MIN_BYTES` | Optional, default 2048 |

The credential must not be the one the poster bucket uses. Those objects are
served publicly by design; these are the entire database. A leak of one must not
reach the other.

`BACKUP_PASSPHRASE` is the one piece of this with no recovery path — it is not
stored anywhere the backups are, on purpose, and a backup nobody can decrypt is
not a backup. It belongs in a password manager as well as in Railway.

## Restoring

The archive is custom-format, so decrypt to a file first. `pg_restore` can read
a stream for `--list`, but a real restore wants random access.

```sh
# 1. Fetch. Any S3 client works; this is the same signing the job uses.
curl --fail --aws-sigv4 "aws:amz:auto:s3" \
  --user "$R2_BACKUP_ACCESS_KEY_ID:$R2_BACKUP_SECRET_ACCESS_KEY" \
  "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com/$R2_BACKUP_BUCKET/backups/<stamp>.dump.gz.enc" \
  -o backup.enc

# 2. Decrypt and decompress to a file.
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass env:BACKUP_PASSPHRASE -in backup.enc | gunzip > backup.dump

# 3. Read the archive before touching anything.
pg_restore --list backup.dump | head

# 4. Restore into a scratch database first, never straight over production.
createdb restore_check
pg_restore --no-owner --no-privileges --dbname "postgres://…/restore_check" backup.dump
```

### Two things that will look like failures and are not

**`pg_restore` exits non-zero on ignorable errors.** It reports "errors ignored
on restore: N" and returns 1. Check what the errors were before concluding the
restore failed.

**Restoring an 18 dump into an older server** logs
`unrecognized configuration parameter "transaction_timeout"`. That is the newer
`pg_dump` emitting a setting the older server does not know. It is harmless, and
it does not happen when restoring into 18 — but it is the reason the local
compose file being on Postgres 16 makes a local restore test slightly noisier
than the real thing.

### What a good restore looks like

Verified on this backup: 11 tables, all four `ledger_entries` triggers
(`hash_before_insert`, `no_update`, `no_delete`, `no_truncate`), and 5 CHECK
constraints on `ticket_tiers`. Those triggers and constraints are the
append-only ledger and the oversell guard — if they are missing after a restore,
the database is structurally intact but its guarantees are gone, so they are
worth checking explicitly rather than trusting a table count.

```sql
select count(*) from information_schema.tables where table_schema = 'public';
select tgname from pg_trigger where not tgisinternal;
select count(*) from pg_constraint where contype = 'c' and conrelid = 'ticket_tiers'::regclass;
```
