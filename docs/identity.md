# Identity service

How Good Faith tells people apart, what it stores, and what happens when a credential changes, a wallet is lost, or
a key has to be rotated. The service lives in `app/src/lib/identity` behind `/api/identity/*`; the on-chain rules it
feeds are in `docs/spec.md`.

## What a person is

A **person** is an opaque 32-byte id the service draws at random the first time a credential is approved. That id
seeds the on-chain `Person` account and is the only identity-related value that ever reaches the chain. The id
carries nothing from the document, the name or the date of birth; it is not anonymous, though: the chain shows what
the id did (wallets, loans, guarantees, bars), anyone who knows a person's wallet can read that history, and the
service can always link the id back to its record.

A **credential** is one government ID the provider verified. The service keeps a keyed fingerprint of it:
`HMAC-SHA256(key, "goodfaith/person/v1|STATE|ID_NUMBER|BIRTHDATE")` over normalised fields (upper case, punctuation
removed, digits only for the date). The name, address, photo and selfie are never stored; the provider holds the
documents under its own retention policy. Several credentials can point at one person (a renewal, a passport added
to a licence). The fingerprint is what makes the same human resolve to the same person on a later check.

The store (`store.ts`) therefore has: `persons` (id, first wallet, the bar mirrored from the chain with its end,
an optional contact), `credentials` (fingerprint, key version, person, when and how it was attached), `wallets`
(every wallet that started a check, its status and the person it resolved to), `recoveries` (wallet-recovery
requests waiting for the operator), `sponsorship` (per-wallet sponsor counters and the fund-wide daily budget rows)
and `events` (provider event ids already handled). SQLite in a single-instance deployment, Postgres for
anything else (`IDENTITY_DB_URL`, Phase 6), memory in tests.

## Verification

1. The wallet signs a dated message proving control (`wallet-proof.ts`) and `start` opens a hosted check with the
   provider (Persona in production, a mock on test networks).
2. The provider's webhook reports the outcome. On approval the service reads the verified fields, enforces Texas and
   18+, and computes the fingerprint under every key in the keyring (newest first).
3. A known fingerprint resolves to its person; an unknown one creates a person. A person barred for good is
   refused; a person under a time-bounded bar is not (the chain refuses their loans and guarantees; a pass lets them
   recover a lost wallet and collect what they are owed meanwhile). A wallet that already belongs to one person and
   verifies as another is refused (one wallet, one person). A contact given at `start` is kept on the person.
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

1. The person verifies from the new wallet; it resolves to their existing person, and `status` says `recover`. A
   barred person may do this too: the bar is on the person, and the new wallet is how they reach what they are owed.
2. `rebind` records a **recovery request** on the service (202, status `review`) and sends a notice to the person's
   contact. The wallet can withdraw it (`DELETE /api/identity/rebind`). One request per person at a time.
3. The operator reviews it with the recovery CLI (`cd scripts && npm run recovery -- list`), which reads
   `GET /api/identity/recoveries` (admin key): the request beside the chain's view of the person (current wallet, any
   pending move, any bar, whether a contact is on file). `approve <personId>` asks the service for the
   `propose_rebind` transaction built for the recovery key as fee payer and signed by the issuer
   (`POST /api/identity/recoveries/:personId {feePayer}`), adds the recovery authority's signature from
   `RECOVERY_KEYPAIR` (a file on the operator's machine; the web service never has it), sends it, and reports the
   signature back so the member is told about the veto window. `reject <personId>` turns the request down and tells
   the member. The service refuses to prepare a proposal for a fee payer that is not the pool's recovery authority, for
   a person with a move already pending, or when the pool names another issuer.
4. On chain the proposal waits `recovery_delay_seconds`. The old wallet (or the pool authority) can veto it at any
   time during the delay; `status` shows the old wallet that a move is pending, and it keeps working.
5. After the delay anyone finalises: the new wallet from the app (`finalize`, paying its own fee) or the cranker. The
   old wallet's member account is retired; loans, guarantees, eligibility and pending claims follow the person. The
   recovered membership sits on the first-loan cap for `cooldown_seconds`.

Compromise, key by key. The issuer key alone cannot move a membership (the recovery key must also sign), cannot skip
the delay, and cannot stop the old wallet's veto. The recovery key alone cannot propose either: it only ever signs
what the issuer signed first. The whole web service (issuer and gatekeeper keys, the store) can prepare proposals
and issue passes, and still cannot propose a move until the operator signs; the operator's check in step 3 is the
control, and the notice to the member's contact is the second pair of eyes that does not depend on the app. The
two keys live in different places by construction: the issuer in the service's environment, the recovery key in a
file the CLI reads.

## Bars

When a loan is settled after its deadline, the program bars the borrower (and the co-signer, when the fund lost
money) for the durations fixed into the loan at opening; that is the eligibility that matters, and it follows the
person across wallets. The cranker mirrors it to the service (`POST /api/identity/ban {personId, until}`):

- a **time-bounded bar** is recorded with its end and revokes nothing: the chain refuses the person's loans and
  guarantees, their passes stay so they can recover a wallet and collect what they are owed, and the record lapses
  when the chain's bar does;
- a **permanent bar** (`until` absent or the chain's maximum) revokes the passes of every wallet the person verified
  with and refuses future checks, so the person cannot come back on a fresh wallet;
- `until` in the past **lifts** the record (the admin CLI sends this after `lift-bar`; a restitution that relaxed a
  bar is picked up on the cranker's next pass).

Each change sends a notice to the person's contact. A person whose permanent bar is lifted verifies from a new wallet
(a revoked pass cannot be re-issued) and recovers.

## Notices

`notify.ts` sends one message per event (recovery requested, proposed, rejected; barred; bar lifted) to the server
log, or as a JSON POST to `NOTIFY_WEBHOOK_URL` when set (an operator points it at a mail or messaging relay). The
body carries the person id, the wallet concerned, the contact when one is on file, a one-sentence detail and the
figures (an end date, a signature). A failed webhook falls back to the log, so nothing is dropped silently. The
contact is optional, given at `start`, never shown or forwarded elsewhere.

## Operations

- **Keys**: `ISSUER_SECRET` (the pool's issuer) and `GATEKEEPER_SECRET` (a gatekeeper on the fund's network) in the
  web service; `RECOVERY_KEYPAIR` (the pool's recovery authority) on the operator's machine for `npm run recovery`,
  never in the web service (`/api/health` reports it as a problem when `RECOVERY_SECRET` is set); `PERSON_HASH_SECRETS`
  in the web service. Each is a separate key with a separate job; losing the issuer or recovery key means scheduling
  a replacement through the pool's timelock, losing the gatekeeper key means adding a new gatekeeper to the network,
  losing the fingerprint key means every person has to re-verify as new.
- **Backups**: the store is the only link between people and memberships. Back it up with the keys; without the
  fingerprint keys the credentials table is useless, without the store the keys are.
- **Disaster**: a leaked fingerprint key allows an attacker who also has the normalised ID fields of a person to
  compute their fingerprint, which reveals whether that person is a member. Rotate (keep the old key listed until
  people have re-verified), and tell members. Fingerprints never reach the chain, so nothing public changes.
- **Fallback**: `scripts/member.ts` lets any member act from the command line against the RPC alone when the app or
  the sponsor is down; the identity routes are only needed to join and to recover.

## What the service cannot do

It cannot move money, open or close loans, change pool settings, bar or unbar someone on chain, or move a membership
without the operator's recovery key. It decides who may join, prepares recovery proposals for the operator to sign,
and keeps a mirror of the chain's bars; everything else is the program's.
