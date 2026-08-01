/**
 * Applies the stored theme before the first paint.
 *
 * An external file rather than an inline script, and that is the point. Inline
 * needs either `'unsafe-inline'` — which defeats the CSP — or a hash of its
 * exact bytes, and a hash cannot be relied upon here: Cloudflare rewrites the
 * document in flight for browser requests, so what the server hashed and what
 * the browser parsed are not the same text. The hash was correct and still
 * failed, which is the worst kind of wrong.
 *
 * Served from our own origin, so plain `script-src 'self'` covers it and there
 * is nothing left to drift. Loaded synchronously in `<head>`: it must finish
 * before the first paint, or a light-mode visitor gets a dark flash on every
 * load. One same-origin request over an already-open connection is a cheaper
 * price than either that flash or a weakened policy.
 */
try {
  var stored = localStorage.getItem('eventify-theme');
  var light = stored
    ? stored === 'light'
    : window.matchMedia('(prefers-color-scheme: light)').matches;
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
} catch (e) {
  // Light, not dark. White is a dominant brand colour and light is the default
  // theme — falling back to dark would make a storage failure silently change
  // which theme the product ships as.
  document.documentElement.dataset.theme = 'light';
}
