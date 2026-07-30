/**
 * Verifies the Firebase service-account credential actually works.
 *
 *   npm run check:firebase
 *
 * Deliberately goes further than parsing the key. A malformed PEM, a key that has
 * been revoked, and a key belonging to a different project all produce the same
 * unhelpful failure deep inside the SDK at the first real request — which, without
 * this, would be a buyer's sign-in. Two live calls here fail fast instead:
 *
 *   listUsers  — proves the credential authenticates to Firebase Auth.
 *   createCustomToken — proves the private key can sign, which is the thing the
 *                       key exists to do and the part a truncated PEM breaks.
 *
 * Run it after every key rotation.
 */
process.env.LOG_LEVEL ??= 'silent';

const { env, firebaseConfigured } = await import('../src/config/env.js');

function line(label: string, value: unknown): void {
  console.log(`  ${label.padEnd(30)} ${String(value)}`);
}

console.log('\nConfiguration');
line('firebaseConfigured', firebaseConfigured);
line('projectId', env.FIREBASE_PROJECT_ID ?? '(unset)');
line('clientEmail', env.FIREBASE_CLIENT_EMAIL ?? '(unset)');
// The key itself is never printed. These checks catch what actually goes wrong:
// a value truncated at the first newline, and a partial paste.
line('privateKey line count', env.FIREBASE_PRIVATE_KEY?.trim().split('\n').length ?? 0);
line(
  'privateKey PEM intact',
  Boolean(
    env.FIREBASE_PRIVATE_KEY?.startsWith('-----BEGIN PRIVATE KEY-----') &&
      env.FIREBASE_PRIVATE_KEY?.trimEnd().endsWith('-----END PRIVATE KEY-----'),
  ),
);

if (!firebaseConfigured) {
  console.log('\nAccounts are not configured. Fill in the FIREBASE_* values in .env.');
  process.exit(1);
}

const { cert, initializeApp } = await import('firebase-admin/app');
const { getAuth } = await import('firebase-admin/auth');

const app = initializeApp(
  {
    credential: cert({
      projectId: env.FIREBASE_PROJECT_ID!,
      clientEmail: env.FIREBASE_CLIENT_EMAIL!,
      privateKey: env.FIREBASE_PRIVATE_KEY!,
    }),
    projectId: env.FIREBASE_PROJECT_ID!,
  },
  'credential-check',
);

console.log('\nLive checks');
try {
  const page = await getAuth(app).listUsers(1);
  line('authenticated to Auth', `yes (${page.users.length} user(s) visible)`);

  const token = await getAuth(app).createCustomToken('credential-check');
  line('private key can sign', `yes (${token.length}-char token)`);
} catch (error) {
  const code = (error as { code?: string }).code ?? '';
  const message = (error as Error).message;
  console.log(`  FAILED  ${code}`);
  console.log(`          ${message.split('\n')[0]}`);

  if (/invalid_grant|Invalid JWT|invalid_client/i.test(message)) {
    console.log(
      '\n  That usually means the key was revoked, or belongs to another project.',
    );
  } else if (/DECODER|PEM|asn1/i.test(message)) {
    console.log(
      '\n  That is a malformed private key — most often a partial paste, or \\n\n' +
        '  escapes that were not expanded.',
    );
  }
  process.exit(1);
}

console.log('\nCredential is valid.\n');
process.exit(0);
