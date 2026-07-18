# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS builder

WORKDIR /workspace

ENV HUSKY=0

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

# Copy all workspace libraries so adding a new internal dependency does not
# require another Dockerfile entry. The npm cache mount avoids re-downloading
# packages when this layer is rebuilt.
COPY package.json package-lock.json nx.json tsconfig.base.json ./
COPY webpack.app.config.js ./
COPY apps/auth/package.json ./apps/auth/package.json
COPY libs ./libs

RUN --mount=type=cache,target=/root/.npm \
  npm ci --workspaces --include-workspace-root

COPY apps/auth ./apps/auth

# Nx builds auth and creates a standalone package.json, pruned lockfile, and
# workspace_modules directory containing only production dependencies required
# by this application.
RUN npx nx run auth:prune

FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

LABEL com.pixaeron.service="auth"

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

# Install from Nx's pruned output instead of installing the whole monorepo.
COPY --from=builder /workspace/dist/apps/auth/package.json ./package.json
COPY --from=builder /workspace/dist/apps/auth/package-lock.json ./package-lock.json
COPY --from=builder /workspace/dist/apps/auth/workspace_modules ./workspace_modules

RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

COPY --from=builder --chown=node:node /workspace/dist/apps/auth/ ./
COPY --from=builder --chown=node:node /workspace/apps/auth/prisma ./apps/auth/prisma
COPY --from=builder --chown=node:node /workspace/apps/auth/prisma.config.ts ./apps/auth/prisma.config.ts

EXPOSE 3000

USER node

CMD ["node", "main.js"]
