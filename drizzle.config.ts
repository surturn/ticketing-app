import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs this file outside the app, so src/config/env.ts never loads.
// Read .env here too, or every CLI invocation needs DATABASE_URL passed inline.
try {
  process.loadEnvFile('.env');
} catch {
  // no .env on disk — rely on the ambient environment
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL must be set to run drizzle-kit');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  casing: 'snake_case',
  verbose: true,
  strict: true,
});
