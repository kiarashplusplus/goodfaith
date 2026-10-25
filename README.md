# Good Faith

[![CI](https://github.com/kiarashplusplus/goodfaith/actions/workflows/ci.yml/badge.svg)](https://github.com/kiarashplusplus/goodfaith/actions/workflows/ci.yml)

Interest-free, fee-free community loans on Solana, funded by gifts. Texas residents only.

**Status:** pilot design (version 7), live on **devnet only**, with test money. No mainnet deployment.

## How it works
- **Donors** give USDC to a shared fund as gifts: they earn nothing and cannot take it back, which lets the fund lend
  at zero cost.
- **Borrowers** pay back exactly what they borrow: first loan up to 150 USDC, rising with each on-time loan to 500.
- **A friend co-signs** each loan with a 25% deposit held in escrow. It is theirs again if the loan is repaid on time;
  if not, it covers what is missing.
- **One person, one membership:** an identity check issues a pass on the fund's own gatekeeper network, and a lost
  wallet can be recovered without losing the membership.
- **Fees are covered:** a fee sponsor (Kora) pays network fees, so members need no SOL.
- **Cash at MoneyGram:** members can turn USDC into cash at a MoneyGram counter, or cash into USDC, from the app's
  Checking page. MoneyGram runs its own ID check and charges its own fee (its test environment quotes $3). This works
  on devnet against MoneyGram's sandbox; see [app/README.md](app/README.md#cash-at-moneygram).
- **Everything is public and on chain:** settings changes wait out a notice period, and the white paper's appendix
  lists how to check what is deployed.

## Read more
- [White paper](docs/whitepaper.md): the case, the risks and how to verify the deployment
- [Specification](docs/spec.md) · [Economics](docs/economics.md) · [Identity](docs/identity.md) ·
  [Internal review](docs/audit.md) · [Launch](docs/launch.md) · [Operations](docs/operations.md)

## Devnet deployment
| | |
|---|---|
| Program | `BvYSoBvDqLGrnrMqSpPguFkApyNTTj219mLWQGnrkCGq` |
| Pool | `6WhSVqUVvjQ9ana2JAvx4gBKK2o1P7m2K6aCxeXWxCeA` |
| Mint | devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

## Repository
- `programs/goodfaith`: the on-chain program (Anchor 1.2.1)
- `app`: the web app, identity service and fee-sponsor proxy (Next.js)
- `scripts`: fork deployment, end-to-end runs, the operator and member command lines, the cranker
  ([scripts/README.md](scripts/README.md))
- `deploy`: Docker images and compose file for hosting
- `keys`: encrypted devnet keys ([keys/README.md](keys/README.md))

## Build and test
```sh
bash scripts/toolchain.sh   # Solana CLI, Anchor, Surfpool (Linux, no sudo)
anchor build --arch v2
anchor test --skip-build    # Rust LiteSVM and property tests
cd app && npm install && npm test && npm run test:svm
```
The full end-to-end run uses a local Surfpool fork of devnet: see [scripts/README.md](scripts/README.md). CI
([ci.yml](.github/workflows/ci.yml)) runs all of it on `main`.

## Licence
Proprietary. Copyright (c) 2026 Kiarash Adl. All rights reserved. The source is published to be read and checked,
not reused; see [LICENSE](LICENSE).
