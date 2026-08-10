#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" == msys* ]]; then
  export MSYS_NO_PATHCONV=1
fi

IMAGE_NAME="${1:-pixaeron-ci:notifications}"
PREFIX="pixaeron-notifications-smoke-${GITHUB_RUN_ID:-local}-$$"
DATABASE_CONTAINER="${PREFIX}-postgres"
NOTIFICATIONS_CONTAINER="${PREFIX}-service"
BAD_DATABASE_CONTAINER="${PREFIX}-bad-database"
DATA_NETWORK="${PREFIX}-data"
COMMAND_NETWORK="${PREFIX}-command"
EGRESS_NETWORK="${PREFIX}-egress"
PROBE_SCRIPT="$PWD/apps/notifications/scripts/grpc-probe.cjs"
PROTO_PATH="/app/proto/pixaeron/notifications/v1/notifications.proto"

cleanup() {
  docker rm -f "$BAD_DATABASE_CONTAINER" "$NOTIFICATIONS_CONTAINER" \
    "$DATABASE_CONTAINER" > /dev/null 2>&1 || true
  docker network rm "$COMMAND_NETWORK" "$DATA_NETWORK" "$EGRESS_NETWORK" \
    > /dev/null 2>&1 || true
}
trap cleanup EXIT

create_networks() {
  docker network create --internal "$DATA_NETWORK" > /dev/null
  docker network create --internal "$COMMAND_NETWORK" > /dev/null
  docker network create "$EGRESS_NETWORK" > /dev/null
}

wait_for_postgres() {
  for _ in {1..30}; do
    if docker exec "$DATABASE_CONTAINER" pg_isready \
      --username notifications --dbname pixaeron_notifications > /dev/null 2>&1; then
      return
    fi
    sleep 1
  done

  echo 'Notifications smoke database did not become ready.' >&2
  exit 1
}

notifications_environment() {
  printf '%s\n' \
    '--env' 'NODE_ENV=test' \
    '--env' 'PORT=3004' \
    '--env' "DATABASE_URL=$1" \
    '--env' "NOTIFICATIONS_GRPC_HOST=$2" \
    '--env' 'NOTIFICATIONS_GRPC_PORT=50052' \
    '--env' 'RECIPIENT_HMAC_KEYRING_JSON={"1":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="}' \
    '--env' 'RECIPIENT_HMAC_ACTIVE_KEY_VERSION=1' \
    '--env' 'AWS_REGION=eu-central-1' \
    '--env' 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' \
    '--env' 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' \
    '--env' 'SES_FROM_EMAIL=Pixaeron <no-reply@pixaeron.com>' \
    '--env' 'SES_CONFIGURATION_SET=pixaeron-smoke' \
    '--env' 'SES_REQUEST_TIMEOUT_MS=500' \
    '--env' 'FRONTEND_URL=http://localhost:3000' \
    '--env' 'SES_FEEDBACK_CONSUMER_ENABLED=false' \
    '--env' 'SES_FEEDBACK_QUEUE_URL=https://sqs.eu-central-1.amazonaws.com/123456789012/pixaeron-smoke' \
    '--env' 'SES_FEEDBACK_TOPIC_ARN=arn:aws:sns:eu-central-1:123456789012:pixaeron-smoke' \
    '--env' 'SES_EXPECTED_ACCOUNT_ID=123456789012' \
    '--env' 'SES_EXPECTED_SOURCE_ARN=arn:aws:ses:eu-central-1:123456789012:identity/pixaeron.com'
}

create_notifications_container() {
  local name="$1"
  local database_url="$2"
  local grpc_alias="$3"
  mapfile -t environment < <(notifications_environment "$database_url" "$grpc_alias")

  docker create --name "$name" --network "$DATA_NETWORK" \
    "${environment[@]}" "$IMAGE_NAME" > /dev/null
  docker network connect --alias "$grpc_alias" "$COMMAND_NETWORK" "$name"
  docker network connect "$EGRESS_NETWORK" "$name"
}

wait_for_notifications() {
  for _ in {1..30}; do
    if docker exec "$NOTIFICATIONS_CONTAINER" node -e \
      "fetch('http://127.0.0.1:3004/notifications/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
      return
    fi
    sleep 1
  done

  docker logs "$NOTIFICATIONS_CONTAINER" >&2
  echo 'Notifications did not become ready.' >&2
  exit 1
}

assert_bad_database_exits() {
  for _ in {1..20}; do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$BAD_DATABASE_CONTAINER")" == 'false' ]]; then
      local exit_code
      exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$BAD_DATABASE_CONTAINER")"
      [[ "$exit_code" != '0' ]] && return
      echo 'Notifications exited successfully despite an unavailable database.' >&2
      exit 1
    fi
    sleep 1
  done

  docker logs "$BAD_DATABASE_CONTAINER" >&2
  echo 'Notifications stayed running with an unavailable database.' >&2
  exit 1
}

cleanup
create_networks

docker run --detach --name "$DATABASE_CONTAINER" --network "$DATA_NETWORK" \
  --network-alias notifications-postgres \
  --env POSTGRES_USER=notifications \
  --env POSTGRES_PASSWORD=notifications \
  --env POSTGRES_DB=pixaeron_notifications \
  postgres:18 > /dev/null
wait_for_postgres

DATABASE_URL='postgresql://notifications:notifications@notifications-postgres:5432/pixaeron_notifications?schema=public'
docker run --rm --network "$DATA_NETWORK" --env "DATABASE_URL=$DATABASE_URL" \
  "$IMAGE_NAME" ./node_modules/.bin/prisma migrate deploy \
  --config apps/notifications/prisma.config.ts

create_notifications_container \
  "$NOTIFICATIONS_CONTAINER" "$DATABASE_URL" 'notifications-command'
docker start "$NOTIFICATIONS_CONTAINER" > /dev/null
wait_for_notifications

docker run --rm --network "$COMMAND_NETWORK" \
  --volume "$PROBE_SCRIPT:/app/grpc-probe.cjs:ro" \
  "$IMAGE_NAME" node /app/grpc-probe.cjs invalid-command \
  notifications-command:50052 "$PROTO_PATH"

docker run --rm --network "$EGRESS_NETWORK" \
  --volume "$PROBE_SCRIPT:/app/grpc-probe.cjs:ro" \
  "$IMAGE_NAME" node /app/grpc-probe.cjs unreachable \
  notifications-command:50052 "$PROTO_PATH"

BAD_DATABASE_URL='postgresql://notifications:wrong-password@notifications-postgres:5432/pixaeron_notifications?schema=public'
create_notifications_container \
  "$BAD_DATABASE_CONTAINER" "$BAD_DATABASE_URL" 'bad-notifications'
docker start "$BAD_DATABASE_CONTAINER" > /dev/null
assert_bad_database_exits

echo 'Notifications Docker, database startup, gRPC wire, and network isolation smoke checks passed.'
