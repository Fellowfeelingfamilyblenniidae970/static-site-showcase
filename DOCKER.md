# Docker 部署

公开镜像：

```text
docker.io/epiphany131/static-site-showcase
```

支持平台：`linux/amd64`、`linux/arm64`。

生产部署建议固定完整版本（例如 `1.2.0`），而不是长期跟踪 `latest`。

## 一键部署

安装时脚本会依次询问部署模式、HTTP 端口、管理员用户名和管理员密码，直接回车即使用默认值：

| 提示 | 默认值 |
| --- | --- |
| 部署模式 | `http` |
| HTTP 监听 | `0.0.0.0`（所有地址） |
| HTTP 端口 | `3000` |
| 管理员用户名 | `admin` |
| 管理员密码 | `123456` |

默认 HTTP 会对所有网卡公开端口，其他设备可以通过服务器 IP 直接访问。默认密码 `123456` 很容易被猜到，任何能访问该端口的人都可以尝试登录；请在安装时输入强密码或首次登录后立即在 **账号设置** 中修改，公网部署建议使用 HTTPS。也可以用 `--port`、`--admin-username`、`--admin-password` 在命令行直接指定，用 `--yes` 跳过全部提示并接受默认值。只有显式使用 `--local-http` 时才限制为 `127.0.0.1`。

以下命令固定到 Git 标签 `v1.2.0`。脚本会校验随后下载的部署资源；但首个脚本本身仍来自远端。如果需要更高信任级别，建议先下载、审阅并与 Git 标签中的内容核对后再执行：

```bash
mkdir static-site-showcase-installer && cd static-site-showcase-installer
base=https://raw.githubusercontent.com/epiphany131/static-site-showcase/v1.2.0
for file in deploy.sh deploy-assets.sha256 docker-compose.yml docker-compose.production.yml Caddyfile; do
  curl -fSLO "$base/$file"
done
sha256sum --strict --check deploy-assets.sha256
bash -n deploy.sh
less deploy.sh
sudo bash deploy.sh install --mode http
```

### 公共 HTTP（默认）

默认监听 `0.0.0.0:3000`，部署完成后可直接通过 `http://服务器IP:3000/` 访问：

```bash
curl -fsSL https://raw.githubusercontent.com/epiphany131/static-site-showcase/v1.2.0/deploy.sh \
  | sudo bash -s -- install --mode http
```

HTTP 登录流量不会被传输层加密。任何能访问该端口的人都可以打开页面并尝试登录；请使用强密码，面向互联网时应使用 HTTPS。

### 仅本机 HTTP

只有显式传入 `--local-http` 才限制监听 `127.0.0.1:3000`：

```bash
curl -fsSL https://raw.githubusercontent.com/epiphany131/static-site-showcase/v1.2.0/deploy.sh \
  | sudo bash -s -- install --mode http --local-http
```

### Caddy 自动 HTTPS

域名 DNS 必须指向服务器，并开放 TCP 80/443 和 UDP 443：

```bash
curl -fsSL https://raw.githubusercontent.com/epiphany131/static-site-showcase/v1.2.0/deploy.sh \
  | sudo bash -s -- install --mode https \
      --domain showcase.example.com \
      --email admin@example.com
```

Caddy 会自动申请和续期证书。Node.js 服务只在 Docker 网络中暴露，Cookie 启用 Secure 属性，并信任一层 Caddy 代理。

## 安装行为

脚本默认使用 `/opt/static-site-showcase`，并创建：

```text
.env                 权限为 0600 的部署配置
 database/           SQLite 数据库和品牌资源
 sites/              托管站点
 uploads/            临时上传和下载文件
 backups/            版本升级和手动备份
 Caddyfile            HTTPS 配置
 docker-compose.yml
 docker-compose.production.yml
 deploy-assets.sha256 部署资源完整性清单
 deploy.sh            后续运维命令
```

首次安装会依次询问部署模式、HTTP 端口、管理员用户名和管理员密码，并使用以下默认值：

| 提示 | 默认值 |
| --- | --- |
| 部署模式 | `http` |
| HTTP 监听 | `0.0.0.0`（所有地址） |
| HTTP 端口 | `3000` |
| 管理员用户名 | `admin` |
| 管理员密码 | `123456` |

密码输入不会回显。直接回车即接受默认值。也可以用参数跳过提示：

```bash
sudo bash deploy.sh install --mode http --port 8080 \
  --admin-username admin --admin-password '请替换为足够长的随机密码' --yes
```

默认密码 `123456` 只适合本机试用。任何能访问该端口的人都可以用它登录，请在首次登录后立即在 **账号设置** 中修改，公开部署时不要使用默认密码。密码长度小于 12 位时脚本会打印警告。

`ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 只负责空数据库中的首个管理员。修改 `.env` 不会覆盖已有账号。

## 运维命令

```bash
sudo /opt/static-site-showcase/deploy.sh status
sudo /opt/static-site-showcase/deploy.sh logs
sudo /opt/static-site-showcase/deploy.sh backup
sudo /opt/static-site-showcase/deploy.sh upgrade --version 1.2.0
```

自定义安装目录时，每次命令使用相同的 `--dir`：

```bash
sudo ./deploy.sh status --dir /srv/static-site-showcase
```

## 备份

为确保 SQLite WAL 内容一致，备份命令会短暂停止服务，再归档：

```text
.env
database/
sites/
uploads/
```

备份文件和 SHA-256 清单位于 `backups/`，权限为 `0600`。完成后服务会自动启动并等待健康检查；若归档或校验过程异常中断，脚本也会尝试恢复原先运行的服务。

请把备份复制到另一台主机或对象存储，并定期验证恢复流程。

## 升级与失败恢复

升级顺序：

1. 拉取目标版本标签并确认旧版与新版镜像都在本机可用；
2. 下载部署资源到暂存目录，校验 SHA-256、Shell 语法和 Compose 配置；
3. 创建升级前一致性备份并保存旧部署文件；
4. 切换镜像并等待应用和 Caddy（HTTPS 模式）启动；
5. 失败或中断时恢复旧部署文件、旧标签，并重新等待旧服务健康；
6. HTTPS 公网 `/health` 作为外部可达性检查；因 DNS、回环 NAT 或出口策略无法从服务器访问时只告警，不回滚本地健康服务。

修改操作由安装目录中的互斥锁串行执行。脚本不会执行 `docker compose down -v`，也不会覆盖现有数据库或站点文件；`.env` 只会事务性修改 `IMAGE_TAG`。SemVer 标签是固定版本标识，但 Docker 标签在技术上仍可被仓库所有者移动，因此发布工作流会拒绝覆盖已存在的精确版本标签。

镜像回滚不能替代数据库备份：未来数据库迁移可能不向后兼容。如需恢复数据库，请停止服务并从相应备份还原完整数据目录。

## 手动 Compose 部署

克隆仓库：

```bash
git clone https://github.com/epiphany131/static-site-showcase.git
cd static-site-showcase
cp .env.example .env
```

编辑 `.env`：

```env
IMAGE_TAG=1.2.0
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-long-random-password
HTTP_BIND=0.0.0.0
HTTP_PORT=3000
```

只拉取预构建镜像：

```bash
docker compose pull
docker compose up -d --no-build
```

从当前源码构建：

```bash
docker compose up -d --build
```

HTTPS 模式还需设置：

```env
PLATFORM_ORIGIN=showcase.example.com
ACME_EMAIL=admin@example.com
```

然后运行：

```bash
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d --no-build
```

## 直接运行镜像

```bash
mkdir -p database sites uploads
docker run -d \
  --name static-site-showcase \
  -p 3000:3000 \
  -e ADMIN_USERNAME=admin \
  -e ADMIN_PASSWORD=replace-with-a-long-random-password \
  -e DB_PATH=/app/database/platform.db \
  -v "$PWD/database:/app/database" \
  -v "$PWD/sites:/app/sites" \
  -v "$PWD/uploads:/app/uploads" \
  --restart unless-stopped \
  epiphany131/static-site-showcase:1.2.0
```

镜像内置健康检查。查看状态：

```bash
docker inspect --format '{{.State.Health.Status}}' static-site-showcase
docker logs -f static-site-showcase
```

## 镜像标签

稳定版本 `v1.2.3` 发布：

```text
1.2.3
1.2
1
latest
```

预发布版本只发布精确标签，不更新 `latest`。镜像包含 OCI 来源、版本、提交和构建时间标签，并由 GitHub Actions 生成 SBOM 与 provenance。

## 安全说明

- HTTP 默认监听所有网卡 `0.0.0.0`，其他设备可以通过服务器 IP 直接访问；使用 `--local-http` 可限制为 `127.0.0.1`。
- 应用接受任意语法合法 Host，生产域名限制由 Caddy或其他受信任代理完成。
- 不启用带凭据 CORS。
- 托管网站使用不含 `allow-same-origin` 的 CSP 沙箱。
- Docker Hub 发布使用专用 Access Token，不使用 Docker Hub 主密码。
- 为兼容现有 bind mount 数据，本版本仍以镜像默认用户运行；未来非 root 迁移将提供明确的目录所有权升级步骤。

## 故障排查

```bash
sudo /opt/static-site-showcase/deploy.sh status
sudo /opt/static-site-showcase/deploy.sh logs
docker info
docker compose version
```

常见检查：

- `.env` 是否存在且权限为 `0600`；
- `database/`、`sites/`、`uploads/` 是否可写；
- HTTPS 域名 DNS 是否指向当前服务器；
- TCP 80/443 与 UDP 443 是否被防火墙放行；
- 端口是否被其他服务占用；
- 磁盘空间是否充足。
