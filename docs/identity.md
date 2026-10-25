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
a contact, required for new checks), `credentials` (fingerprint, key version, person, when and how it was attached), `wallets`
(every wallet that started a check, its status and the person it resolved to), `recoveries` (wallet-recovery
requests: when opened, whether the notice reached the member, when the operator proposed it and how it closed),
`sponsorship` and `sponsor_budget` (the per-wallet and fund-wide sponsor counters, reserved atomically) and `events`
(provider event ids already handled). SQLite in a single-instance deployment, Postgres for
anything else (`IDENTITY_DB_URL`, Phase 6), memory in tests.

## Verification

1. The wallet signs a dated message proving control (`wallet-proof.ts`) and `start` opens a hosted check with the
   provider (Persona in production, a mock on test networks). The message's first line names its purpose: "Good Faith
   identity check" for start, link, rebind, renew and contact; "Good Faith status" only for reading a check's
   details. A proof for one purpose is refused for the other, so a status signature can never start a check (which
   is what attaches an identity to a wallet). Both are valid for five minutes.

   `GET /api/identity/status?wallet=` answers anyone (the Join page polls it) with what the chain shows anyway:
   membership, pass, bars, a pending move, `next`. It leaves out the check's `reason` (which can say a person's age
   or state) and a pending check's one-time `url`, and sets `detailsHidden`. `POST /api/identity/status` with the
   wallet's "status" proof returns them too.
2. The provider's webhook reports the outcome. On approval the service reads the verified fields, enforces Texas and
   18+, and computes the fingerprint under every key in the keyring (newest first).
3. A known fingerprint resolves to its person; an unknown one creates a person. A person barred for good is
   refused; a person under a time-bounded bar is not (the chain refuses their loans and guarantees; a pass lets them
   recover a lost wallet and collect what they are owed meanwhile). A wallet that already belongs to one person and
   verifies as another is refused (one wallet, one person). A contact given at `start` is kept on the person only when
   the person has none yet: a second wallet verifying later can never replace where the member's notices go.
4. A gateway token (the pass the program checks) is issued to the wallet on the fund's gatekeeper network, and the
   wallet record becomes `issued`. The pass expires after a year.

## Renewal and contact

The pass is renewed without a new paid check: `renew` (`POST /api/identity/renew`, the wallet's dated signature as in
`start`) moves the expiry of the member's token another `tokenTtlSec` out when the wallet is the one linked to the
membership, the person is not barred for good in the store and not barred on chain right now (a barred member renews
once the bar ends). `status` reports the pass (`pass.expiresAt`, `pass.state`) and says `next: "renew"` when it
expires within thirty days; the app shows a button. A member's contact changes only through the wallet currently
linked to the membership (`POST /api/identity/contact`, signed), and the previous contact is told about the change, so
taking over a wallet cannot silently redirect the notices that protect it.

**The contact is required.** Members sign in with Turnkey, where the email is the way back in on a new device, so
every member has one: sign-in is an emailed code (the only method on in the Turnkey dashboard), and the app asks any older account without one to add a verified email before anything but repaying, and
sends it as `contact` when the check starts. `start` and `contact` refuse a missing or malformed email (400); the
contact can be changed, not removed. The store still allows a person without one (records from before this rule, or
an email the operator removed at the member's request when closing the membership). The service does not yet check
that the contact is the Turnkey-verified email; reading it from the member's sub-organisation needs a parent-org API
key on the server.

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

Members' wallets are Turnkey sign-in wallets (`app/README.md`), signed into with a code sent to the member's email. This
flow is for a wallet that is truly gone: the email account lost, or the wallet's key leaked.

Losing a wallet must not mean losing a membership, and recovering one must not be a way to take one over. The flow:

1. The person verifies from the new wallet; it resolves to their existing person, and `status` says `recover`. A
   barred person may do this too: the bar is on the person, and the new wallet is how they reach what they are owed.
2. `rebind`, signed by the new wallet (the dated proof as in `start`: nobody can open a request in someone else's
   name), records a **recovery request** on the service (202, status `review`) and sends a notice to the contact on
   file from before the request and, when it differs, to the contact the requesting wallet gave. Whether the channel
   took the notice is recorded on the request (`delivery`); a failed one is sent again on the cranker's next pass.
   The wallet can withdraw the request (`DELETE`, signed) until the operator proposes it. One request per person at a
   time; a closed request stays as history (`closedAs`: finalized, vetoed, rejected, withdrawn or barred).
3. The operator reviews it with the recovery CLI (`cd scripts && npm run recovery -- list`), which reads
   `GET /api/identity/recoveries` (admin key): the request beside the chain's view of the person (current wallet, any
   pending move, any bar, whether the notice went out). `approve <personId> <newWallet>` names the wallet the operator
   checked. Before anything is prepared, the CLI gathers evidence the service does not control (see "Whom to
   approve" below) and refuses to sign without `--checked`. It then asks the service for the `propose_rebind` transaction built for the recovery key as fee payer and signed
   by the issuer (`POST /api/identity/recoveries/:personId {feePayer, newWallet, force?}`). The service refuses a
   wallet that is not the recorded one, a request already proposed, a request younger than `RECOVERY_MIN_AGE_SECONDS`
   (one day by default: the member gets time to see the notice) or one whose notice failed, the last two unless the
   operator passes `--force`, a fee payer that is not the pool's recovery authority, a person with a move already
   pending, or a pool that names another issuer. The CLI then decodes the transaction and signs only if it is exactly
   one instruction: the Good Faith `propose_rebind` for that person account and that new wallet on this pool, with no
   signer but the issuer and this key and this key as fee payer; it prints what it saw. It adds the recovery
   authority's signature from `RECOVERY_KEYPAIR` (a file on the operator's machine, required, never a default path
   shared with other keys; the web service never has it), sends it, and reports the signature back so the request is
   marked proposed and the member is told about the veto window. `reject <personId>` turns the request down and tells
   the member.
4. On chain the proposal waits `recovery_delay_seconds`. The old wallet (or the pool authority) can veto it at any
   time during the delay; `status` shows the old wallet that a move is pending, and it keeps working.
5. After the delay anyone finalises: the new wallet from the app (`finalize`, paying its own fee) or the cranker. The
   old wallet's member account is retired; loans, guarantees, eligibility and pending claims follow the person. The
   recovered membership sits on the first-loan cap for `cooldown_seconds`. While a move is pending, what the person is
   owed as a co-signer waits (the program refuses `claim_escrow`), so a lost wallet is never paid. The cranker's
   reconciliation pass closes the request as finalized or vetoed from what the chain shows.

The program adds a floor the service cannot move: after the pool's issuer, recovery key or gatekeeper network changes
(a timelocked settings change), no recovery can be proposed for seven days (`KeysRecentlyChanged`), and the recovery
delay can never be scheduled below one day.

**Whom to approve.** The CLI's decoding settles *what* the recovery key signs. *Whom* it is right to approve cannot
rest on the web service alone, because a compromised service controls its store, its contact records, its recovery
history and its notice machinery: it could show a request as aged and notified when it was neither, or show a contact
it had swapped. So the operator checks three things outside it before `approve ... --checked`:

- **The verification, at the provider.** The CLI reads the new wallet's inquiry straight from the identity provider
  with the operator's own API key (`PERSONA_API_KEY` on the operator's machine; a read-only key where the provider
  offers one) and refuses unless it is approved and bound (by its reference id) to the wallet being approved. Without
  the key it prints the inquiry id for the operator to look up by hand.
- **The contact, from the operator's own copy.** Every notice, including `contact_changed`, reaches the relay
  (`NOTIFY_WEBHOOK_URL`) with the contact it was sent to, so the relay's records, and a periodic export the operator
  keeps off the web service, hold a contact history the service cannot rewrite afterwards. The contact the request's
  notice went to must match that history from before the request.
- **The delivery, from the relay.** Whether the notice was delivered is read from the mail or message relay's own
  log or dashboard, not from the service's `delivery` flag.

When any of these fails, the operator does not approve, and reaches the member another way.

**A stolen old wallet.** The old wallet's veto is unconditional: it is what stops a fraudulent recovery, and the
program has no way to tell a member who lost a wallet from a thief who took it. A thief who holds the old wallet can
therefore veto every recovery. The policy for the pilot:
- the gatekeeper freezes the stolen wallet's pass, so it can take no new loan or guarantee;
- the case goes to the administrator as an appeal, with the evidence the operator gathered;
- the member keeps every right that does not need that wallet: what they owe can be paid back from any wallet, and a
  loan they borrowed or guaranteed runs its course.
What remains: the thief can still release to the stolen wallet what the person is owed as a co-signer, and can keep
vetoing. A program path that lets the administrator override a veto after a longer delay would close that, at the
price of more power for the administrator; it is not built, and the paper says so.

Compromise, key by key. The issuer key alone cannot move a membership (the recovery key must also sign), cannot skip
the delay, and cannot stop the old wallet's veto. The recovery key alone cannot propose either: it only ever signs
what the issuer signed first, and only after checking it is the one instruction it was told to expect. The whole web
service (issuer and gatekeeper keys, the store) can prepare proposals and issue passes, and still cannot propose a
move until the operator signs; it cannot make the CLI sign something else (the CLI verifies the bytes). It can try
to mislead the operator about whom to approve, which is why the checks above read the provider, the operator's own
export and the relay rather than the service. The two keys live in different places by construction: the issuer in
the service's environment, the recovery key in a file the CLI reads.

## Bars

When a loan is settled after its deadline, the program bars the borrower (and the co-signer, when the fund lost
money) for the durations fixed into the loan at opening; that is the eligibility that matters, and it follows the
person across wallets. The cranker reconciles the service with the chain every pass (`POST /api/identity/reconcile
{barred: [{personId, until}]}`: every person the chain bars right now, whoever settled the loan and whatever relaxed
or lifted the bar since); `POST /api/identity/ban {personId, until}` does the same for one person (the admin CLI sends
it after `lift-bar`). Both are idempotent:

- a **time-bounded bar** is recorded with its end and freezes nothing: the chain refuses the person's loans and
  guarantees, their passes stay so they can recover a wallet and collect what they are owed, and the record lapses
  when the chain's bar does;
- a **permanent bar** (`until` absent or the chain's maximum) **freezes** the passes of every wallet the person
  verified with (the gateway token's frozen state, which the program refuses) and refuses future checks, so the
  person cannot come back on a fresh wallet;
- `until` in the past, or a bar relaxed to a date, **lifts** or relaxes the record and **thaws** passes a permanent bar
  froze; a stored bar the chain no longer has is lifted by the reconciliation pass.

Each change sends a notice to the person's contact. A permanent bar is therefore reversible: paying the fund back, or
the authority's `lift_bar`, gives the member their passes back on the wallets they had.

## Notices

`notify.ts` sends one message per event (recovery requested, proposed, rejected; barred; bar lifted; contact changed;
pass renewed) to the server log, or as a JSON POST to `NOTIFY_WEBHOOK_URL` when set (an operator points it at a mail or
messaging relay). The body carries the person id, the wallet concerned, the contact when one is on file, a
one-sentence detail and the figures (an end date, a signature). A failed webhook falls back to the log and reports
the failure; for a recovery request that outcome is stored (`delivery`), shown to the operator and retried on the
cranker's next pass. The contact is optional, given at `start` or changed from the member's wallet, never shown or
forwarded elsewhere; the relay the operator chooses sees it, which is part of the privacy statement in the paper.

## Operations

- **Keys**: `ISSUER_SECRET` (the pool's issuer) and `GATEKEEPER_SECRET` (a gatekeeper on the fund's network) in the
  web service; `RECOVERY_KEYPAIR` (the pool's recovery authority) on the operator's machine for `npm run recovery`,
  required (no shared default path) and never in the web service (`/api/health` reports it as a problem when
  `RECOVERY_SECRET` is set); `PERSON_HASH_SECRETS` in the web service; `RECOVERY_MIN_AGE_SECONDS` sets how long a
  request must have been open before the operator may propose it. Each is a separate key with a separate job; losing the issuer or recovery key means scheduling
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
without the operator's recovery key. It decides who may join, renews passes, prepares recovery proposals for the
operator to sign and verify, and keeps a mirror of the chain's bars (freezing and thawing passes for the permanent
ones); everything else is the program's.
