# syntax=docker/dockerfile:1.7

FROM ghcr.io/apollographql/rover:0.41.0@sha256:ae42a40236050a5a410e7e4fd934ba5f851a6783666ff2f1e065ee5de6c2033d AS composer

WORKDIR /workspace

COPY apps/gateway/supergraph.yaml ./apps/gateway/supergraph.yaml
COPY apps/auth/schema.graphql ./apps/auth/schema.graphql
COPY apps/conversion-api/schema.graphql ./apps/conversion-api/schema.graphql

RUN rover supergraph compose \
  --skip-update-check \
  --elv2-license accept \
  --config apps/gateway/supergraph.yaml \
  --output /tmp/supergraph.graphql

FROM ghcr.io/apollographql/router:v2.17.0@sha256:b4e70cbcff5a5c3a8825aa2b201257b57a2052bbe2d7751e74d129ebaa09ffe6

LABEL com.pixaeron.service="gateway"

COPY apps/gateway/router.yaml /dist/config/router.yaml
COPY apps/gateway/rhai/main.rhai /dist/rhai/main.rhai
COPY --from=composer /tmp/supergraph.graphql /dist/schema/supergraph.graphql

RUN JWT_ISSUER=http://localhost:3001/auth \
  JWT_AUDIENCE=pixaeron-api \
  FRONTEND_ORIGIN=http://localhost:3000 \
  /dist/router config validate /dist/config/router.yaml

ENV APOLLO_ROUTER_CONFIG_PATH=/dist/config/router.yaml
ENV APOLLO_ROUTER_SUPERGRAPH_PATH=/dist/schema/supergraph.graphql

EXPOSE 4000 8088
