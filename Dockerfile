# syntax=docker/dockerfile:1

# Installs the whole workspace and builds the web app; the worker and the migrations take only what they need from here
FROM node:24-slim AS build
RUN npm install -g pnpm@11.28.5
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm build
# each its own package and production dependencies, without the store and the rest of the workspace;
# the migrations keep packages/db's dev dependencies, since drizzle-kit is one
RUN pnpm --filter @orqestra/worker deploy --prod --offline /out/worker \
	&& pnpm --filter @orqestra/db deploy --offline /out/migrate

# The web app: Nitro's self-contained Node server
FROM node:24-slim AS web
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /app/apps/web/.output ./
USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]

# The worker runs its TypeScript on Bun
FROM oven/bun:1.4-slim AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/worker ./
CMD ["bun", "src/index.ts"]

# Applies the database migrations, then exits
FROM node:24-slim AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/migrate ./
USER node
CMD ["node_modules/.bin/drizzle-kit", "migrate"]
