/**
 * Guards the test suites that delete data.
 *
 * Several suites truncate whole tables in `beforeEach`, because what they assert
 * is the database's own behaviour — oversell under concurrency, an append-only
 * ledger, a purge that must not take a paid order with it. None of that can be
 * tested against rows left over from the last run.
 *
 * The hazard is that `.env` in this repo points `DATABASE_URL` at the *local
 * development* database rather than a test one, so `RUN_DB_TESTS=true` on a
 * default checkout deletes the developer's own seed data. That is not
 * hypothetical: it happened, and the only warning was a comment at the top of
 * one suite. A comment does not run.
 *
 * So the check is code, and it fails loudly at import time rather than after the
 * first `delete`. Name the database so it is plainly disposable — `ticketing_test`
 * — or point `TEST_DATABASE_URL` at one deliberately.
 */
export function assertDisposableDatabase(): void {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

  if (!url) {
    throw new Error(
      'RUN_DB_TESTS=true but no DATABASE_URL is set. These tests truncate tables;\n' +
        '  point DATABASE_URL at a throwaway database, e.g. ticketing_test.',
    );
  }

  let name: string;
  try {
    name = new URL(url).pathname.slice(1);
  } catch {
    throw new Error(`DATABASE_URL is not a valid URL, so it cannot be checked: ${url}`);
  }

  // Matches ticketing_test, test_ticketing, ticketing-test — and not
  // "latest", "contest", or a production database that merely contains those
  // letters somewhere.
  if (!/(^|[_-])test($|[_-])/.test(name)) {
    throw new Error(
      `Refusing to run destructive tests against a database named "${name}".\n` +
        '  These suites truncate tables. Point DATABASE_URL (or TEST_DATABASE_URL)\n' +
        '  at a throwaway database whose name marks it as one, e.g. ticketing_test.',
    );
  }
}

/** True when the database-backed suites were asked for. */
export const dbTestsEnabled = process.env.RUN_DB_TESTS === 'true';

/**
 * The one line each destructive suite needs: opt-in check, then safety check.
 *
 * Returns whether to run, so a suite can `describe.skipIf(!shouldRunDbTests())`.
 * The guard only fires when the suites were actually requested — a normal
 * `npm test` skips them and must not be failed by a DATABASE_URL it never uses.
 */
export function shouldRunDbTests(): boolean {
  if (!dbTestsEnabled) return false;
  assertDisposableDatabase();
  return true;
}
