# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS builder

WORKDIR /workspace

ENV HUSKY=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json nx.json tsconfig.base.json ./
COPY webpack.app.config.js ./
COPY apps/conversion-worker/package.json ./apps/conversion-worker/package.json
COPY libs ./libs
COPY tools ./tools

RUN --mount=type=cache,target=/root/.npm \
  npm ci --workspaces --include-workspace-root

COPY apps/conversion-worker ./apps/conversion-worker

RUN find libs -path '*/src/generated/*' -type f -exec chmod 0644 {} + \
  && npx nx run conversion-worker:prune

FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

LABEL com.pixaeron.service="conversion-worker"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /workspace/dist/apps/conversion-worker/package.json ./package.json
COPY --from=builder /workspace/dist/apps/conversion-worker/package-lock.json ./package-lock.json
COPY --from=builder /workspace/dist/apps/conversion-worker/workspace_modules ./workspace_modules

RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --from=builder --chown=node:node /workspace/dist/apps/conversion-worker/ ./

USER node

CMD ["node", "main.js"]
