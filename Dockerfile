# Node.js 22 remains supported through April 2027.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

ARG BUILD_VERSION=dev
ARG BUILD_REVISION=unknown
ARG BUILD_CREATED=unknown

LABEL org.opencontainers.image.title="Static Site Showcase" \
      org.opencontainers.image.description="Self-hosted platform for publishing and sharing static websites" \
      org.opencontainers.image.source="https://github.com/epiphany131/static-site-showcase" \
      org.opencontainers.image.url="https://github.com/epiphany131/static-site-showcase" \
      org.opencontainers.image.documentation="https://github.com/epiphany131/static-site-showcase#readme" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="$BUILD_VERSION" \
      org.opencontainers.image.revision="$BUILD_REVISION" \
      org.opencontainers.image.created="$BUILD_CREATED"

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/sites /app/uploads /app/database

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "server.js"]
