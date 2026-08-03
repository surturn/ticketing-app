#!/bin/sh
# ---------------------------------------------------------------------------
# Dump the database, encrypt it, put it in object storage, prove it arrived.
#
# Runs to completion and exits, so Railway can schedule it as a cron job.
#
# The ordering matters more than it looks. Everything is streamed through a
# pipeline into one file, the file is checked for plausibility *before* it is
# uploaded, and the upload is verified by reading the object's size back. A
# backup job that exits 0 having quietly written a 200-byte error page is worse
# than one that never ran, because the first kind is discovered during a
# restore and the second is discovered by the absence of files.
# ---------------------------------------------------------------------------
set -eu

# `pipefail` is what makes the pipeline honest: without it, `pg_dump | gzip |
# openssl` reports the exit status of openssl alone, so a failed dump produces
# a perfectly well-formed encrypted file containing nothing.
# shellcheck disable=SC3040
set -o pipefail 2>/dev/null || true

need() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    echo "backup: $1 is not set" >&2
    exit 1
  fi
}

need DATABASE_URL
need R2_ACCOUNT_ID
need R2_BACKUP_BUCKET
need R2_BACKUP_ACCESS_KEY_ID
need R2_BACKUP_SECRET_ACCESS_KEY
need BACKUP_PASSPHRASE

# Smallest plausible encrypted dump. A real one is orders of magnitude larger;
# this only has to be bigger than an error page or an empty stream.
MIN_BYTES="${BACKUP_MIN_BYTES:-2048}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-30}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
KEY="backups/${STAMP}.dump.gz.enc"
FILE="/tmp/${STAMP}.dump.gz.enc"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BACKUP_BUCKET}"

cleanup() { rm -f "$FILE"; }
trap cleanup EXIT

echo "backup: dumping"

# --format=custom so a restore can be selective and parallel, and so pg_restore
# handles ordering rather than a plain SQL file depending on it.
# -aes-256-cbc with -pbkdf2: openssl's default key derivation without it is a
# single MD5 pass, which is not a reasonable thing to protect a database with.
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  | gzip -9 \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:BACKUP_PASSPHRASE \
  > "$FILE"

SIZE="$(wc -c < "$FILE" | tr -d ' ')"
echo "backup: produced ${SIZE} bytes"

if [ "$SIZE" -lt "$MIN_BYTES" ]; then
  echo "backup: refusing to upload — ${SIZE} bytes is too small to be a real dump" >&2
  exit 1
fi

echo "backup: uploading ${KEY}"

# --aws-sigv4 signs with the S3 v4 scheme, which R2 accepts. `auto` is the
# region R2 expects; it is not ignored, it is part of the signed string.
# --fail-with-body so a 4xx is an error here rather than a success with an XML
# apology written into the response.
curl --silent --show-error --fail-with-body \
  --aws-sigv4 "aws:amz:auto:s3" \
  --user "${R2_BACKUP_ACCESS_KEY_ID}:${R2_BACKUP_SECRET_ACCESS_KEY}" \
  --upload-file "$FILE" \
  "${ENDPOINT}/${KEY}"

# ─── Prove it is actually there ──────────────────────────────────────────────
#
# The upload returning 200 says the request was accepted. Reading the object
# back says it exists at the size we sent, which is the part a restore depends
# on. This is cheap and it is the difference between a backup and a hope.

REMOTE_SIZE="$(
  curl --silent --show-error --fail --head \
    --aws-sigv4 "aws:amz:auto:s3" \
    --user "${R2_BACKUP_ACCESS_KEY_ID}:${R2_BACKUP_SECRET_ACCESS_KEY}" \
    "${ENDPOINT}/${KEY}" \
  | tr -d '\r' \
  | awk 'tolower($1) == "content-length:" { print $2 }'
)"

if [ "$REMOTE_SIZE" != "$SIZE" ]; then
  echo "backup: stored size ${REMOTE_SIZE:-none} does not match ${SIZE}" >&2
  exit 1
fi

echo "backup: verified ${KEY} (${SIZE} bytes)"

# ─── Retention ───────────────────────────────────────────────────────────────
#
# Deletes only objects under `backups/` whose timestamp key is older than the
# window. The date lives in the key, so nothing has to be parsed out of
# metadata, and a key that does not match the expected shape is left alone
# rather than guessed at — this is the one part of the job that removes data,
# so it errs towards keeping things.

# Neither GNU's `-d "-N days"` nor BSD's `-v-Nd` is available here — this runs
# on `postgres:18-alpine`, whose `date` is BusyBox, and BusyBox's `-d` only
# accepts a small set of fixed formats (no relative offsets) while `-v` does
# not exist at all. `@seconds_since_1970` is the one form all three understand,
# so the offset is computed in the shell instead of asked of `date`.
NOW_EPOCH="$(date -u +%s)"
CUTOFF="$(date -u -d "@$((NOW_EPOCH - RETAIN_DAYS * 86400))" +%Y-%m-%d)"

echo "backup: pruning anything before ${CUTOFF}"

LISTING="$(
  curl --silent --show-error --fail \
    --aws-sigv4 "aws:amz:auto:s3" \
    --user "${R2_BACKUP_ACCESS_KEY_ID}:${R2_BACKUP_SECRET_ACCESS_KEY}" \
    "${ENDPOINT}?list-type=2&prefix=backups/" || true
)"

# One <Key> per line, then keep only the dated shape this job writes.
echo "$LISTING" \
  | tr '<' '\n' \
  | sed -n 's|^Key>||p' \
  | grep -E '^backups/[0-9]{4}-[0-9]{2}-[0-9]{2}T' \
  | while read -r old; do
      old_date="$(echo "$old" | sed -n 's|^backups/\([0-9-]\{10\}\)T.*|\1|p')"
      [ -n "$old_date" ] || continue
      # String comparison is safe on ISO dates, and avoids needing date parsing
      # for every key in the bucket.
      if [ "$old_date" \< "$CUTOFF" ]; then
        echo "backup: removing ${old}"
        curl --silent --show-error --fail -X DELETE \
          --aws-sigv4 "aws:amz:auto:s3" \
          --user "${R2_BACKUP_ACCESS_KEY_ID}:${R2_BACKUP_SECRET_ACCESS_KEY}" \
          "${ENDPOINT}/${old}" || echo "backup: could not remove ${old}" >&2
      fi
    done

echo "backup: done"
