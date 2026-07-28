# Quick Start

## Local Node.js

Requirements: Node.js 22.13.0 or newer and npm.

```bash
npm ci
cp .env.example .env
# Edit .env and set a strong ADMIN_PASSWORD.
npm start
```

Before exposing the service, edit `.env` and set a strong `ADMIN_PASSWORD`.

## Local Docker Compose

```bash
cp .env.example .env
# Edit .env and set a strong ADMIN_PASSWORD.
docker compose up -d --build
docker compose logs -f
```

Open:

- Gallery: <http://localhost:3000/>
- Login: <http://localhost:3000/login>
- Admin: <http://localhost:3000/admin/>
- Health: <http://localhost:3000/health>

On a new database, Compose refuses to start until `ADMIN_PASSWORD` is set. The initial username defaults to `admin` unless `ADMIN_USERNAME` is also configured.

## Create a Site

From the admin deployment panel, either:

1. Upload a ZIP whose root contains `index.html`; or
2. Choose **Paste code**, provide a site name, and paste HTML with optional CSS and JavaScript.

Every new site starts as a draft. Use **Preview**, then **Publish** when ready.

## Persistent Data

```text
database/   SQLite and branding assets
sites/      hosted site files
uploads/    temporary files
```

These paths are ignored by Git. Back them up before upgrades.

## Useful Commands

```bash
npm test
docker compose ps
docker compose restart
docker compose logs -f
docker compose down
```

Do not run `docker compose down -v` unless deleting named volumes is intentional.
