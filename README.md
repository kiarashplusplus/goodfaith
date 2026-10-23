# Good Faith

Interest-free, fee-free community loans on Solana. Texas residents only. Devnet MVP.

Proprietary. Copyright (c) 2026 Kiarash Adl. All rights reserved. See [LICENSE](LICENSE).

## Layout
- `programs/goodfaith` — on-chain program (Anchor 1.2.1)
- `app` — web app (Next.js)
- `docs` — [spec](docs/spec.md), [white paper](docs/whitepaper.md), [audit](docs/audit.md)

## Build and test
```sh
anchor build --arch v2   # devnet does not enable SBPF v3 yet
anchor test --skip-build
```

## Web app
```sh
cd app
cp .env.example .env.local
npm install
npm run codegen   # after any program change
npm run dev
```
