# Good Faith

Interest-free, fee-free community loans on Solana, funded by gifts. Texas residents only. Version 6 of the design,
running on a test network.

Source is published under the [Apache License 2.0](LICENSE) so that anyone can inspect what the program and the
services do; the name "Good Faith" identifies this project and is not licensed (see [NOTICE](NOTICE)).
Copyright 2026 Kiarash Adl.

## Layout
- `programs/goodfaith` — on-chain program (Anchor 1.2.1)
- `app` — web app (Next.js)
- `scripts` — fork deployment, end-to-end runs, the operator's cranker, the member CLI, the economic model
- `docs` — [spec](docs/spec.md), [white paper](docs/whitepaper.md), [audit](docs/audit.md), [identity](docs/identity.md), [economics](docs/economics.md)

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

## Identity

Members are people, not wallets: the app's identity issuer (see `app/README.md` and `docs/identity.md`) verifies a
government ID with a provider, keeps a keyed fingerprint per credential and an opaque random id per person, issues a
pass on the fund's own gatekeeper network and co-signs the on-chain registration. One person, one wallet; a lost
wallet is recovered through a signed request, a notice to the member, and a proposal the operator verifies and signs
with a key the web service never holds, which the old wallet can veto during a delay, without losing the membership.
Passes renew yearly with a signed message; a permanent bar freezes them and a lift thaws them.

## Continuous integration
`.github/workflows/ci.yml`: program format and clippy; Anchor build with the Rust and app-side LiteSVM test suites;
app lint, types, Prettier, unit tests, build, audit and a Playwright smoke; and, on `main` and by hand, the full end
to end run on a Surfpool devnet fork with Kora direct and through the app's sponsor proxy.
