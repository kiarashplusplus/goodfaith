# Good Faith

Interest-free, fee-free community loans on Solana. Texas residents only. Devnet MVP.

Proprietary. Copyright (c) 2026 Kiarash Adl. All rights reserved. See [LICENSE](LICENSE).

## Layout
- `programs/goodfaith` — on-chain program (Anchor 1.2.1)
- `app` — web app (Next.js)
- `docs` — [spec](docs/spec.md), [white paper](docs/whitepaper.md), [audit](docs/audit.md)

## Build and test
```sh
bash scripts/toolchain.sh   # Solana CLI, Anchor, Surfpool (Linux, no sudo)
anchor build --arch v2      # devnet does not enable SBPF v3 yet
anchor test --skip-build    # Rust LiteSVM + property tests
cd app && npm run test:svm  # the web app's builders against the built program in LiteSVM
```
End-to-end on a Surfpool devnet fork: see [scripts/README.md](scripts/README.md).

## Web app
```sh
cd app
cp .env.example .env.local
npm install
npm run codegen   # after any program change
npm run dev
```
