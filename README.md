# Static Site Showcase

A self-hosted platform for uploading, publishing, previewing, and sharing static websites. It runs on Node.js 22, Express, and SQLite, with no external database service required.

## Features

- Upload static sites as ZIP archives, with zip-slip and extraction limits.
- Create sites by pasting HTML, CSS, and JavaScript directly in the admin UI.
- Publish or unpublish works and control whether visitors can view/download source code.
- Browse source files with syntax highlighting and download public projects as ZIP files.
- Create Markdown articles, documentation, and code-oriented content pages with live preview.
- Manage administrator and editor accounts with owner-scoped permissions.
- Change your own username and password from the account settings page.
- Customize public branding, themes, layouts, logos, and favicons.
- Serve uploaded documents with a sandbox Content Security Policy and `nosniff` headers.
- Run locally with Node.js or deploy with Docker Compose and Caddy.

## Requirements

- Node.js 22.13.0 or newer
- npm
- Docker and Docker Compose, if using containers

## Quick Start

```bash
npm ci
cp .env.example .env
# Edit .env and set a strong ADMIN_PASSWORD.
npm start
```

Open:

- Public gallery: <http://localhost:3000/>
- Content pages: <http://localhost:3000/pages>
- Login: <http://localhost:3000/login>
- Admin UI: <http://localhost:3000/admin/>

The development Compose file also works after creating `.env`:

```bash
docker compose up -d --build
```

On a new database, `ADMIN_USERNAME` and the required `ADMIN_PASSWORD` set the initial administrator credentials. Startup fails instead of creating an account with a public default password when `ADMIN_PASSWORD` is missing.

## Configuration

Copy `.env.example` to `.env` and adjust the values:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port used by Node.js |
| `NODE_ENV` | `development` | Runtime environment |
| `MAX_FILE_SIZE` | `52428800` | Maximum uploaded ZIP size in bytes |
| `DB_PATH` | `./database/platform.db` | SQLite database path |
| `ADMIN_USERNAME` | `admin` | Initial administrator username |
| `ADMIN_PASSWORD` | required for a new database | Initial administrator password |
| `COOKIE_SECURE` | `false` | Send cookies only over HTTPS when `true` |
| `TRUST_PROXY` | `0` | Trust one reverse-proxy hop when set to `1` |

Initial credentials are used only when the database has no users. Changing them later does not modify an existing account; use **Admin > Account Settings** instead.

## Uploading Sites

### ZIP upload

The archive must contain `index.html` at its root. A single wrapper directory is flattened automatically. New sites are saved as drafts and source visibility is enabled by default.

Incoming archives are constrained by entry count, per-file size, total extracted size, compression ratio, duplicate targets, and path traversal checks.

### Paste code

Choose **Paste code** in the deployment panel and enter:

- HTML: required
- CSS: optional
- JavaScript: optional

The server creates `index.html`, `style.css`, and `script.js`. Each pasted code file is limited to 512 KiB. The multipart parser also enforces strict field, file, and part limits.

## Users and Permissions

- **Administrator**: manages all sites, content pages, branding, and accounts.
- **Editor**: creates and manages only sites owned by that account.
- Both roles can update their own username and password by providing the current password.

The server uses SQLite-backed sessions, an HttpOnly session cookie, login CSRF challenges, and per-session CSRF tokens for authenticated writes.

## Network and Security Model

The application accepts requests carrying any syntactically valid `Host` header so it can work behind arbitrary local addresses and reverse proxies. It does not enable credentialed CORS.

This is intentionally different from a host allowlist. If you expose the application publicly, put it behind a reverse proxy that only routes your intended domain, enable HTTPS, set `COOKIE_SECURE=true`, and use a strong administrator password.

Hosted site files receive this isolation policy:

```text
Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals allow-popups allow-downloads
X-Content-Type-Options: nosniff
```

Uploaded code is intentionally executable inside its sandbox. Do not weaken the sandbox or add `allow-same-origin` without reviewing the security consequences.

## Production Deployment

Create a production `.env` file:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-long-random-password
PLATFORM_ORIGIN=example.com
ACME_EMAIL=admin@example.com
```

Then run:

```bash
docker compose -f docker-compose.production.yml up -d --build
```

Caddy terminates HTTPS and only the reverse proxy publishes ports 80/443. See [DOCKER.md](DOCKER.md) for details.

## Data and Backups

Persistent state lives in:

```text
database/   SQLite database and branding assets
sites/      extracted/generated static sites
uploads/    temporary upload and download files
```

Back up the SQLite database consistently. One option is to use SQLite's `VACUUM INTO` from inside the running container, then archive `sites/`, `uploads/`, and `database/assets/` separately. Do not use `docker compose down -v` unless you intend to delete named Caddy volumes.

## Development

```bash
npm ci
npm test
npm run dev
```

The test suite covers authentication, CSRF, account ownership, SQLite migrations, ZIP extraction, pasted-code limits, rollback behavior, source filtering, Markdown rendering, image validation, and public downloads.

## API Overview

All management routes require an authenticated session. Mutating management routes also require the current CSRF token.

| Method and path | Purpose |
| --- | --- |
| `POST /api/auth/login` | Create an authenticated session |
| `GET /api/auth/me` | Read the current account |
| `PATCH /api/auth/profile` | Change the current username |
| `POST /api/auth/change-password` | Change the current password |
| `GET /api/sites` | List manageable sites |
| `POST /api/sites` | Upload a ZIP site |
| `POST /api/sites/code` | Create a site from pasted code |
| `PATCH /api/sites/:id` | Update publication, source visibility, or metadata |
| `DELETE /api/sites/:id` | Delete a site and its files |
| `GET /api/gallery` | List published works |
| `GET /api/gallery/:id/files` | List public source files |
| `GET /api/gallery/:id/download` | Download public source as ZIP |
| `GET /api/pages` | List published content pages |
| `GET /health` | Health check |

## Repository Layout

```text
app.js                    Express application and routes
database.js               SQLite schema and data access
server.js                 Process entry point
lib/                      Auth, upload, ZIP, Markdown, and security helpers
public/                   Administration UI
showcase/                 Public gallery, work, and content views
test/                     Node.js test suite
test-site/                Example static site fixture
Dockerfile                Runtime image
docker-compose.yml        Local development deployment
docker-compose.production.yml  Caddy HTTPS deployment
```

## Responsible Disclosure

Please do not open a public issue for security vulnerabilities. Follow [SECURITY.md](SECURITY.md) and use GitHub Private Vulnerability Reporting when available.

## License

This project is released under the [MIT License](LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
