FROM node:22-alpine AS base
WORKDIR /app
RUN apk add --no-cache python3 make g++

FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production

FROM base AS builder
COPY package*.json ./
RUN npm ci
COPY . .

# API Server (Secure)
FROM base AS api
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package*.json ./

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

RUN mkdir -p /root/.dmail

CMD ["node", "src/server/secure-server.js"]

# Relay Node
FROM base AS relay
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY src ./src
COPY package*.json ./

ENV NODE_ENV=production
ENV PORT=4001
ENV WS_PORT=4002
EXPOSE 4001 4002

RUN mkdir -p /root/.dmail-relay

CMD ["node", "src/network/relay-node.js"]
