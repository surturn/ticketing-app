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

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
# Migrations are applied at deploy time, so the SQL must ship with the image.
COPY drizzle ./drizzle

# Never run as root.
USER node

EXPOSE 4000

# The API is the default. The worker service overrides this with:
#   node dist/worker.js
CMD ["node", "dist/index.js"]
