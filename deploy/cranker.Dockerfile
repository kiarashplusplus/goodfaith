# The operator's scheduled job (scripts/cranker.ts) and the admin / member command lines, with the app's own
# transaction code. Build from the repository root:  docker build -f deploy/cranker.Dockerfile -t goodfaith-cranker .
# Runtime env: RPC_URL, NEXT_PUBLIC_POOL_MINT, NEXT_PUBLIC_PROGRAM_ID, CRANKER_KEYPAIR (a mounted JSON keypair),
# APP_URL + IDENTITY_ADMIN_KEY (pass revocation), optional KORA_URL. Override the command for admin or member.
FROM node:22-alpine
WORKDIR /srv
COPY app/package.json app/package-lock.json app/
RUN cd app && npm ci --no-audit --no-fund
COPY scripts/package.json scripts/package-lock.json scripts/
RUN cd scripts && npm ci --no-audit --no-fund
COPY app/src app/src
COPY app/tsconfig.json app/next.config.ts app/
COPY scripts/*.ts scripts/*.json scripts/
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /srv
USER app
WORKDIR /srv/scripts
ENV CRANKER_INTERVAL=300
CMD ["sh", "-c", "exec npx tsx cranker.ts --interval \"$CRANKER_INTERVAL\""]
