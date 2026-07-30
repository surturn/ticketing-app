# syntax=docker/dockerfile:1

# Multi-stage so the runtime image carries no devDependencies and no TypeScript.
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------------------------------------------------------------------------
# The storefront.
#
# Its own stage with its own lockfile, so a change to either side does not
# invalidate the other's dependency layer.

FROM node:22-alpine AS web

WORKDIR /web

COPY web/package.json web/package-lock.json* ./
RUN npm ci

COPY web/ ./

# Vite inlines these at BUILD time — they are compiled into the bundle, not read
# from the environment when the server runs. A build that cannot see them
# produces a bundle that loads perfectly and then cannot sign anyone in: a
# failure with no symptom until a buyer tries.
#
# Declaring them as ARG is what makes the platform's service variables visible to
# this stage. Without these lines they are simply absent during the build.
#
# None of them is a secret. Every value ends up in the browser bundle by design;
# what protects the project is the authorised-domain list and which sign-in
# providers are enabled, not concealing these. The genuine secret is the
# service-account key, which stays in the API's environment and never appears
# here.
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID
ARG VITE_FIREBASE_APP_ID
ARG VITE_FIREBASE_MEASUREMENT_ID

RUN npm run build

# ---------------------------------------------------------------------------

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Migrations are applied at deploy time, so the SQL must ship with the image.
COPY drizzle ./drizzle
# Served at / by the API, so the buyer's pages and the M-Pesa callback share one
# origin. This path is what the storefront plugin resolves from the working
# directory — moving one means moving both.
COPY --from=web /web/dist ./web/dist

# Never run as root.
USER node

EXPOSE 4000

# The API is the default. The worker service overrides this with:
#   node dist/worker.js
CMD ["node", "dist/index.js"]
