# Operations

Running the fund day to day: who holds which key, what the scheduled job does, how to use the two brakes, how a
recovery or a dispute is handled, and how the fund is retired. The program enforces most of this; this note is about
the parts people do. `docs/launch.md` is the one-time setup; `docs/identity.md` the identity service in depth.

## Keys and people

| key | custody | rotation |
|---|---|---|
| pool authority | a multisig of independent people (not all employees of one organisation); its threshold is the fund's governance | `propose-authority` from the old, `accept_authority` from the new |
| program upgrade authority | a second, separate multisig behind a timelock during the pilot; removed afterwards | `solana program set-upgrade-authority` |
| pause | one trusted person, reachable at all hours; can only stop new lending | `schedule --set pauseAuthority=<key>` (notice period) |
| issuer | the identity service's environment | `suspend-issuer` at once, then `schedule --set issuer=<key>`; the service needs the new `ISSUER_SECRET` when the change applies |
| recovery | the identity service's environment, held by a different person than the issuer's where possible | `schedule --set recoveryAuthority=<key>` |
| gatekeeper | the identity service's environment | add a new gatekeeper to the network (`ensureGatekeeper`), swap `GATEKEEPER_SECRET` |
| fingerprint keys | the identity service's environment | `PERSON_HASH_SECRETS="2:new,1:old"`, drop the old key once members have re-verified |
| sponsor | Kora's signer (Turnkey or Privy in hosting) | fund it; rotate by starting Kora with a new signer and topping it up |
| cranker | any funded key, or none with Kora paying | replace the file |

Back up: the identity store (the only link between people and memberships), `PERSON_HASH_SECRETS`, the gatekeeper
network keypair, and `launch-result.json`. Without the store the fingerprints are useless; without the keys the store
is.

## The cranker

`npm run cranker -- --interval 300` (or `--once` from cron every few minutes). Each pass, in order: applies a settings
change whose notice period has passed; marks loans past the cutoff as defaulted and posts the barred people to the
identity service (`/api/identity/ban`) so their passes are revoked; releases escrow owed to co-signers of closed
loans (creating their token account at the fund's expense when it is missing; `claims` in the report says so);
closes expired requests; finalises recoveries whose delay has passed; sweeps the vault to the successor once a
wind-down is in effect with no loan open. `--dry-run` prints what is due without sending. Everything it does is
permissionless: when it is down, members can do each step from the app or `npm run member`, and `npm run admin --
apply` applies a due change.

Watch its report (one line per kind) and its `errors`. A recurring error on one loan usually means a frozen token
account (the claim retries each pass until the account exists or thaws) or an RPC problem.

## The two brakes

- **Pause** (`npm run admin -- pause`, by the pause key or the authority): new requests and co-signs stop at once;
  repayments, defaults, releases, recoveries and donations continue. Use it the moment something looks wrong: a
  burst of new memberships, loans to people nobody knows, a provider incident, a bug report. Resuming needs the
  authority (`resume`), so a pause is cheap to pull and deliberate to undo.
- **Suspend the issuer** (`suspend-issuer`): no new memberships or recovery proposals until a new issuer is scheduled
  and applied after the notice period. Use it when the issuer key or the identity service may be compromised.
  Members keep borrowing, co-signing and repaying.

An incident playbook: pause; suspend the issuer if the identity layer is in doubt; read `admin show` (window
disbursed, active loans, pending claims) and the recent `MemberRegistered`, `LoanOpened`, `RebindProposed` events;
veto any recovery you cannot explain (`veto_rebind` by the authority; `member veto` for the old wallet); schedule the
key rotations; resume when the cause is understood. `docs/economics.md` (stress table) says what the caps bound the
loss to in the meantime.

## Recovery requests

A member who lost their wallet verifies from a new one; the service holds the request for `RECOVERY_REVIEW_SECONDS`
(status `review`). The operator sees the request in the store (`recoveries`) and may withdraw it or let it proceed;
after the review the member's new wallet gets the proposal, signed by the issuer and the recovery key. On chain the
old wallet (or the authority) can veto for `recovery_delay_seconds`; the app shows the old wallet that a move is
pending. Then the cranker, or the member, finalises. Watch `RebindProposed` events: a proposal for a member who did
not ask for one is the signal that both service keys are compromised; veto it and rotate.

## Settings changes

`npm run admin -- schedule --set <field>=<value> ...` (base units and seconds; `permanent` for a bar that never
expires), then anyone applies after the notice period (`apply`, or the cranker). `admin show` lists the pending
change and when it applies; `cancel-params` withdraws it. Announce changes to members in plain words before they
apply; the app shows the pending change and its time. The notice period can never be scheduled below two days once
the pool runs with at least that much.

## Defaults, late repayments and fairness

The program settles money without anyone's discretion. What the operator decides is how to treat people the program
barred: a borrower marked late because the network or the service was down across their cutoff, a co-signer barred
because a borrower vanished. The program cannot shorten a bar, so the remedies are: say publicly which cutoffs an
outage covered; take it into account when the member asks for a larger cap later (the cap is a program rule, so this
means talking to them, not changing their record); and, where a pattern shows the bar durations are wrong, schedule
different ones. Keep a written log of these decisions; `disputes` in the economics model is the time this takes.

## Wind-down

`announce-wind-down <successor token account>` (a token account of the pool mint not controlled by the pool: the
next version's vault, or a charity's account). After the notice period no new loans or donations are taken; open
loans run their course; escrows are still released; members can still recover a wallet. When `active loans` reaches
zero the cranker (or `admin sweep`) moves the balance to the successor; `pending claims` never block it because they
sit in escrow accounts. `cancel-wind-down` works only before the announcement takes effect. Freezing the pool
(`freeze --yes`) is irreversible and leaves the fund without an administrator: do not freeze a fund that may need a
pause or a wind-down it has not announced.

## Monitoring

- `/api/health`: config problems, RPC, pool (paused, winding down, active loans, pending claims, scheduled change),
  sponsor liveness, identity configuration.
- Kora's metrics (port 8081): the sponsor's balance; alert well above the rent of a first co-sign (about 0.007 SOL)
  times the daily volume.
- Events: `LoanDefaulted` (how often, how much lost), `RebindProposed` (every one should match a request in the
  store), `LendingPaused`, `ParamsScheduled`.
- The economics inputs to measure: default rate per cohort, share repaid before default, cycle length, identity
  approval rate and cost, sponsor spend per loan, support hours. Feed them back into `scripts/launch.json` and
  `app/src/lib/economics.ts`.
