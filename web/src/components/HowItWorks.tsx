/**
 * Four steps, stated before the buyer commits to the first.
 *
 * Most people arriving here have been sent a link by a friend and have never
 * bought from this site. The anxiety at that moment is not price, it is
 * process: what happens after I pay, and how do I get in. Answering it beside
 * the pay button costs one strip and removes the reason to close the tab.
 */
const STEPS = [
  { n: 1, title: 'Choose tickets', body: 'Select your preferred tickets' },
  { n: 2, title: 'Review order', body: 'Confirm your details' },
  { n: 3, title: 'Secure checkout', body: 'Pay safely with M-Pesa' },
  { n: 4, title: 'Receive tickets', body: 'Get QR tickets via email' },
];

export function HowItWorks() {
  return (
    <ol className="grid gap-6 rounded-lg bg-surface-container-low p-6 sm:grid-cols-2 sm:p-8 lg:grid-cols-4">
      {STEPS.map((step) => (
        <li key={step.n} className="flex gap-3 sm:flex-col sm:gap-3">
          <span
            className="md-label-large flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary"
            aria-hidden="true"
          >
            {step.n}
          </span>
          <div className="min-w-0">
            <p className="md-title-small text-on-surface">{step.title}</p>
            <p className="md-body-small mt-1 text-on-surface-variant">{step.body}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
