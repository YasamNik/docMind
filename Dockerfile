# Stage 1: Install dependencies
FROM node:22-alpine AS deps
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY apps/client/package.json apps/client/package.json
RUN pnpm install --frozen-lockfile

# Stage 2: Build server and client
FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/server/ apps/server/
COPY apps/client/ apps/client/
RUN pnpm --filter @docmind/client build
RUN pnpm --filter @docmind/server build

# Stage 3: Production image (server deps only)
FROM node:22-alpine AS production
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
RUN apk add --no-cache tini
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/server/package.json apps/server/package.json
RUN mkdir -p apps/client && echo '{"name":"@docmind/client","private":true}' > apps/client/package.json
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/server/drizzle apps/server/drizzle
COPY --from=build /app/apps/client/dist apps/client/dist

ENV NODE_ENV=production
ENV PORT=4000
EXPOSE 4000

RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/health || exit 1

USER node
WORKDIR /app/apps/server
ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
