# Working on this repository

## Branches

Promotion runs in one direction:

```
feature  ->  staging  ->  main
```

- **feature** — where work happens. Branch from `staging`, not from `main`, so
  you are building on what has already been integrated.
- **staging** — the integration branch. The full suite runs here against a real
  Postgres and Redis. Two branches that each pass alone can still fail together,
  and this is the point at which that shows up.
- **main** — what is deployed. Nothing arrives here that has not passed on
  `staging` first.

Both promotions go through a pull request. Neither branch takes a direct push.

## Running the tests

Most of the suite needs nothing:

```bash
npm test          # 49 tests, no services required
npm run typecheck
```

The suites that assert database behaviour — oversell under concurrency, the
append-only ledger, what the purge refuses to delete, settlement confirmation —
are opt-in, because they need a real Postgres:

```bash
docker compose up -d postgres redis
DATABASE_URL=postgres://ticketing:ticketing@localhost:5432/ticketing_test \
  npm run db:migrate

DATABASE_URL=postgres://ticketing:ticketing@localhost:5432/ticketing_test \
  RUN_DB_TESTS=true npm test    # 88 tests
```

**Point `DATABASE_URL` at a database whose name marks it as disposable.** Those
suites truncate tables in `beforeEach`, and `.env` in this repo points at the
development database — running them against it deletes your own seed data.
`src/test/disposable-db.ts` refuses to run against anything not named as a test
database, so this fails loudly rather than quietly. Restore with `npm run db:seed`.

CI provisions its own database, so it never hits this.

## A note on versions

`docker-compose.yml` currently pins Postgres 16 and Redis 7, while production
and CI run 18 and 8. Local results are therefore a slightly weaker signal than
CI's. Aligning the compose file needs the existing volume dropped
(`docker compose down -v`) — Postgres will not open a data directory written by
an older major — so it is a deliberate step rather than something to do by
surprise.
