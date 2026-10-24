# Kora 2.0.5, the fee sponsor, with the fund's policy. Build from the repository root (10-20 min, compiles Kora):
#   docker build -f deploy/kora.Dockerfile -t goodfaith-kora .
# Runtime env: KORA_PRIVATE_KEY (the sponsor keypair; use a Turnkey or Privy signer for hosting), KORA_API_KEY,
# KORA_HMAC_SECRET, RPC_URL. Never publish its port: only the app's /api/sponsor proxy talks to it.
FROM rust:1-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev libudev-dev protobuf-compiler && rm -rf /var/lib/apt/lists/*
RUN cargo install kora-cli --version 2.0.5 --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libssl3 && rm -rf /var/lib/apt/lists/* \
  && useradd -r -s /usr/sbin/nologin kora
COPY --from=build /usr/local/cargo/bin/kora /usr/local/bin/kora
COPY scripts/kora/kora.toml scripts/kora/signers.toml /etc/kora/
USER kora
ENV RPC_URL=https://api.devnet.solana.com
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD curl -sf http://127.0.0.1:8080/liveness || exit 1
CMD ["sh", "-c", "exec kora --config /etc/kora/kora.toml --rpc-url \"$RPC_URL\" rpc start --signers-config /etc/kora/signers.toml --port 8080"]
