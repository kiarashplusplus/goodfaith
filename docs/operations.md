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
| recovery | a keypair file on the operator's machine, read by `npm run recovery` (`RECOVERY_KEYPAIR`); never the web service, which only prepares proposals | `schedule --set recoveryAuthority=<key>` |
| gatekeeper | the identity service's environment | add a new gatekeeper to the network (`ensureGatekeeper`), swap `GATEKEEPER_SECRET` |
| fingerprint keys | the identity service's environment | `PERSON_HASH_SECRETS="2:new,1:old"`, drop the old key once members have re-verified |
| sponsor | Kora's signer (Turnkey or Privy in hosting) | fund it; rotate by starting Kora with a new signer and topping it up |
| cranker | any funded key, or none with Kora paying | replace the file |

Back up: the identity store (the only link between people and memberships), `PERSON_HASH_SECRETS`, the gatekeeper
network keypair, and `launch-result.json`. Without the store the fingerprints are useless; without the keys the store
is.

## The cranker

`npm run cranker -- --interval 300` (or `--once` from cron every few minutes). Each pass, in order: applies a settings
change whose notice period has passed; settles loans past the cutoff and posts the barred people, with the end of
their bar, to the identity service (`/api/identity/ban`); collects what settled loans owe the fund from their escrows
into the vault (`collected`); releases what co-signers are owed, from escrows and from the vault (creating their
token account at the fund's expense when it is missing; `claims` in the report says so); closes expired requests;
finalises recoveries whose delay has passed; sweeps the vault, less what co-signers are owed from it, to the
successor once a wind-down is in effect with no loan open. `--dry-run` prints what is due without sending.
Everything it does is permissionless: when it is down, members can do each step from the app or `npm run member`,
and `npm run admin -- apply` applies a due change.

Watch its report (one line per kind) and its `errors`. A recurring error on one loan usually means a frozen account
(a frozen escrow fails `collect` and the escrow part of the claim each pass until it thaws; the entitlements stay
recorded, nothing is written off) or an RPC problem.

## The two brakes

- **Pause** (`npm run admin -- pause`, by the pause key or the authority): new requests and co-signs stop at once;
  repayments, defaults, releases, recoveries and donations continue. Use it the moment something looks wrong: a
  burst of new memberships, loans to people nobody knows, a provider incident, a bug report. Resuming needs the
  authority (`resume`), so a pause is cheap to pull and deliberate to undo.
- **Suspend the issuer** (`suspend-issuer`): no new memberships or recovery proposals until a new issuer is scheduled
  and applied after the notice period. Use it when the issuer key or the identity service may be compromised.
  Members keep borrowing, co-signing and repaying.

An incident playbook: pause; suspend the issuer if the identity layer is in doubt; read `admin show` (window
disbursed, outstanding principal against the ceiling, active loans, what is owed to whom) and the recent
`MemberRegistered`, `LoanOpened`, `RebindProposed` events; veto any recovery you cannot explain (`veto_rebind` by the
authority; `member veto` for the old wallet); schedule the key rotations; resume when the cause is understood.
`docs/economics.md` (stress table) gives the loss under stated containment times: the figure that matters is how
long this playbook takes, so rehearse it and write the time down. The pause key should be reachable at all hours
for that reason.

## Recovery requests

A member who lost their wallet verifies from a new one; the service records the request (status `review`) and sends
a notice to the member's contact. The operator runs `cd scripts && npm run recovery -- list` (env: `IDENTITY_URL`,
`IDENTITY_ADMIN_KEY`, `RECOVERY_KEYPAIR`, `RPC_URL`): each line is a request with the person id, the new wallet, when
it was asked, the current wallet, any move already pending, any bar, and whether a contact is on file. Before
approving, check that the notice went out (or reach the member another way), that nothing about the request looks
off (a wallet that just verified, a person with a loan due, a burst of requests), and wait a day where you can.
`approve <personId>` signs and sends the proposal (the service prepared it with the issuer's signature; this machine
adds the recovery key's) and tells the member; `reject <personId>` turns it down and tells them. On chain the old
wallet (or the authority) can veto for `recovery_delay_seconds`; the app shows the old wallet that a move is pending.
Then the cranker, or the member, finalises. Watch `RebindProposed` events: a proposal you did not approve means the
recovery key file is compromised; veto it and rotate the recovery authority.

## Settings changes

`npm run admin -- schedule --set <field>=<value> ...` (base units and seconds; `permanent` for a bar that never
expires), then anyone applies after the notice period (`apply`, or the cranker). `admin show` lists the pending
change and when it applies; `cancel-params` withdraws it. Announce changes to members in plain words before they
apply; the app shows the pending change and its time. The notice period can never be scheduled below two days once
the pool runs with at least that much.

## Settlements, pay-backs and fairness

The program settles money without anyone's discretion, and there is one path after the cutoff: settle, then pay
back. A borrower who pays back the whole shortfall has their bar relaxed to the late bar from the settlement by the
program itself, and the co-signer's bar lifts once none of the loans they guaranteed has a loss outstanding. What is
left to the operator is the bar that should not have been set at all, or should end sooner:

- **An outage across cutoffs.** Publish which cutoffs it covered. For each affected borrower who pays back promptly,
  `npm run admin -- lift-bar <personAccount> <reason words>`: the hash of the reason goes on chain in `BarLifted`, the
  CLI prints the hash, and you publish the reason beside it so anyone can check. The CLI also tells the identity
  service (`until=0`) so the person's record follows.
- **An appeal.** The member writes; the operator answers in a set time (say ten days) with one of: no change, lift
  the bar (as above), or schedule different durations for future loans where a pattern shows they are wrong. While
  barred, a member keeps every right but new loans and guarantees: repaying, paying back, collecting what they are
  owed, recovering a lost wallet and donating all work.
- **Reinstatement** after a bar ends needs nothing from the operator: eligibility returns on the chain's clock, and
  the identity service's record lapses with it. A person whose permanent bar was lifted verifies from a new wallet
  and recovers, because a revoked pass cannot be re-issued.

Keep a written log of every lift with its hash; `disputes` in the economics model is the time this takes, and the
outage row counts the review.

## Wind-down

`announce-wind-down <successor token account>` (a token account of the pool mint not controlled by the pool: the
next version's vault, or a charity's account). After the notice period no new loans or donations are taken; open
loans run their course; loans past their cutoff still settle and are paid back; everything owed is still collected;
members can still recover a wallet. When `active loans` reaches zero the cranker (or `admin sweep`) moves the
balance, less what co-signers are owed from the vault, to the successor; what sits in escrow accounts is collected
before or after, and a recovery collected later is swept by a later sweep. Nobody's entitlement is written off by a
wind-down. `cancel-wind-down` works only before the announcement takes effect. Freezing the pool (`freeze --yes`) is
irreversible and leaves the fund without an administrator: do not freeze a fund that may need a pause, a lifted bar
or a wind-down it has not announced.

## The upgrade authority during the pilot

The program is upgradeable until the exit criteria are met, and during that time the upgrade authority overrides
every other guarantee, so it is run as the most constrained key of all:

- **Who**: a multisig of independent people, distinct from the pool authority, with its members and threshold
  published in the white paper's appendix.
- **Delay**: every upgrade is queued for seven days (the same as the notice period) before it can execute; the
  queued program hash is visible on chain and announced to members with the reason.
- **Cancellation**: the same multisig can cancel a queued upgrade at any time before it executes.
- **Observability**: the deployed program hash is published with each release; `solana program dump` of the account
  must match it (white paper appendix).
- **Exit criteria**, published and checked off in public: an independent audit with its findings closed; two full
  loan cycles of the pilot without a program change forced by a bug; the open legal questions answered. Then
  `solana program set-upgrade-authority --final`, and from there a bug means a new version and a wind-down into it.

## Monitoring

- `/api/health`: config problems (including a recovery key found on the web service), RPC, pool (paused, winding
  down, active loans, outstanding principal, the three entitlement totals, scheduled change), sponsor liveness,
  identity configuration and where notices go.
- Kora's metrics (port 8081): the sponsor's balance; alert well above the rent of a first co-sign (about 0.007 SOL)
  times the daily volume.
- Events: `LoanSettled` (how often, how much lost), `Restituted` (how much comes back, how fast), `BarLifted`
  (every one should have a published reason), `RebindProposed` (every one should match an approval in the recovery
  CLI), `LendingPaused`, `ParamsScheduled`.
- The economics inputs to measure: default rate per cohort, share repaid before a settlement and paid back after
  one, cycle length, loans per borrower, identity approval rate and cost, sponsor spend per loan, support hours
  per loan and per settlement reviewed, time from incident to pause. Feed them back into `scripts/launch.json` and
  `app/src/lib/economics.ts`.
