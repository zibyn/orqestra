# syntax=docker/dockerfile:1

# Installs the whole workspace and builds the web app; the worker and migrations run from here
FROM node:24-slim AS build
RUN npm install -g pnpm@11.28.5
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch
COPY . .
RUN pnpm install --offline --frozen-lockfile && pnpm build

# The web app: Nitro's self-contained Node server
FROM node:24-slim AS web
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build /app/apps/web/.output ./
USER node
EXPOSE 3000
CMD ["node", "server/index.mjs"]

# The worker runs its TypeScript on Bun; `pnpm db:migrate` (from /app) also runs in this image
FROM build AS worker
COPY --from=oven/bun:1.4-slim /usr/local/bin/bun /usr/local/bin/bun
ENV NODE_ENV=production
WORKDIR /app/apps/worker
CMD ["bun", "src/index.ts"]
