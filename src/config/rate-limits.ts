/**
 * Per-route rate limits, in one place so they can be read against each other.
 *
 * Scattered through the routes as bare numbers they were impossible to review:
 * whether checkout is tighter than preview matters, and you cannot see that
 * from two files. Every limit is per client IP per window, on top of the global
 * ceiling in `server.ts`.
 *
 * Each is set from what a real person does, plus headroom, rather than from a
 * round number. Where that sum is stated below, it is the actual reasoning —
 * a limit nobody can justify is a limit somebody will raise the first time it
 * fires.
 */

const minute = '1 minute';

export const LIMITS = {
  /**
   * Announcing a sign-in.
   *
   * Firebase performs the actual authentication, so this is not the login
   * endpoint and cannot be brute-forced for a password. It is what creates the
   * local account row and claims past guest orders, which is what makes it
   * worth limiting: it is the cheapest way to enumerate whether an address has
   * orders, and the only place automated account creation touches us.
   *
   * A person signs in once and the client calls this once. Ten covers a
   * verification loop and a couple of reloads.
   */
  signIn: { max: 10, timeWindow: minute },

  /**
   * Creating an order.
   *
   * The most expensive endpoint here by some distance: it holds inventory,
   * writes to the ledger, and spends a Daraja call that Safaricom meters. It is
   * also the one worth attacking, because held inventory that never pays is
   * stock nobody else can buy.
   *
   * Five a minute is more than any genuine buyer needs — the same basket
   * retried is idempotent and does not consume a second slot.
   */
  checkout: { max: 5, timeWindow: minute },

  /**
   * Pricing a basket.
   *
   * Charges nothing and reserves nothing, so it can be looser than checkout —
   * but it does hit the database, and the confirm screen calls it on demand
   * rather than per keystroke.
   */
  checkoutPreview: { max: 30, timeWindow: minute },

  /**
   * Reading an order, including the status poll.
   *
   * The order page polls every three seconds while a payment is in flight,
   * which is twenty a minute on its own. Ninety leaves room for a buyer with
   * the page open in a couple of tabs without leaving the reference open to
   * being enumerated at speed.
   */
  orderRead: { max: 90, timeWindow: minute },

  /**
   * Subscribing to announcements.
   *
   * The most abusable endpoint in the service and the only one that is both
   * public and sends mail: without a tight limit it is a way to deliver
   * confirmation emails to a stranger's inbox, repeatedly, from our domain.
   * Three is enough for a typo and a retry.
   */
  subscribe: { max: 3, timeWindow: minute },

  /**
   * Changing or deleting your own account.
   *
   * Authenticated and self-scoped, so the risk is not takeover — it is that a
   * loop here writes to the users table as fast as it can be asked to.
   */
  accountWrite: { max: 10, timeWindow: minute },

  /** Uploading a poster: bandwidth and storage, both metered. */
  upload: { max: 10, timeWindow: minute },

  /**
   * Administrative writes.
   *
   * Behind the admin key already, so this is a backstop against a leaked key
   * being used to hammer the database rather than against the public.
   */
  adminWrite: { max: 30, timeWindow: minute },

  /**
   * Scanning at the gate.
   *
   * Deliberately high. A queue at the door is dozens of scans a minute across
   * several phones sharing one venue connection, and a limit that fired there
   * would stop people getting into an event they have paid for. The scanner
   * token is short-lived and scoped to one event, which is what makes this
   * safe to leave open.
   */
  checkIn: { max: 600, timeWindow: minute },
} as const;
