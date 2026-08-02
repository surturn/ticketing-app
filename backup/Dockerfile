# ---------------------------------------------------------------------------
# The backup job.
#
# Built on the Postgres image rather than the application's, and that is the
# whole reason this is a separate service: `pg_dump` refuses to dump a server
# newer than itself, production runs Postgres 18, and the API image is
# node:22-alpine with no Postgres client at all. Basing on `postgres:18-alpine`
# makes the version match a property of the image instead of something to
# remember.
#
# It needs nothing from the application — no Node, no node_modules, no source.
# `curl` signs the upload with SigV4 directly, so there is no SDK here either.
# ---------------------------------------------------------------------------
FROM postgres:18-alpine

# curl for the upload (its --aws-sigv4 does the S3 signing), openssl for the
# encryption. Both are small; nothing else is installed.
RUN apk add --no-cache curl openssl

COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh

# Runs once and exits, which is what a cron service has to do — a process that
# stays up is a service Railway keeps restarting rather than a job it schedules.
CMD ["/usr/local/bin/backup.sh"]
