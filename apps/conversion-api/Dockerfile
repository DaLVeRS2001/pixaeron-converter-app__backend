# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS builder

WORKDIR /workspace

ENV HUSKY=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json nx.json tsconfig.base.json ./
COPY webpack.app.config.js ./
COPY apps/conversion-api/package.json ./apps/conversion-api/package.json
COPY libs ./libs
COPY tools ./tools

RUN --mount=type=cache,target=/root/.npm \
  npm ci --workspaces --include-workspace-root

COPY apps/conversion-api ./apps/conversion-api

RUN find libs -path '*/src/generated/*' -type f -exec chmod 0644 {} + \
  && npx nx run conversion-api:prune

FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

LABEL com.pixaeron.service="conversion-api"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/dist/apps/conversion-api/package.json ./package.json
COPY --from=builder /workspace/dist/apps/conversion-api/package-lock.json ./package-lock.json
COPY --from=builder /workspace/dist/apps/conversion-api/workspace_modules ./workspace_modules

RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --from=builder --chown=node:node /workspace/dist/apps/conversion-api/ ./
COPY --from=builder --chown=node:node /workspace/apps/conversion-api/prisma ./apps/conversion-api/prisma
COPY --from=builder --chown=node:node /workspace/apps/conversion-api/prisma.config.ts ./apps/conversion-api/prisma.config.ts

EXPOSE 3005

USER node

CMD ["node", "main.js"]
