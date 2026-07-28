# Docker Deployment

## Requirements

- Docker Engine with Docker Compose v2, or Docker Desktop
- A writable project directory for bind-mounted data

## Local Deployment

```bash
cp .env.example .env
# Edit .env and set ADMIN_PASSWORD before exposing port 3000.
docker compose up -d --build
```

Check the service:

```bash
docker compose ps
docker compose logs -f
curl http://localhost:3000/health
```

Persistent directories are bind-mounted from the project:

```text
./database -> /app/database
./sites    -> /app/sites
./uploads  -> /app/uploads
```

Recreating the container does not remove these directories.

## HTTPS Deployment with Caddy

The production Compose file publishes only Caddy on ports 80/443. The Node.js service remains on the internal `web` network.

Create `.env` with production values:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-long-random-password
PLATFORM_ORIGIN=example.com
ACME_EMAIL=admin@example.com
```

Point the domain's DNS records at the host, allow inbound TCP 80/443 and UDP 443, then run:

```bash
docker compose -f docker-compose.production.yml up -d --build
docker compose -f docker-compose.production.yml logs -f
```

Production Compose requires `ADMIN_PASSWORD`, `PLATFORM_ORIGIN`, and `ACME_EMAIL`; neither Compose configuration provides a default password.

`COOKIE_SECURE=true` and `TRUST_PROXY=1` are enabled for the Node.js service. Caddy forwards the original host and HTTPS scheme.

## Reverse Proxy Notes

The application accepts any syntactically valid Host and does not enable credentialed CORS. Restrict public hostnames at your reverse proxy or cloud load balancer. Do not route untrusted domains to the same service.

When using a proxy other than the supplied Caddy configuration:

- Forward the original `Host` header.
- Set `X-Forwarded-Proto: https`.
- Set `TRUST_PROXY=1` only when exactly one trusted proxy is in front of Node.js.
- Set `COOKIE_SECURE=true` only when clients always use HTTPS.
- Allow request bodies large enough for `MAX_FILE_SIZE` plus multipart overhead.

## Updating

```bash
git pull --ff-only
docker compose up -d --build
```

For the Caddy deployment:

```bash
git pull --ff-only
docker compose -f docker-compose.production.yml up -d --build
```

Do not use `docker compose down -v` during a routine update.

## Backups

Back up SQLite consistently instead of copying a busy database file blindly. For example, execute `VACUUM INTO` with Node's SQLite API in the running container, copy that snapshot out, and archive the site and branding directories.

At minimum, preserve:

```text
database/platform.db
database/assets/
sites/
```

The `uploads/` directory usually contains temporary files, but include it when taking a complete operational snapshot.

Verify backup hashes and practice restore procedures before relying on them.

## Troubleshooting

### Container does not start

```bash
docker compose ps
docker compose logs --tail=100
```

Confirm that `.env` exists and that bind-mounted directories are writable.

### Cannot log in

- Confirm the account exists in the current SQLite database.
- Initial environment credentials only apply when the database has no users.
- Ensure the browser can retain cookies.
- With HTTPS, verify `COOKIE_SECURE=true`; with direct HTTP development, use `false`.

### Uploaded site returns 404

- A draft is visible only to its owner or an administrator.
- Publish the site before testing as an anonymous visitor.
- ZIP uploads require a root `index.html` after optional single-directory flattening.

### Port 3000 is in use

Change the host-side mapping in `docker-compose.yml`, for example:

```yaml
ports:
  - "8080:3000"
```

Then open <http://localhost:8080/>.
