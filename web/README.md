# ticketing-web

Scaffold only. Toolchain is verified; no product UI has been written yet.

```bash
npm install
npm run dev        # http://localhost:3000, proxies /api → localhost:4000
npm run build
npm run typecheck
```

## Stack

React 18 · Vite 6 · TypeScript · Tailwind v4 · Framer Motion · Zustand ·
React Router 7

Installed and ready but not yet used: `qrcode.react` (ticket QR), `qr-scanner`
(gate scanning), `canvas-confetti` (celebration burst).

## Design tokens

All of them live in `src/styles/index.css` under `@theme`, which is how Tailwind
v4 generates utilities from them — so `bg-primary`, `text-gold`, `border-line`
and `ring-primary/20` all come from that one block. Change a brand value there and
it propagates everywhere.

Names are semantic rather than literal: gold is reserved for success, VIP tiers and
celebration, so `text-gold` states intent where `text-amber-500` would not.

| Token | Value |
|---|---|
| `primary` | `#3B82F6` |
| `bg` / `surface` / `elevated` | `#0B121C` / `#111A27` / `#1A2433` |
| `gold` | `#F59E0B` |
| `muted` / `line` | `#94A3B8` / `#334155` |
| `font-display` | Plus Jakarta Sans 700/800 |
| `font-sans` | Inter 400/500 |

The greys are Tailwind's slate scale, so `slate-*` utilities compose with them
directly.

Fonts are self-hosted via `@fontsource` rather than a CDN: no third-party request
on the critical path, and nothing to break if that host is unreachable. Only the
four weights the brand uses are imported.

## Notes for whoever builds the UI

**Same origin as the API.** Client code calls `/api/...` as a relative path. Vite
proxies it in development; in production the API serves this build, so the path is
already correct and there is no base URL to switch and no CORS to configure.

**`prefers-reduced-motion` is already honoured** in the base layer. The
celebration is the most motion-heavy moment in the product, so keep it working
when motion is reduced — the ticket should still appear and still read as success.

**Gate the success celebration on tickets existing, not on payment status.**
Issuance is queued, so an order can read `status: "paid"` with `ticketCount: 0`
for a moment. Wait for `status === "paid" && ticketCount > 0` from the order status
endpoint, or the reveal animates a ticket with no code on it.

**Never show raw API error messages.** Every error carries a stable `code`; map
those to the brand's friendly copy. The API's own strings are developer-facing
(`insufficient_inventory`).

`POST /api/checkout/preview` exists for the confirm step and inline validation: it
returns buyer details normalised exactly as they will be stored, so the on-blur
checkmark and the "this is what you'll be charged" figure need no guessing.
