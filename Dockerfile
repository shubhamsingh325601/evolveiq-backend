# EvolvIQ API, production image. Built and run by deploy/docker-compose.prod.yml.
# Full dependencies on purpose: the Prisma CLI (migrations) and tsx (bootstrap-admin)
# are dev dependencies, and they run inside this image too.
FROM node:22-bookworm-slim

# Prisma's schema engine (migrate deploy) needs OpenSSL.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV CHECKPOINT_DISABLE=1

COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
EXPOSE 3000
USER node
CMD ["node", "dist/src/server.js"]
