#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_NAME="static-site-showcase"
readonly DEFAULT_IMAGE_REPOSITORY="docker.io/epiphany131/static-site-showcase"
readonly IMAGE_REPOSITORY="${STATIC_SHOWCASE_IMAGE_REPOSITORY:-$DEFAULT_IMAGE_REPOSITORY}"
readonly DEFAULT_VERSION="1.0.0"
readonly DEFAULT_INSTALL_DIR="/opt/static-site-showcase"
readonly DEFAULT_HTTP_PORT="3000"
readonly GITHUB_RAW_BASE="https://raw.githubusercontent.com/epiphany131/static-site-showcase"
readonly SKIP_PULL="${STATIC_SHOWCASE_SKIP_PULL:-false}"
readonly ASSET_NAMES=(docker-compose.yml docker-compose.production.yml Caddyfile deploy.sh)

COMMAND="${1:-install}"
if [[ "$COMMAND" == '--help' || "$COMMAND" == '-h' ]]; then
  COMMAND='help'
fi
if [[ $# -gt 0 ]]; then shift; fi

INSTALL_DIR="${STATIC_SHOWCASE_DIR:-$DEFAULT_INSTALL_DIR}"
VERSION="$DEFAULT_VERSION"
MODE=""
DOMAIN=""
EMAIL=""
HTTP_PORT="$DEFAULT_HTTP_PORT"
HTTP_BIND="127.0.0.1"
PUBLIC_HTTP=false
ASSUME_YES=false
LOCK_HELD=false

log() { printf '[%s] %s\n' "$APP_NAME" "$*"; }
warn() { printf '[%s] WARNING: %s\n' "$APP_NAME" "$*" >&2; }
die() { printf '[%s] ERROR: %s\n' "$APP_NAME" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Static Site Showcase deployment helper

Usage:
  deploy.sh install [options]
  deploy.sh upgrade --version VERSION [options]
  deploy.sh backup [--dir PATH]
  deploy.sh status [--dir PATH]
  deploy.sh logs [--dir PATH]

Install options:
  --mode http|https       Deployment mode
  --public-http           Bind HTTP to 0.0.0.0 instead of 127.0.0.1
  --port PORT             Host HTTP port (default: 3000)
  --domain DOMAIN         HTTPS domain without scheme, path, or port
  --email EMAIL           ACME contact email for HTTPS
  --version VERSION       Docker image version (default: 1.0.0)
  --dir PATH              Installation directory (default: /opt/static-site-showcase)
  --yes                   Accept non-sensitive defaults without prompting
  -h, --help              Show this help

Examples:
  deploy.sh install --mode http
  deploy.sh install --mode http --public-http
  deploy.sh install --mode https --domain showcase.example.com --email admin@example.com
  deploy.sh upgrade --version 1.1.0
  deploy.sh backup
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) [[ $# -ge 2 ]] || die '--mode requires a value'; MODE="$2"; shift 2 ;;
    --domain) [[ $# -ge 2 ]] || die '--domain requires a value'; DOMAIN="$2"; shift 2 ;;
    --email) [[ $# -ge 2 ]] || die '--email requires a value'; EMAIL="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || die '--version requires a value'; VERSION="${2#v}"; shift 2 ;;
    --dir) [[ $# -ge 2 ]] || die '--dir requires a value'; INSTALL_DIR="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || die '--port requires a value'; HTTP_PORT="$2"; shift 2 ;;
    --public-http) PUBLIC_HTTP=true; HTTP_BIND="0.0.0.0"; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

readonly ENV_FILE="$INSTALL_DIR/.env"

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

validate_version() {
  [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$ ]] ||
    die 'Version must be a semantic version such as 1.0.0 or 1.0.0-rc.1'
}

validate_domain() {
  [[ -n "$DOMAIN" && ${#DOMAIN} -le 253 ]] || die 'A valid domain is required for HTTPS mode'
  [[ "$DOMAIN" != *$'\n'* && "$DOMAIN" != *$'\r'* ]] || die 'Domain contains a newline'
  [[ "$DOMAIN" != *://* && "$DOMAIN" != */* && "$DOMAIN" != *:* ]] ||
    die 'Domain must not include a scheme, path, wildcard, or port'
  [[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] ||
    die 'Domain format is invalid'
}

validate_email() {
  [[ -n "$EMAIL" && ${#EMAIL} -le 254 ]] || die 'A valid ACME email is required for HTTPS mode'
  [[ "$EMAIL" != *$'\n'* && "$EMAIL" != *$'\r'* ]] || die 'Email contains a newline'
  [[ "$EMAIL" =~ ^[A-Za-z0-9.!#$%\&\'\'*+/=?^_\`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] ||
    die 'Email format is invalid'
}

validate_port() {
  [[ "$HTTP_PORT" =~ ^[0-9]+$ ]] || die 'HTTP port must be numeric'
  (( HTTP_PORT >= 1 && HTTP_PORT <= 65535 )) || die 'HTTP port must be between 1 and 65535'
}

preflight() {
  [[ "$(uname -s)" == 'Linux' ]] || die 'This deployment script currently supports Linux only'
  require_command docker
  require_command curl
  require_command tar
  require_command sha256sum
  require_command od
  require_command awk
  docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 is required'
  docker info >/dev/null 2>&1 || die 'The current user cannot access the Docker daemon'
  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "Unsupported CPU architecture: $(uname -m)" ;;
  esac
  validate_version
  validate_port
}

check_disk_space() {
  local path="$1" available
  available="$(df -Pk "$path" | awk 'NR == 2 { print $4 }')"
  [[ "$available" =~ ^[0-9]+$ ]] || die "Could not determine free disk space at $path"
  (( available >= 524288 )) || die 'At least 512 MiB of free disk space is required'
}

acquire_operation_lock() {
  [[ "$LOCK_HELD" == false ]] || return 0
  require_command flock
  exec 9>"$INSTALL_DIR/.deploy.lock"
  flock -n 9 || die "Another deployment operation is already running for $INSTALL_DIR"
  LOCK_HELD=true
}

env_value_from() {
  local file="$1" key="$2" line
  [[ -f "$file" ]] || return 1
  line="$(grep -E "^${key}=" "$file" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 1
  printf '%s\n' "${line#*=}"
}

env_value() {
  env_value_from "$ENV_FILE" "$1"
}

set_env_value_in() {
  local file="$1" key="$2" value="$3" temporary
  temporary="${file}.tmp.$$"
  umask 077
  if [[ -f "$file" ]]; then
    grep -v -E "^${key}=" "$file" > "$temporary" || true
  else
    : > "$temporary"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$file"
}

set_env_value() {
  set_env_value_in "$ENV_FILE" "$1" "$2"
}

compose_file() {
  local mode="${1:-$(env_value DEPLOY_MODE)}"
  if [[ "$mode" == 'https' ]]; then
    printf '%s/docker-compose.production.yml\n' "$INSTALL_DIR"
  else
    printf '%s/docker-compose.yml\n' "$INSTALL_DIR"
  fi
}

compose() {
  local file
  file="$(compose_file)"
  docker compose --project-name "$APP_NAME" --project-directory "$INSTALL_DIR" \
    --env-file "$ENV_FILE" -f "$file" "$@"
}

generate_password() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

source_base() {
  if [[ -n "${STATIC_SHOWCASE_SOURCE_BASE:-}" ]]; then
    printf '%s\n' "${STATIC_SHOWCASE_SOURCE_BASE%/}"
  else
    printf '%s/v%s\n' "$GITHUB_RAW_BASE" "$VERSION"
  fi
}

download_file() {
  local name="$1" target="$2" temporary base
  base="$(source_base)"
  temporary="${target}.tmp.$$"
  curl --fail --silent --show-error --location --retry 3 --connect-timeout 15 \
    "$base/$name" --output "$temporary"
  [[ -s "$temporary" ]] || { rm -f "$temporary"; die "Downloaded file is empty: $name"; }
  chmod 644 "$temporary"
  mv -f "$temporary" "$target"
}

download_release_assets() {
  local target="$1" name
  mkdir -p "$target"
  download_file deploy-assets.sha256 "$target/deploy-assets.sha256"
  for name in "${ASSET_NAMES[@]}"; do
    download_file "$name" "$target/$name"
  done
  if ! (cd "$target" && sha256sum --strict --check deploy-assets.sha256); then
    die 'Deployment asset checksum verification failed'
  fi
  bash -n "$target/deploy.sh"
  chmod 755 "$target/deploy.sh"
}

validate_release_assets() {
  local target="$1" env_file="$2" mode="$3" file
  if [[ "$mode" == 'https' ]]; then
    file="$target/docker-compose.production.yml"
  else
    file="$target/docker-compose.yml"
  fi
  docker compose --project-name "${APP_NAME}-validation" --project-directory "$INSTALL_DIR" \
    --env-file "$env_file" -f "$file" config --quiet
}

install_release_assets() {
  local source="$1" name temporary mode
  for name in deploy-assets.sha256 "${ASSET_NAMES[@]}"; do
    temporary="$INSTALL_DIR/.${name}.new.$$"
    cp "$source/$name" "$temporary"
    mode=644
    [[ "$name" == 'deploy.sh' ]] && mode=755
    chmod "$mode" "$temporary"
    mv -f "$temporary" "$INSTALL_DIR/$name"
  done
}

check_port_available() {
  local protocol="$1" port="$2"
  if ! command -v ss >/dev/null 2>&1; then
    warn "The ss command is unavailable; ${protocol^^} port $port availability was not checked"
    return 0
  fi
  if [[ "$protocol" == 'tcp' ]]; then
    if ss -ltnH "sport = :$port" | grep -q .; then
      die "TCP port $port is already in use"
    fi
  elif ss -lunH "sport = :$port" | grep -q .; then
    die "UDP port $port is already in use"
  fi
}

check_install_ports() {
  if [[ "$MODE" == 'https' ]]; then
    check_port_available tcp 80
    check_port_available tcp 443
    check_port_available udp 443
  else
    check_port_available tcp "$HTTP_PORT"
  fi
}

wait_for_health() {
  local timeout="${1:-180}" elapsed=0 container status
  while (( elapsed < timeout )); do
    container="$(compose ps -q static-host 2>/dev/null || true)"
    if [[ -n "$container" ]]; then
      status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)"
      case "$status" in
        healthy) return 0 ;;
        exited|dead|unhealthy) return 1 ;;
      esac
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

wait_for_service_running() {
  local service="$1" timeout="${2:-90}" elapsed=0 container status
  while (( elapsed < timeout )); do
    container="$(compose ps -q "$service" 2>/dev/null || true)"
    if [[ -n "$container" ]]; then
      status="$(docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
      [[ "$status" == 'running' ]] && return 0
      [[ "$status" == 'exited' || "$status" == 'dead' ]] && return 1
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  return 1
}

wait_for_https() {
  local elapsed=0
  while (( elapsed < 180 )); do
    if curl --fail --silent --show-error --max-time 10 "https://$DOMAIN/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  return 1
}

ensure_installed() {
  [[ -f "$ENV_FILE" ]] || die "No installation found at $INSTALL_DIR"
  [[ -f "$(compose_file)" ]] || die "Deployment files are missing from $INSTALL_DIR"
}

write_initial_env() {
  local target="$1" password="$2"
  umask 077
  cat > "$target" <<EOF
COMPOSE_PROJECT_NAME=$APP_NAME
STATIC_HOST_IMAGE=$IMAGE_REPOSITORY
IMAGE_TAG=$VERSION
DEPLOY_MODE=$MODE
ADMIN_USERNAME=admin
ADMIN_PASSWORD=$password
MAX_FILE_SIZE=52428800
HTTP_BIND=$HTTP_BIND
HTTP_PORT=$HTTP_PORT
PLATFORM_ORIGIN=$DOMAIN
ACME_EMAIL=$EMAIL
EOF
  chmod 600 "$target"
}

install_app() (
  preflight
  [[ ! -e "$ENV_FILE" ]] || die "An installation already exists at $INSTALL_DIR; use upgrade instead"

  if [[ -z "$MODE" ]]; then
    if [[ "$ASSUME_YES" == true || ! -t 0 ]]; then
      MODE='http'
    else
      read -r -p 'Deployment mode [http/https] (default: http): ' MODE
      MODE="${MODE:-http}"
    fi
  fi
  [[ "$MODE" == 'http' || "$MODE" == 'https' ]] || die 'Mode must be http or https'
  if [[ "$MODE" == 'https' ]]; then
    validate_domain
    validate_email
  elif [[ "$PUBLIC_HTTP" == true ]]; then
    warn 'Public HTTP sends login credentials without transport encryption. Prefer HTTPS.'
  fi
  check_install_ports

  local parent password stage https_verified=true
  parent="$(dirname "$INSTALL_DIR")"
  mkdir -p "$parent"
  [[ -w "$parent" ]] || die "Installation parent is not writable: $parent"
  check_disk_space "$parent"
  mkdir -p "$INSTALL_DIR"/{database,sites,uploads,backups}
  chmod 700 "$INSTALL_DIR" "$INSTALL_DIR/backups"
  acquire_operation_lock
  [[ ! -e "$ENV_FILE" ]] || die "An installation already exists at $INSTALL_DIR; use upgrade instead"

  stage="$(mktemp -d "$INSTALL_DIR/.install.XXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  download_release_assets "$stage"
  password="$(generate_password)"
  [[ ${#password} -eq 64 ]] || die 'Failed to generate a strong administrator password'
  write_initial_env "$stage/.env" "$password"
  validate_release_assets "$stage" "$stage/.env" "$MODE"
  install_release_assets "$stage"
  mv -f "$stage/.env" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  if [[ "$SKIP_PULL" != true ]]; then compose pull; fi
  if ! compose up -d --no-build --remove-orphans || ! wait_for_health 180; then
    compose logs --tail=100 >&2 || true
    compose down --remove-orphans >/dev/null 2>&1 || true
    die 'Application failed its health check; deployment files and persistent data were preserved'
  fi
  if [[ "$MODE" == 'https' ]]; then
    wait_for_service_running caddy 90 || { compose logs --tail=100 caddy >&2 || true; die 'Caddy failed to start'; }
    if ! wait_for_https; then
      https_verified=false
      warn 'The local services are healthy, but public HTTPS was not reachable; check DNS and firewall settings'
    fi
  fi

  trap - EXIT INT TERM HUP
  rm -rf "$stage"
  printf '\nInstallation completed.\n'
  if [[ "$MODE" == 'https' ]]; then
    printf 'URL: https://%s/\n' "$DOMAIN"
    [[ "$https_verified" == true ]] || printf 'Public HTTPS reachability was not verified from this server.\n'
  elif [[ "$PUBLIC_HTTP" == true ]]; then
    printf 'URL: http://<server-ip>:%s/\n' "$HTTP_PORT"
  else
    printf 'URL: http://127.0.0.1:%s/\n' "$HTTP_PORT"
    printf 'For remote access, use an SSH tunnel or a trusted reverse proxy.\n'
  fi
  printf 'Administrator: admin\n'
  printf 'Initial password (shown once): %s\n' "$password"
  printf 'Credentials and deployment settings: %s\n' "$ENV_FILE"
  printf 'Change the password from Account Settings after first login.\n'
)

backup_app_locked() (
  local stamp archive temporary checksum temporary_checksum was_running=false
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  archive="$INSTALL_DIR/backups/${APP_NAME}-${stamp}-$$.tar.gz"
  temporary="${archive}.tmp"
  checksum="${archive}.sha256"
  temporary_checksum="${checksum}.tmp"
  mkdir -p "$INSTALL_DIR/backups"
  chmod 700 "$INSTALL_DIR/backups"

  # shellcheck disable=SC2329 # Invoked by the EXIT trap below.
  backup_cleanup() {
    local result=$?
    trap - EXIT INT TERM HUP
    rm -f "$temporary" "$temporary_checksum"
    if [[ "$was_running" == true ]]; then
      warn 'Restarting services after an interrupted or failed backup'
      if ! compose up -d --no-build >/dev/null 2>&1 || ! wait_for_health 180; then
        warn 'Services could not be restored after the backup interruption'
        result=1
      fi
    fi
    exit "$result"
  }
  trap backup_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  if [[ -n "$(compose ps --status running -q 2>/dev/null || true)" ]]; then
    was_running=true
    log 'Stopping services briefly for a consistent SQLite backup'
    compose stop
  fi
  tar -C "$INSTALL_DIR" -czf "$temporary" .env database sites uploads
  chmod 600 "$temporary"
  local digest
  read -r digest _ < <(sha256sum "$temporary")
  printf '%s  %s\n' "$digest" "$(basename "$archive")" > "$temporary_checksum"
  chmod 600 "$temporary_checksum"
  mv -f "$temporary" "$archive"
  mv -f "$temporary_checksum" "$checksum"

  if [[ "$was_running" == true ]]; then
    compose up -d --no-build >/dev/null
    wait_for_health 180 || die 'Backup completed, but the application did not become healthy after restart'
    was_running=false
  fi
  trap - EXIT INT TERM HUP
  log "Backup created: $archive"
)

backup_app() {
  preflight
  ensure_installed
  acquire_operation_lock
  backup_app_locked
}

upgrade_app() (
  preflight
  ensure_installed
  acquire_operation_lock

  local old_version mode repository stage rollback_dir validation_env rollback_needed=false restored=false
  old_version="$(env_value IMAGE_TAG)"
  mode="$(env_value DEPLOY_MODE)"
  repository="$(env_value STATIC_HOST_IMAGE)"
  [[ -n "$repository" ]] || die 'STATIC_HOST_IMAGE is missing from the installation environment'
  [[ "$VERSION" != "$old_version" ]] || { log "Already running version $VERSION"; return 0; }

  log "Preparing $repository:$VERSION"
  if [[ "$SKIP_PULL" != true ]]; then docker pull "$repository:$VERSION"; fi
  docker image inspect "$repository:$VERSION" >/dev/null
  docker image inspect "$repository:$old_version" >/dev/null || die "The rollback image is unavailable: $repository:$old_version"

  stage="$(mktemp -d "$INSTALL_DIR/.upgrade.XXXXXX")"
  rollback_dir="$(mktemp -d "$INSTALL_DIR/.rollback.XXXXXX")"
  validation_env="$stage/.env"

  # shellcheck disable=SC2329 # Invoked by upgrade_cleanup.
  restore_previous() {
    local item
    [[ "$restored" == false ]] || return 0
    restored=true
    warn "Restoring version $old_version"
    for item in deploy-assets.sha256 "${ASSET_NAMES[@]}"; do
      cp "$rollback_dir/$item" "$INSTALL_DIR/$item" || return 1
    done
    chmod 755 "$INSTALL_DIR/deploy.sh" || return 1
    set_env_value IMAGE_TAG "$old_version" || return 1
    compose up -d --no-build --remove-orphans >/dev/null 2>&1 || return 1
    wait_for_health 180 || return 1
    if [[ "$mode" == 'https' ]]; then
      wait_for_service_running caddy 90 || return 1
    fi
  }

  # shellcheck disable=SC2329 # Invoked by the EXIT trap below.
  upgrade_cleanup() {
    local result=$?
    trap - EXIT INT TERM HUP
    if [[ "$rollback_needed" == true ]]; then
      if restore_previous; then
        warn "Rollback completed: $old_version is healthy"
        rm -rf "$rollback_dir"
      else
        warn "ROLLBACK FAILED. Recovery files were preserved at $rollback_dir"
        result=1
      fi
    else
      rm -rf "$rollback_dir"
    fi
    rm -rf "$stage"
    exit "$result"
  }
  trap upgrade_cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  download_release_assets "$stage"
  cp "$ENV_FILE" "$validation_env"
  set_env_value_in "$validation_env" IMAGE_TAG "$VERSION"
  validate_release_assets "$stage" "$validation_env" "$mode"
  backup_app_locked

  cp "$INSTALL_DIR/deploy-assets.sha256" "$rollback_dir/deploy-assets.sha256"
  local name
  for name in "${ASSET_NAMES[@]}"; do
    cp "$INSTALL_DIR/$name" "$rollback_dir/$name"
  done

  rollback_needed=true
  install_release_assets "$stage"
  set_env_value IMAGE_TAG "$VERSION"
  if ! compose config --quiet || ! compose up -d --no-build --remove-orphans || ! wait_for_health 180; then
    die 'Upgrade failed while starting the new application image'
  fi
  if [[ "$mode" == 'https' ]]; then
    wait_for_service_running caddy 90 || die 'Upgrade failed because Caddy did not start'
    DOMAIN="$(env_value PLATFORM_ORIGIN)"
    if ! wait_for_https; then
      warn 'Upgrade is healthy locally, but public HTTPS could not be verified; no rollback was performed'
    fi
  fi

  rollback_needed=false
  trap - EXIT INT TERM HUP
  rm -rf "$stage" "$rollback_dir"
  log "Upgrade completed: $old_version -> $VERSION"
)

status_app() {
  preflight
  ensure_installed
  compose ps
}

logs_app() {
  preflight
  ensure_installed
  compose logs --tail=200 -f
}

case "$COMMAND" in
  install) install_app ;;
  upgrade) upgrade_app ;;
  backup) backup_app ;;
  status) status_app ;;
  logs) logs_app ;;
  help) usage ;;
  *) usage >&2; die "Unknown command: $COMMAND" ;;
esac
