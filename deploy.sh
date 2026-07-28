#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_NAME="static-site-showcase"
readonly DEFAULT_IMAGE_REPOSITORY="docker.io/epiphany131/static-site-showcase"
readonly IMAGE_REPOSITORY="${STATIC_SHOWCASE_IMAGE_REPOSITORY:-$DEFAULT_IMAGE_REPOSITORY}"
readonly DEFAULT_VERSION="1.2.0"
readonly DEFAULT_INSTALL_DIR="/opt/static-site-showcase"
readonly DEFAULT_HTTP_PORT="3000"
readonly DEFAULT_ADMIN_USERNAME="admin"
readonly DEFAULT_ADMIN_PASSWORD="123456"
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
HTTP_BIND="0.0.0.0"
LOCAL_HTTP=false
ASSUME_YES=false
LOCK_HELD=false
ADMIN_USERNAME=""
ADMIN_PASSWORD=""

log() { printf '[%s] %s\n' "$APP_NAME" "$*"; }
warn() { printf '[%s] 警告：%s\n' "$APP_NAME" "$*" >&2; }
die() { printf '[%s] 错误：%s\n' "$APP_NAME" "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Static Site Showcase 部署工具

用法：
  deploy.sh install [选项]
  deploy.sh upgrade --version 版本 [选项]
  deploy.sh backup [--dir 路径]
  deploy.sh status [--dir 路径]
  deploy.sh logs [--dir 路径]

安装选项：
  --mode http|https       部署模式
  --local-http            HTTP 仅监听 127.0.0.1；默认监听所有地址 0.0.0.0
  --public-http           兼容选项：明确监听所有地址 0.0.0.0
  --port 端口             宿主机 HTTP 端口（默认：3000）
  --admin-username 用户名 初始管理员用户名（默认：admin）
  --admin-password 密码   初始管理员密码（默认：123456）
  --domain 域名           HTTPS 域名，不含协议、路径或端口
  --email 邮箱            HTTPS 证书联系邮箱
  --version 版本          Docker 镜像版本（默认：1.2.0）
  --dir 路径              安装目录（默认：/opt/static-site-showcase）
  --yes                   不提问，接受所有默认值
  -h, --help              显示帮助

默认 HTTP 会监听 0.0.0.0，部署完成后可通过服务器 IP 直接访问。
默认密码 123456 很容易被猜到，请在首次登录后立即修改。

示例：
  deploy.sh install --mode http
  deploy.sh install --mode http --local-http
  deploy.sh install --mode https --domain showcase.example.com --email admin@example.com
  deploy.sh upgrade --version 1.2.0
  deploy.sh backup
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) [[ $# -ge 2 ]] || die '--mode 需要一个值'; MODE="$2"; shift 2 ;;
    --domain) [[ $# -ge 2 ]] || die '--domain 需要一个值'; DOMAIN="$2"; shift 2 ;;
    --email) [[ $# -ge 2 ]] || die '--email 需要一个值'; EMAIL="$2"; shift 2 ;;
    --version) [[ $# -ge 2 ]] || die '--version 需要一个值'; VERSION="${2#v}"; shift 2 ;;
    --dir) [[ $# -ge 2 ]] || die '--dir 需要一个值'; INSTALL_DIR="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || die '--port 需要一个值'; HTTP_PORT="$2"; shift 2 ;;
    --admin-username) [[ $# -ge 2 ]] || die '--admin-username 需要一个值'; ADMIN_USERNAME="$2"; shift 2 ;;
    --admin-password) [[ $# -ge 2 ]] || die '--admin-password 需要一个值'; ADMIN_PASSWORD="$2"; shift 2 ;;
    --local-http) LOCAL_HTTP=true; HTTP_BIND="127.0.0.1"; shift ;;
    --public-http) LOCAL_HTTP=false; HTTP_BIND="0.0.0.0"; shift ;;
    --yes|-y) ASSUME_YES=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) die "未知选项：$1" ;;
  esac
done

readonly ENV_FILE="$INSTALL_DIR/.env"

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "找不到必需命令：$1"
}

validate_version() {
  [[ "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-((0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?$ ]] ||
    die '版本必须是 1.0.0 或 1.0.0-rc.1 这类语义化版本'
}

validate_domain() {
  [[ -n "$DOMAIN" && ${#DOMAIN} -le 253 ]] || die 'HTTPS 模式必须提供有效域名'
  [[ "$DOMAIN" != *$'\n'* && "$DOMAIN" != *$'\r'* ]] || die '域名不能包含换行符'
  [[ "$DOMAIN" != *://* && "$DOMAIN" != */* && "$DOMAIN" != *:* ]] ||
    die '域名不能包含协议、路径、通配符或端口'
  [[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] ||
    die '域名格式无效'
}

validate_email() {
  [[ -n "$EMAIL" && ${#EMAIL} -le 254 ]] || die 'HTTPS 模式必须提供有效的证书联系邮箱'
  [[ "$EMAIL" != *$'\n'* && "$EMAIL" != *$'\r'* ]] || die '邮箱不能包含换行符'
  [[ "$EMAIL" =~ ^[A-Za-z0-9.!#$%\&\'\'*+/=?^_\`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] ||
    die '邮箱格式无效'
}

validate_port() {
  [[ "$HTTP_PORT" =~ ^[0-9]+$ ]] || die 'HTTP 端口必须是数字'
  (( HTTP_PORT >= 1 && HTTP_PORT <= 65535 )) || die 'HTTP 端口必须在 1 到 65535 之间'
}

preflight() {
  [[ "$(uname -s)" == 'Linux' ]] || die '当前部署脚本只支持 Linux'
  require_command docker
  require_command curl
  require_command tar
  require_command sha256sum
  require_command od
  require_command awk
  docker compose version >/dev/null 2>&1 || die '需要 Docker Compose v2'
  docker info >/dev/null 2>&1 || die '当前用户无法访问 Docker 服务'
  case "$(uname -m)" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "不支持的 CPU 架构：$(uname -m)" ;;
  esac
  validate_version
  validate_port
}

check_disk_space() {
  local path="$1" available
  available="$(df -Pk "$path" | awk 'NR == 2 { print $4 }')"
  [[ "$available" =~ ^[0-9]+$ ]] || die "无法确定 $path 的可用磁盘空间"
  (( available >= 524288 )) || die '至少需要 512 MiB 可用磁盘空间'
}

acquire_operation_lock() {
  [[ "$LOCK_HELD" == false ]] || return 0
  require_command flock
  exec 9>"$INSTALL_DIR/.deploy.lock"
  flock -n 9 || die "$INSTALL_DIR 已有另一个部署操作正在运行"
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
  [[ -s "$temporary" ]] || { rm -f "$temporary"; die "下载的文件为空：$name"; }
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
    die '部署文件 SHA-256 校验失败'
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
    warn "找不到 ss 命令，未检查 ${protocol^^} 端口 $port 是否可用"
    return 0
  fi
  if [[ "$protocol" == 'tcp' ]]; then
    if ss -ltnH "sport = :$port" | grep -q .; then
      die "TCP 端口 $port 已被占用"
    fi
  elif ss -lunH "sport = :$port" | grep -q .; then
    die "UDP 端口 $port 已被占用"
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
  [[ -f "$ENV_FILE" ]] || die "在 $INSTALL_DIR 找不到已安装实例"
  [[ -f "$(compose_file)" ]] || die "$INSTALL_DIR 中缺少部署文件"
}

validate_admin_username() {
  [[ -n "$ADMIN_USERNAME" && ${#ADMIN_USERNAME} -le 32 ]] ||
    die '管理员用户名长度必须为 1 到 32 个字符'
  [[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9_-]+$ ]] ||
    die '管理员用户名只能包含字母、数字、连字符和下划线'
}

validate_admin_password() {
  [[ -n "$ADMIN_PASSWORD" ]] || die '管理员密码不能为空'
  [[ ${#ADMIN_PASSWORD} -le 128 ]] || die '管理员密码最多为 128 个字符'
  # 密码会写入由 Compose 解析的环境文件，因此不能包含会触发
  # 注释、引号或变量插值的字符。逐字符过滤可避免字符类解析歧义。
  local residue
  residue="$(printf '%s' "$ADMIN_PASSWORD" | tr -d 'A-Za-z0-9!%&()*+,./:;<=>?@[]^_{|}~-')"
  [[ -z "$residue" ]] ||
    die '管理员密码可使用字母、数字和常见标点，但不能包含空格、引号、$、#、反斜杠或反引号'
  if [[ ${#ADMIN_PASSWORD} -lt 12 ]]; then
    warn '管理员密码较短，很容易被猜到，请登录后立即修改'
    if [[ "$LOCAL_HTTP" != true || "$MODE" == 'https' ]]; then
      warn '当前服务可从其他设备访问，弱密码会暴露在网络中'
    fi
  fi
}

ask() {
  local prompt="$1" secret="${2:-false}" reply
  if [[ "$secret" == true ]]; then
    read -r -s -p "$prompt" reply <>/dev/tty
    printf '\n' >/dev/tty
  else
    read -r -p "$prompt" reply <>/dev/tty
  fi
  # 某些终端或粘贴输入会附加回车符。
  printf '%s' "${reply%$'\r'}"
}

prompt_install_settings() {
  local interactive=false answer
  # 从 /dev/tty 读取，使 curl | sudo bash 安装也能正常显示提示。
  [[ "$ASSUME_YES" != true ]] && [[ -e /dev/tty ]] && [[ -r /dev/tty ]] && interactive=true

  if [[ -z "$MODE" ]]; then
    if [[ "$interactive" == true ]]; then
      answer="$(ask '部署模式 [http/https]（默认：http）：')"
      MODE="${answer:-http}"
    else
      MODE='http'
    fi
  fi
  [[ "$MODE" == 'http' || "$MODE" == 'https' ]] || die '部署模式必须是 http 或 https'

  if [[ "$interactive" == true && "$MODE" == 'https' ]]; then
    if [[ -z "$DOMAIN" ]]; then
      DOMAIN="$(ask 'HTTPS 域名（例如 showcase.example.com）：')"
    fi
    if [[ -z "$EMAIL" ]]; then
      EMAIL="$(ask '证书联系邮箱：')"
    fi
  fi

  if [[ "$interactive" == true && "$MODE" != 'https' && "$HTTP_PORT" == "$DEFAULT_HTTP_PORT" ]]; then
    answer="$(ask "HTTP 端口（默认：$DEFAULT_HTTP_PORT）：")"
    HTTP_PORT="${answer:-$DEFAULT_HTTP_PORT}"
    validate_port
  fi

  if [[ -z "$ADMIN_USERNAME" ]]; then
    if [[ "$interactive" == true ]]; then
      answer="$(ask "管理员用户名（默认：$DEFAULT_ADMIN_USERNAME）：")"
      ADMIN_USERNAME="${answer:-$DEFAULT_ADMIN_USERNAME}"
    else
      ADMIN_USERNAME="$DEFAULT_ADMIN_USERNAME"
    fi
  fi
  validate_admin_username

  if [[ -z "$ADMIN_PASSWORD" ]]; then
    if [[ "$interactive" == true ]]; then
      answer="$(ask "管理员密码（默认：$DEFAULT_ADMIN_PASSWORD）：" true)"
      ADMIN_PASSWORD="${answer:-$DEFAULT_ADMIN_PASSWORD}"
    else
      ADMIN_PASSWORD="$DEFAULT_ADMIN_PASSWORD"
    fi
  fi
  validate_admin_password
}

write_initial_env() {
  local target="$1"
  umask 077
  cat > "$target" <<EOF
COMPOSE_PROJECT_NAME=$APP_NAME
STATIC_HOST_IMAGE=$IMAGE_REPOSITORY
IMAGE_TAG=$VERSION
DEPLOY_MODE=$MODE
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD
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
  [[ ! -e "$ENV_FILE" ]] || die "$INSTALL_DIR 已存在安装实例，请使用 upgrade 升级"

  prompt_install_settings
  if [[ "$MODE" == 'https' ]]; then
    validate_domain
    validate_email
  elif [[ "$LOCAL_HTTP" != true ]]; then
    warn 'HTTP 默认监听所有地址，其他设备可以直接访问；登录流量不会被加密，公网部署建议使用 HTTPS'
  fi
  check_install_ports

  local parent stage https_verified=true
  parent="$(dirname "$INSTALL_DIR")"
  mkdir -p "$parent"
  [[ -w "$parent" ]] || die "安装目录的上级目录不可写：$parent"
  check_disk_space "$parent"
  mkdir -p "$INSTALL_DIR"/{database,sites,uploads,backups}
  chmod 700 "$INSTALL_DIR" "$INSTALL_DIR/backups"
  acquire_operation_lock
  [[ ! -e "$ENV_FILE" ]] || die "$INSTALL_DIR 已存在安装实例，请使用 upgrade 升级"

  stage="$(mktemp -d "$INSTALL_DIR/.install.XXXXXX")"
  trap 'rm -rf "$stage"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  download_release_assets "$stage"
  write_initial_env "$stage/.env"
  validate_release_assets "$stage" "$stage/.env" "$MODE"
  install_release_assets "$stage"
  mv -f "$stage/.env" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  if [[ "$SKIP_PULL" != true ]]; then compose pull; fi
  if ! compose up -d --no-build --remove-orphans || ! wait_for_health 180; then
    compose logs --tail=100 >&2 || true
    compose down --remove-orphans >/dev/null 2>&1 || true
    die '应用健康检查失败；部署文件和持久化数据已保留'
  fi
  if [[ "$MODE" == 'https' ]]; then
    wait_for_service_running caddy 90 || { compose logs --tail=100 caddy >&2 || true; die 'Caddy 启动失败'; }
    if ! wait_for_https; then
      https_verified=false
      warn '本机服务正常，但无法从当前服务器访问公网 HTTPS，请检查 DNS 和防火墙'
    fi
  fi

  trap - EXIT INT TERM HUP
  rm -rf "$stage"
  printf '\n安装完成。\n'
  if [[ "$MODE" == 'https' ]]; then
    printf '访问地址：https://%s/\n' "$DOMAIN"
    [[ "$https_verified" == true ]] || printf '当前服务器未能验证公网 HTTPS 可达性。\n'
  elif [[ "$LOCAL_HTTP" == true ]]; then
    printf '访问地址：http://127.0.0.1:%s/\n' "$HTTP_PORT"
    printf '当前仅监听本机地址，如需其他设备直接访问，请重新安装且不要使用 --local-http。\n'
  else
    printf '访问地址：http://<服务器IP>:%s/\n' "$HTTP_PORT"
    printf '当前监听所有地址 0.0.0.0，其他设备可通过服务器 IP 直接访问。\n'
  fi
  printf '管理员用户名：%s\n' "$ADMIN_USERNAME"
  printf '凭据和部署配置：%s\n' "$ENV_FILE"
  if [[ ${#ADMIN_PASSWORD} -lt 12 ]]; then
    printf '当前管理员密码较弱，请立即在“账号设置”中修改。\n'
  else
    printf '首次登录后可在“账号设置”中修改密码。\n'
  fi
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

  # shellcheck disable=SC2329 # 由下方 EXIT 陷阱调用。
  backup_cleanup() {
    local result=$?
    trap - EXIT INT TERM HUP
    rm -f "$temporary" "$temporary_checksum"
    if [[ "$was_running" == true ]]; then
      warn '备份被中断或失败，正在重新启动服务'
      if ! compose up -d --no-build >/dev/null 2>&1 || ! wait_for_health 180; then
        warn '备份中断后未能恢复服务'
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
    log '正在短暂停止服务，以创建一致的 SQLite 备份'
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
    wait_for_health 180 || die '备份已完成，但应用重启后未恢复健康状态'
    was_running=false
  fi
  trap - EXIT INT TERM HUP
  log "备份已创建：$archive"
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
  [[ -n "$repository" ]] || die '安装环境中缺少 STATIC_HOST_IMAGE'
  [[ "$VERSION" != "$old_version" ]] || { log "当前已经是 $VERSION 版本"; return 0; }

  log "正在准备镜像 $repository:$VERSION"
  if [[ "$SKIP_PULL" != true ]]; then docker pull "$repository:$VERSION"; fi
  docker image inspect "$repository:$VERSION" >/dev/null
  docker image inspect "$repository:$old_version" >/dev/null || die "找不到可用于回滚的旧镜像：$repository:$old_version"

  stage="$(mktemp -d "$INSTALL_DIR/.upgrade.XXXXXX")"
  rollback_dir="$(mktemp -d "$INSTALL_DIR/.rollback.XXXXXX")"
  validation_env="$stage/.env"

  # shellcheck disable=SC2329 # 由 upgrade_cleanup 调用。
  restore_previous() {
    local item
    [[ "$restored" == false ]] || return 0
    restored=true
    warn "正在恢复版本 $old_version"
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

  # shellcheck disable=SC2329 # 由下方 EXIT 陷阱调用。
  upgrade_cleanup() {
    local result=$?
    trap - EXIT INT TERM HUP
    if [[ "$rollback_needed" == true ]]; then
      if restore_previous; then
        warn "回滚完成：版本 $old_version 已恢复健康"
        rm -rf "$rollback_dir"
      else
        warn "回滚失败，恢复文件已保留在 $rollback_dir"
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
    die '启动新版本应用镜像时升级失败'
  fi
  if [[ "$mode" == 'https' ]]; then
    wait_for_service_running caddy 90 || die 'Caddy 未能启动，升级失败'
    DOMAIN="$(env_value PLATFORM_ORIGIN)"
    if ! wait_for_https; then
      warn '升级后的本机服务正常，但无法验证公网 HTTPS；未执行回滚'
    fi
  fi

  rollback_needed=false
  trap - EXIT INT TERM HUP
  rm -rf "$stage" "$rollback_dir"
  log "升级完成：$old_version -> $VERSION"
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
  *) usage >&2; die "未知命令：$COMMAND" ;;
esac
