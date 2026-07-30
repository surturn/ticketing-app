/**
 * Exercises the real Daraja client against Safaricom's sandbox.
 *
 * Deliberately calls `src/gateways/mpesa/daraja.ts` rather than reimplementing the
 * requests, so what passes here is the code that will run in production. Three
 * stages, each reported separately, because they fail for entirely different
 * reasons: credentials, then the push, then the status query.
 *
 *   npm run check:mpesa
 *
 * 254708374149 is Safaricom's documented sandbox test MSISDN. It always succeeds
 * without a real handset, so there is no PIN to enter.
 */
process.env.LOG_LEVEL ??= 'warn';

const SANDBOX_TEST_MSISDN = '254708374149';

const { env, mpesaConfigured, mpesaPartyB } = await import('../src/config/env.js');
const daraja = await import('../src/gateways/mpesa/daraja.js');
const { closeRedis } = await import('../src/lib/redis.js');

function heading(text: string): void {
  console.log(`\n${'─'.repeat(64)}\n${text}\n${'─'.repeat(64)}`);
}

heading('Configuration');
console.log(`environment       ${env.MPESA_ENVIRONMENT}`);
console.log(`base url          ${daraja.getBaseUrl()}`);
console.log(`shortcode         ${env.MPESA_SHORTCODE}   (signs the request)`);
console.log(`party B           ${mpesaPartyB}   (funds credit here)`);
console.log(`transaction type  ${env.MPESA_TRANSACTION_TYPE}`);
console.log(`callback url      ${env.MPESA_CALLBACK_URL}`);
console.log(`configured        ${mpesaConfigured}`);

if (!mpesaConfigured) {
  console.log('\nCredentials incomplete — set consumer key, secret, passkey and callback URL.');
  await closeRedis();
  process.exit(1);
}

if (env.MPESA_ENVIRONMENT === 'production') {
  console.log('\nRefusing to run: this would place a real charge. Set MPESA_ENVIRONMENT=sandbox.');
  await closeRedis();
  process.exit(1);
}

// ─── 1. OAuth ──────────────────────────────────────────────────────────────
heading('1. OAuth token');
let token: string;
try {
  token = await daraja.getAccessToken();
  // Enough to confirm a token came back, without putting a live bearer token in
  // a terminal log.
  console.log(`ok — token acquired (${token.length} chars, ${token.slice(0, 6)}…)`);
} catch (error) {
  console.log(`FAILED — ${(error as Error).message}`);
  console.log('\nThis is a credentials problem: check MPESA_CONSUMER_KEY and');
  console.log('MPESA_CONSUMER_SECRET against the app in the Daraja portal, and');
  console.log('confirm they are the sandbox pair rather than production.');
  await closeRedis();
  process.exit(1);
}

// ─── 2. Timestamp and password ─────────────────────────────────────────────
heading('2. Request signing');
const timestamp = daraja.generateTimestamp();
console.log(`timestamp (EAT)   ${timestamp}`);
try {
  const password = daraja.generatePassword(timestamp);
  console.log(`password          ${password.slice(0, 12)}… (${password.length} chars base64)`);
} catch (error) {
  console.log(`FAILED — ${(error as Error).message}`);
  await closeRedis();
  process.exit(1);
}

// ─── 3. STK Push ───────────────────────────────────────────────────────────
heading('3. STK Push');
console.log(`phone             ${SANDBOX_TEST_MSISDN} (sandbox test number)`);
console.log('amount            KES 1\n');

let checkoutRequestId: string | undefined;
try {
  const pushed = await daraja.stkPush({
    phone: SANDBOX_TEST_MSISDN,
    amount: 1,
    accountReference: 'TKT-SBXTEST',
    description: 'Sandbox test',
  });

  checkoutRequestId = pushed.CheckoutRequestID;

  console.log('ok — Daraja accepted the push');
  console.log(`  ResponseCode        ${pushed.ResponseCode}`);
  console.log(`  ResponseDescription ${pushed.ResponseDescription}`);
  console.log(`  CustomerMessage     ${pushed.CustomerMessage}`);
  console.log(`  MerchantRequestID   ${pushed.MerchantRequestID}`);
  console.log(`  CheckoutRequestID   ${pushed.CheckoutRequestID}`);
} catch (error) {
  console.log(`FAILED — ${(error as Error).message}`);
  console.log('\nCommon causes, in the order worth checking:');
  console.log('  • transaction type does not match the shortcode');
  console.log('    (sandbox 174379 is a Paybill, so it needs CustomerPayBillOnline)');
  console.log('  • passkey does not belong to MPESA_SHORTCODE');
  console.log('  • PartyB is a shortcode sandbox does not know about');
  console.log('  • callback URL rejected as malformed or not HTTPS');
  await closeRedis();
  process.exit(1);
}

// ─── 4. STK Query ──────────────────────────────────────────────────────────
//
// The same call the reconciliation worker makes. Sandbox usually reports the
// transaction as still processing for a few seconds, which is itself the useful
// result: it proves the query path works and returns something the reconciler
// can interpret as not-yet-final.
heading('4. STK Query (the reconciler path)');
await new Promise((resolve) => setTimeout(resolve, 5_000));

try {
  const queried = await daraja.stkQuery(checkoutRequestId!);
  console.log('ok — Daraja answered the query');
  console.log(`  ResultCode          ${queried.ResultCode}`);
  console.log(`  ResultDesc          ${queried.ResultDesc}`);
} catch (error) {
  const message = (error as Error).message;
  if (/being processed|500/i.test(message)) {
    console.log('still processing — expected this soon after a push.');
    console.log('The reconciler treats this as not-yet-final and retries with backoff.');
    console.log(`  detail: ${message}`);
  } else {
    console.log(`FAILED — ${message}`);
    await closeRedis();
    process.exit(1);
  }
}

heading('Result');
console.log('Sandbox STK Push works end to end: credentials, signing, push, query.');
console.log('\nThe callback will not arrive — MPESA_CALLBACK_URL is not yet serving');
console.log('this API. Run `ngrok http 4000`, point the callback at the tunnel, and');
console.log('re-run to observe settlement.');

await closeRedis();
process.exit(0);
