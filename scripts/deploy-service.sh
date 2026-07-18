#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -ne 5 ]]; then
  echo 'Usage: deploy-service.sh <service> <image-tag-env> <image-tag> <runtime-env-file-env> <migration-command>' >&2
  exit 2
fi

compose_service="$1"
image_tag_env="$2"
image_tag="$3"
runtime_env_file_env="$4"
migration_command="$5"

deployment_dir=/opt/pixaeron
compose_file="$deployment_dir/docker-compose.production.yaml"
deployment_env="$deployment_dir/deployment.env"
runtime_env="$deployment_dir/${compose_service}.env"

incoming_compose="${compose_file}.next"
incoming_runtime_env="${runtime_env}.next"
compose_backup="${compose_file}.rollback"
deployment_env_backup="${deployment_env}.rollback"
runtime_env_backup="${runtime_env}.rollback"

[[ -f "$incoming_compose" ]] || { echo "Missing $incoming_compose" >&2; exit 1; }
[[ -f "$incoming_runtime_env" ]] || { echo "Missing $incoming_runtime_env" >&2; exit 1; }

cd "$deployment_dir"

had_compose=false
had_deployment_env=false
had_runtime_env=false
had_previous_image=false

if [[ -f "$compose_file" ]]; then
  cp -p "$compose_file" "$compose_backup"
  had_compose=true
fi

if [[ -f "$deployment_env" ]]; then
  cp -p "$deployment_env" "$deployment_env_backup"
  had_deployment_env=true

  if grep -qE "^${image_tag_env}=" "$deployment_env"; then
    had_previous_image=true
  fi
else
  touch "$deployment_env"
fi

if [[ -f "$runtime_env" ]]; then
  cp -p "$runtime_env" "$runtime_env_backup"
  had_runtime_env=true
fi

rollback() {
  exit_code=$?
  trap - ERR
  set +e

  docker compose --env-file "$deployment_env" -f "$compose_file" \
    logs --tail=100 "$compose_service"

  if $had_compose; then
    mv -f "$compose_backup" "$compose_file"
  else
    rm -f "$compose_file"
  fi

  if $had_deployment_env; then
    mv -f "$deployment_env_backup" "$deployment_env"
  else
    rm -f "$deployment_env"
  fi

  if $had_runtime_env; then
    mv -f "$runtime_env_backup" "$runtime_env"
  else
    rm -f "$runtime_env"
  fi

  if $had_compose && $had_deployment_env && $had_previous_image; then
    docker compose --env-file "$deployment_env" -f "$compose_file" \
      up -d --no-deps --wait --wait-timeout 90 "$compose_service"
  fi

  rm -f "$incoming_compose" "$incoming_runtime_env"
  exit "$exit_code"
}

# Backups are complete before rollback is enabled, so a backup failure leaves
# the live deployment files untouched.
trap rollback ERR

mv -f "$incoming_compose" "$compose_file"
mv -f "$incoming_runtime_env" "$runtime_env"
chmod 600 "$runtime_env" "$deployment_env"

upsert_env_value() {
  key="$1"
  value="$2"

  if grep -qE "^${key}=" "$deployment_env"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$deployment_env"
  else
    printf '%s=%s\n' "$key" "$value" >> "$deployment_env"
  fi
}

upsert_env_value PIXAERON_CERTS_DIR /opt/pixaeron/certs
upsert_env_value "$runtime_env_file_env" "$runtime_env"
upsert_env_value "$image_tag_env" "$image_tag"

docker compose --env-file "$deployment_env" -f "$compose_file" \
  config --quiet "$compose_service"
docker compose --env-file "$deployment_env" -f "$compose_file" pull "$compose_service"

if [[ -n "$migration_command" && "$migration_command" != 'null' ]]; then
  # Database migrations must remain backward-compatible: rollback restores the
  # previous application image, but intentionally does not mutate database history.
  docker compose --env-file "$deployment_env" -f "$compose_file" \
    run --rm --no-deps "$compose_service" sh -lc "$migration_command"
fi

docker compose --env-file "$deployment_env" -f "$compose_file" \
  up -d --no-deps --wait --wait-timeout 90 "$compose_service"

trap - ERR

# Remove unused service images older than seven days. The running image is not
# eligible for pruning, and a cleanup failure does not fail a healthy deployment.
if ! docker image prune -af \
  --filter "label=com.pixaeron.service=$compose_service" \
  --filter 'until=168h' > /dev/null; then
  echo "Could not prune old $compose_service images; continuing." >&2
fi

rm -f "$compose_backup" "$deployment_env_backup" "$runtime_env_backup"
