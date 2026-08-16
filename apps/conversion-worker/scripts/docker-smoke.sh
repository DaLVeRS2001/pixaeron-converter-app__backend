#!/usr/bin/env bash
set -euo pipefail

if [[ "${OSTYPE:-}" == msys* ]]; then
  export MSYS_NO_PATHCONV=1
fi

IMAGE_NAME="${1:-pixaeron-ci:conversion-worker}"
PREFIX="pixaeron-conversion-worker-smoke-${GITHUB_RUN_ID:-local}-$$"
WORKER_CONTAINER="${PREFIX}-service"
EGRESS_NETWORK="${PREFIX}-egress"

cleanup() {
  docker rm -f "$WORKER_CONTAINER" > /dev/null 2>&1 || true
  docker network rm "$EGRESS_NETWORK" > /dev/null 2>&1 || true
}
trap cleanup EXIT

start_worker() {
  docker run -d --name "$WORKER_CONTAINER" \
    --network "$EGRESS_NETWORK" \
    --read-only --tmpfs /tmp:mode=1777,size=64m \
    --env NODE_ENV=production \
    --env AWS_REGION=eu-central-1 \
    --env AWS_ACCOUNT_ID=000000000000 \
    --env AWS_ACCESS_KEY_ID=AKIAEXAMPLEEXAMPLE \
    --env AWS_SECRET_ACCESS_KEY=example-secret-access-key-that-is-40-characters \
    --env CONVERSION_S3_BUCKET=pixaeron-conversion-smoke \
    --env SQS_QUEUE_SUFFIX=-smoke \
    --env WORKER_MAX_INPUT_BYTES=26214400 \
    --env WORKER_MAX_PIXELS=50000000 \
    --env WORKER_PROGRESS_FILE=/tmp/pixaeron-worker-progress \
    "$@" \
    "$IMAGE_NAME" > /dev/null
}

wait_for_log() {
  local pattern="$1"
  for _ in {1..30}; do
    if docker logs "$WORKER_CONTAINER" 2>&1 | grep -q "$pattern"; then
      return
    fi
    sleep 1
  done

  echo "Worker never logged: $pattern" >&2
  docker logs "$WORKER_CONTAINER" 2>&1 | tail -30 >&2
  exit 1
}

docker network create "$EGRESS_NETWORK" > /dev/null

start_worker
wait_for_log 'consuming the request queues'

docker exec "$WORKER_CONTAINER" node -e "
  const sharp = require('sharp');
  const source = { create: { width: 32, height: 32, channels: 3, background: '#4488cc' } };
  Promise.all(
    ['jpeg', 'png', 'webp', 'avif'].map(async (format) => {
      const encoded = await sharp(source)[format]().toBuffer();
      const decoded = await sharp(encoded).metadata();
      if (decoded.width !== 32) throw new Error(format + ' did not round-trip');
      return format;
    }),
  )
    .then((formats) => {
      console.log('sharp ' + sharp.versions.sharp + ' encodes ' + formats.join(', '));
    })
    .catch((error) => {
      console.error('Image codec check failed: ' + error.message);
      process.exit(1);
    });
"

wait_for_log 'Queue poll failed'

if docker exec "$WORKER_CONTAINER" test -e /tmp/pixaeron-worker-progress; then
  echo 'Worker reported progress while its queues were unreachable.' >&2
  exit 1
fi

if docker exec "$WORKER_CONTAINER" id -u | grep -qx 0; then
  echo 'Worker container must not run as root.' >&2
  exit 1
fi

docker rm -f "$WORKER_CONTAINER" > /dev/null

start_worker --env WORKER_MAX_PIXELS=1
for _ in {1..30}; do
  [[ "$(docker inspect --format '{{.State.Running}}' "$WORKER_CONTAINER")" == false ]] && break
  sleep 1
done
if [[ "$(docker inspect --format '{{.State.ExitCode}}' "$WORKER_CONTAINER")" == 0 ]]; then
  echo 'Worker must refuse to start with an out-of-range configuration.' >&2
  exit 1
fi
docker logs "$WORKER_CONTAINER" 2>&1 | grep -q 'WORKER_MAX_PIXELS' || {
  echo 'Startup failure must name the invalid variable.' >&2
  docker logs "$WORKER_CONTAINER" 2>&1 | tail -20 >&2
  exit 1
}

echo 'Conversion worker image smoke test passed.'
