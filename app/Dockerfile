# The web app, identity service and sponsor proxy in one image (Next.js standalone server).
# Build from the repository root so the generated client and scripts are visible:
#   docker build -f app/Dockerfile --build-arg NEXT_PUBLIC_RPC_URL=... --build-arg NEXT_PUBLIC_POOL_MINT=... \
#     --build-arg NEXT_PUBLIC_PROGRAM_ID=... --build-arg NEXT_PUBLIC_POOL_AUTHORITY=... \
#     --build-arg NEXT_PUBLIC_GATEKEEPER_NETWORK=... --build-arg NEXT_PUBLIC_KORA_URL=/api/sponsor -t goodfaith-app .
# NEXT_PUBLIC_* are baked in at build time (the browser bundle carries them); everything secret is runtime env.
FROM node:22-alpine AS deps
WORKDIR /src/app
COPY app/package.json app/package-lock.json app/.npmrc ./
RUN npm ci --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /src/app
ARG NEXT_PUBLIC_CLUSTER=devnet
ARG NEXT_PUBLIC_RPC_URL=https://api.devnet.solana.com
ARG NEXT_PUBLIC_POOL_MINT=4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
ARG NEXT_PUBLIC_PROGRAM_ID
ARG NEXT_PUBLIC_POOL_ADDRESS=
ARG NEXT_PUBLIC_POOL_AUTHORITY=none
ARG NEXT_PUBLIC_GATEKEEPER_NETWORK=
ARG NEXT_PUBLIC_KORA_URL=/api/sponsor
ARG GOODFAITH_VERSION=dev
ENV NEXT_PUBLIC_CLUSTER=$NEXT_PUBLIC_CLUSTER NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL NEXT_PUBLIC_POOL_MINT=$NEXT_PUBLIC_POOL_MINT \
    NEXT_PUBLIC_PROGRAM_ID=$NEXT_PUBLIC_PROGRAM_ID NEXT_PUBLIC_POOL_ADDRESS=$NEXT_PUBLIC_POOL_ADDRESS NEXT_PUBLIC_POOL_AUTHORITY=$NEXT_PUBLIC_POOL_AUTHORITY \
    NEXT_PUBLIC_GATEKEEPER_NETWORK=$NEXT_PUBLIC_GATEKEEPER_NETWORK NEXT_PUBLIC_KORA_URL=$NEXT_PUBLIC_KORA_URL \
    NEXT_TELEMETRY_DISABLED=1 GOODFAITH_VERSION=$GOODFAITH_VERSION
COPY --from=deps /src/app/node_modules ./node_modules
COPY app/ ./
# `public/` may not exist in the repository; the runner stage copies it unconditionally.
RUN mkdir -p public && npm run build

FROM node:22-alpine AS run
WORKDIR /srv
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0 IDENTITY_DB_PATH=/data/identity.sqlite
ARG GOODFAITH_VERSION=dev
ENV GOODFAITH_VERSION=$GOODFAITH_VERSION
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data
COPY --from=build --chown=app:app /src/app/.next/standalone ./
COPY --from=build --chown=app:app /src/app/.next/static ./.next/static
COPY --from=build --chown=app:app /src/app/public ./public
USER app
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
CMD ["node", "server.js"]
