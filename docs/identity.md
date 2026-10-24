# Identity service

How Good Faith tells people apart, what it stores, and what happens when a credential changes, a wallet is lost, or
a key has to be rotated. The service lives in `app/src/lib/identity` behind `/api/identity/*`; the on-chain rules it
feeds are in `docs/spec.md`.

## What a person is

A **person** is an opaque 32-byte id the service draws at random the first time a credential is approved. That id
seeds the on-chain `Person` account and is the only identity-related value that ever reaches the chain. Nothing on
chain can be traced back to a document, a name or a date of birth.

A **credential** is one government ID the provider verified. The service keeps a keyed fingerprint of it:
`HMAC-SHA256(key, "goodfaith/person/v1|STATE|ID_NUMBER|BIRTHDATE")` over normalised fields (upper case, punctuation
removed, digits only for the date). The name, address, photo and selfie are never stored; the provider holds the
documents under its own retention policy. Several credentials can point at one person (a renewal, a passport added
to a licence). The fingerprint is what makes the same human resolve to the same person on a later check.

The store (`store.ts`) therefore has: `persons` (id, first wallet, ban time), `credentials` (fingerprint, key
version, person, when and how it was attached), `wallets` (every wallet that started a check, its status and the
person it resolved to), `recoveries` (wallet-recovery requests under review), `sponsorship` (per-wallet sponsor
counters) and `events` (provider event ids already handled). SQLite in a single-instance deployment, Postgres for
anything else (`IDENTITY_DB_URL`, Phase 6), memory in tests.

## Verification

1. The wallet signs a dated message proving control (`wallet-proof.ts`) and `start` opens a hosted check with the
   provider (Persona in production, a mock on test networks).
2. The provider's webhook reports the outcome. On approval the service reads the verified fields, enforces Texas and
   18+, and computes the fingerprint under every key in the keyring (newest first).
3. A known fingerprint resolves to its person; an unknown one creates a person. A banned person is refused. A wallet
   that already belongs to one person and verifies as another is refused (one wallet, one person).
4. A gateway token (the pass the program checks) is issued to the wallet on the fund's gatekeeper network, and the
   wallet record becomes `issued`. The pass expires after a year; verifying again renews it.

**Duplicate detection reduces abuse; it does not prove uniqueness.** A person holding two documents the service has
never seen together can hold two memberships until the documents are linked or the provider's own duplicate
detection flags them. The on-chain exposure limits, first-loan caps and cooldowns bound what that is worth.

## Linking a credential

A member whose document was renewed, or who wants a second document recognised, calls `link` from their verified
wallet (proof of control as in `start`) and completes a fresh check. The new fingerprint is attached to the same
person (`via = link`). If it already belongs to another person the link is refused and nothing changes. A declined
link leaves the existing pass untouched.

## Key rotation

Fingerprint keys are versioned. `PERSON_HASH_SECRETS="2:new-secret,1:old-secret"` lists them newest first;
`PERSON_HASH_SECRET` alone is version 1. On a check the service tries every key; a match under an old key re-links
the person under the current key (`via = rotate`), so after a rotation people migrate on their next check and the
old key can be dropped once the credentials table shows no remaining version-1 rows that matter. Rotating without
listing the old key orphans every person: they would become new people with fresh memberships, which the on-chain
caps and cooldowns would treat as new members. Keep the old key listed until the migration is done.

## Wallet recovery

Losing a wallet must not mean losing a membership, and recovering one must not be a way to take one over. The flow:

1. The person verifies from the new wallet; it resolves to their existing person, and `status` says `recover`.
2. `rebind` records a **recovery request** on the service. For `RECOVERY_REVIEW_SECONDS` the request waits (status
   `review`); the operator can look at it, and the wallet can withdraw it (`DELETE /api/identity/rebind`). One request
   per person at a time.
3. After the review the same call returns `propose_rebind`, signed by the issuer and by the recovery authority
   (`RECOVERY_SECRET`; a service without it cannot propose). The new wallet signs and sends it.
4. On chain the proposal waits `recovery_delay_seconds`. The old wallet (or the pool authority) can veto it at any
   time during the delay; `status` shows the old wallet nothing is wrong meanwhile, and it keeps working.
5. After the delay anyone finalises: the new wallet from the app (`finalize`, paying its own fee) or the cranker. The
   old wallet's member account is retired; loans, guarantees, eligibility and pending escrow claims follow the person.
   The recovered membership sits on the first-loan cap for `cooldown_seconds`.

A compromised issuer key alone cannot move a membership (the recovery key must also sign), cannot skip the delay, and
cannot stop the old wallet's veto. A compromised recovery key alone cannot propose either. Both keys live in the
identity service's environment but should be held by different people where the deployment allows it.

## Bans

When a loan defaults with a loss, the program bars the borrower (and the co-signer) for the configured durations;
that is the eligibility that matters. The cranker also calls `ban`, which marks the person in the store, revokes
the passes of every wallet the person verified with, and refuses future checks for that person, so they cannot
re-verify onto a fresh wallet while barred. Bans in the store are currently permanent; the on-chain bar expires on
its own.

## Operations

- **Keys**: `ISSUER_SECRET` (the pool's issuer), `RECOVERY_SECRET` (the pool's recovery authority), `GATEKEEPER_SECRET`
  (a gatekeeper on the fund's network), `PERSON_HASH_SECRETS`. Each is a separate key with a separate job; losing the
  issuer or recovery key means scheduling a replacement through the pool's timelock, losing the gatekeeper key means
  adding a new gatekeeper to the network, losing the fingerprint key means every person has to re-verify as new.
- **Backups**: the store is the only link between people and memberships. Back it up with the keys; without the
  fingerprint keys the credentials table is useless, without the store the keys are.
- **Disaster**: a leaked fingerprint key allows an attacker who also has the normalised ID fields of a person to
  compute their fingerprint, which reveals whether that person is a member. Rotate (keep the old key listed until
  people have re-verified), and tell members. Fingerprints never reach the chain, so nothing public changes.
- **Fallback**: `scripts/member.ts` lets any member act from the command line against the RPC alone when the app or
  the sponsor is down; the identity routes are only needed to join and to recover.

## What the service cannot do

It cannot move money, open or close loans, change pool settings, or bar someone on chain. It decides who may join and
co-signs recovery proposals; everything else is the program's.
