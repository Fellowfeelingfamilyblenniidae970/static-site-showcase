# Node.js 22 remains supported through April 2027.
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

WORKDIR /app

# 使用锁文件进行可复现的生产依赖安装
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
RUN mkdir -p /app/sites /app/uploads /app/database

EXPOSE 3000

CMD ["node", "server.js"]
