import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db, closeDatabase } from './client.js';
import { logger } from '../lib/logger.js';

// Applies every pending migration in ./drizzle, then exits. Run this as a
// Railway pre-deploy command so a new release never serves traffic against an
// out-of-date schema.
async function main(): Promise<void> {
  logger.info('running migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });
  logger.info('migrations complete');
}

main()
  .then(async () => {
    await closeDatabase();
    process.exit(0);
  })
  .catch(async (error: unknown) => {
    logger.error({ err: error }, 'migration failed');
    await closeDatabase().catch(() => undefined);
    process.exit(1);
  });
