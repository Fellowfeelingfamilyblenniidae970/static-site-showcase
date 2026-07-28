# 快速开始

## 一键 Docker 部署

要求：Linux、Docker Engine、Docker Compose v2 和 curl。

默认 HTTP 监听所有地址 `0.0.0.0:3000`，部署后可通过 `http://服务器IP:3000/` 直接访问：

```bash
curl -fsSL https://raw.githubusercontent.com/epiphany131/static-site-showcase/v1.2.0/deploy.sh \
  | sudo bash -s -- install --mode http
```

如需只允许服务器本机访问，显式添加 `--local-http`：

```bash
curl -fsSL https://raw.githubusercontent.com/epiphany131/static-site-showcase/v1.2.0/deploy.sh \
  | sudo bash -s -- install --mode http --local-http
```

使用域名和 Caddy 自动 HTTPS：

```bash
curl -fsSL https://raw.githubusercontent.com/epiphany131/static-site-showcase/v1.2.0/deploy.sh \
  | sudo bash -s -- install --mode https \
      --domain showcase.example.com \
      --email admin@example.com
```

安装时脚本会依次询问部署模式、HTTP 端口、管理员用户名和管理员密码，直接回车即使用默认值：

| 提示 | 默认值 |
| --- | --- |
| HTTP 监听 | `0.0.0.0`（所有地址） |
| HTTP 端口 | `3000` |
| 管理员用户名 | `admin` |
| 管理员密码 | `123456` |

默认密码 `123456` 很容易被猜到，登录后请立即在 **账号设置** 中修改。也可以用参数跳过提问：

```bash
sudo bash deploy.sh install --mode http --port 3000 \
  --admin-username admin --admin-password '换成足够长的随机密码'
```

部署文件和数据默认保存在 `/opt/static-site-showcase`。脚本使用版本化 SHA-256 清单校验 Compose、Caddy 和运维脚本；如需在执行首个远端脚本前手工校验和审阅，请按 [Docker 部署文档](DOCKER.md) 的高信任流程操作。

## 运维命令

```bash
sudo /opt/static-site-showcase/deploy.sh status
sudo /opt/static-site-showcase/deploy.sh logs
sudo /opt/static-site-showcase/deploy.sh backup
sudo /opt/static-site-showcase/deploy.sh upgrade --version 1.2.0
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
