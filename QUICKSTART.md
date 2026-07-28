# 快速开始

## 一键 Docker 部署

要求：Linux、Docker Engine、Docker Compose v2 和 curl。

默认安全 HTTP 模式仅监听服务器本机 `127.0.0.1:3000`：

```bash
curl -fsSL https://raw.githubusercontent.com/epiphany131/static-site-showcase/v1.0.0/deploy.sh \
  | sudo bash -s -- install --mode http
```

如需直接通过服务器 IP 访问，可显式开放 HTTP（登录流量不会加密）：

```bash
curl -fsSL https://raw.githubusercontent.com/epiphany131/static-site-showcase/v1.0.0/deploy.sh \
  | sudo bash -s -- install --mode http --public-http
```

使用域名和 Caddy 自动 HTTPS：

```bash
curl -fsSL https://raw.githubusercontent.com/epiphany131/static-site-showcase/v1.0.0/deploy.sh \
  | sudo bash -s -- install --mode https \
      --domain showcase.example.com \
      --email admin@example.com
```

脚本会自动生成强管理员密码并只显示一次。部署文件和数据默认保存在 `/opt/static-site-showcase`。脚本使用版本化 SHA-256 清单校验 Compose、Caddy 和运维脚本；如需在执行首个远端脚本前手工校验和审阅，请按 [Docker 部署文档](DOCKER.md) 的高信任流程操作。

## 运维命令

```bash
sudo /opt/static-site-showcase/deploy.sh status
sudo /opt/static-site-showcase/deploy.sh logs
sudo /opt/static-site-showcase/deploy.sh backup
sudo /opt/static-site-showcase/deploy.sh upgrade --version 1.1.0
```

一键安装会把脚本副本保存到安装目录。升级前会创建一致性备份，失败时恢复旧镜像版本；不会删除数据卷。

## 使用 Node.js

要求：Node.js 22.13.0 或更高版本和 npm。

```bash
git clone https://github.com/epiphany131/static-site-showcase.git
cd static-site-showcase
npm ci
cp .env.example .env
# 编辑 .env 并设置强 ADMIN_PASSWORD
npm start
```

访问：

- 作品首页：<http://localhost:3000/>
- 登录：<http://localhost:3000/login>
- 管理后台：<http://localhost:3000/admin/>
- 健康检查：<http://localhost:3000/health>

新作品默认是草稿，需要在后台预览后手动发布。初始环境凭据只在数据库尚无用户时生效。
