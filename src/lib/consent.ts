/**
 * Consent, as the Data Protection Act 2019 requires it to work.
 *
 * Four properties do the work, and each one is a place this is commonly got
 * wrong:
 *
 *   1. **Freely given.** Marketing consent cannot be a condition of buying a
 *      ticket. The newsletter box is separate from the terms box, and a buyer
 *      who leaves it unticked completes checkout exactly as before.
 *   2. **Unambiguous.** A pre-ticked box is not consent, because nothing
 *      distinguishes agreement from not having looked. Every box here starts
 *      empty and stays empty until someone acts.
 *   3. **Specific.** Agreeing to terms is not agreeing to marketing, so the two
 *      are never bundled into one checkbox — the classic "I accept the terms
 *      and would like to receive offers" is a single consent covering two
 *      unrelated purposes, and is invalid for that reason.
 *   4. **Demonstrable.** Consent that cannot be evidenced later is not much use
 *      when someone asks what they agreed to, which is why the version below is
 *      stored alongside the timestamp rather than a bare boolean.
 *
 * None of this is legal advice, and the policy text itself is not written here.
 * This module governs the mechanism.
 */

/**
 * The current terms and privacy notice version.
 *
 * A date rather than a number, so a record is legible without a changelog to
 * cross-reference. Bump this whenever the wording changes materially — the
 * stored value is what proves which text a given buyer actually saw, and
 * editing the policy without bumping it silently rewrites everyone's history.
 */
export const TERMS_VERSION = '2026-08-01';

/**
 * Whether a stored acceptance still covers the current text.
 *
 * A buyer who agreed to an older version has consented to something, just not
 * to this. Callers use this to decide whether to ask again rather than to block
 * anyone: re-consent is a prompt, not a lockout.
 */
export function acceptanceIsCurrent(version: string | null): boolean {
  return version === TERMS_VERSION;
}
