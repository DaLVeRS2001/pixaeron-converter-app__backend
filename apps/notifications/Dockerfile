# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS builder

WORKDIR /workspace

ENV HUSKY=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json nx.json tsconfig.base.json ./
COPY webpack.app.config.js ./
COPY apps/notifications/package.json ./apps/notifications/package.json
COPY libs ./libs
COPY tools ./tools

RUN --mount=type=cache,target=/root/.npm \
  npm ci --workspaces --include-workspace-root

COPY apps/notifications ./apps/notifications

RUN find libs -path '*/src/generated/*' -type f -exec chmod 0644 {} + \
  && npx nx run notifications:prune

FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

LABEL com.pixaeron.service="notifications"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/dist/apps/notifications/package.json ./package.json
COPY --from=builder /workspace/dist/apps/notifications/package-lock.json ./package-lock.json
COPY --from=builder /workspace/dist/apps/notifications/workspace_modules ./workspace_modules

RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --from=builder --chown=node:node /workspace/dist/apps/notifications/ ./
COPY --from=builder --chown=node:node /workspace/apps/notifications/prisma ./apps/notifications/prisma
COPY --from=builder --chown=node:node /workspace/apps/notifications/prisma.config.ts ./apps/notifications/prisma.config.ts

EXPOSE 3004 50052

USER node

CMD ["node", "main.js"]
