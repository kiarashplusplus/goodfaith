# Operations

Running the fund day to day: who holds which key, what the scheduled job does, how to use the two brakes, how a
recovery or a dispute is handled, and how the fund is retired. The program enforces most of this; this note is about
the parts people do. Two words are used precisely throughout: the **administrator** is the multisig that holds the
pool authority (settings, brakes, lifts, the wind-down); the **operator** is the organisation that runs the services,
the cranker and the recovery key day to day. `docs/launch.md` is the one-time setup; `docs/identity.md` the identity
service in depth.

## Keys and people

| key | custody | rotation |
|---|---|---|
| pool authority (the administrator) | a multisig of independent people (not all employees of one organisation); its threshold is the fund's governance | `propose-authority` from the old, `accept_authority` from the new |
| successor authority | the program upgrade multisig at launch; must co-sign a wind-down announcement, so where the money goes at the end is a two-key decision | `schedule --set successorAuthority=<key>` (notice period) |
| program upgrade authority | a second, separate multisig behind a timelock during the pilot; removed afterwards | `solana program set-upgrade-authority` |
| pause | one trusted person, reachable at all hours; can only stop new lending | `schedule --set pauseAuthority=<key>` (notice period) |
| issuer | the identity service's environment | `suspend-issuer` at once, then `schedule --set issuer=<key>`; the service needs the new `ISSUER_SECRET` when the change applies |
| recovery | a keypair file on the operator's machine, read by `npm run recovery` (`RECOVERY_KEYPAIR`, required: the CLI refuses to run on a default path); never the web service, which only prepares proposals | `schedule --set recoveryAuthority=<key>`; wallet moves are then refused for seven days (the program's quarantine) |
| gatekeeper | the identity service's environment | add a new gatekeeper to the network (`ensureGatekeeper`), swap `GATEKEEPER_SECRET` |
| fingerprint keys | the identity service's environment | `PERSON_HASH_SECRETS="2:new,1:old"`, drop the old key once members have re-verified |
| sponsor | Kora's signer (Turnkey or Privy in hosting) | fund it; rotate by starting Kora with a new signer and topping it up |
| cranker | its own funded key (`CRANKER_KEYPAIR`, required), or Kora paying the fees | replace the file |

The admin, cranker and recovery CLIs each take their key from their own variable (`ADMIN_KEYPAIR`, `CRANKER_KEYPAIR`,
`RECOVERY_KEYPAIR`) and refuse to run without it, so no two jobs share a key by accident. Floors the program keeps
whatever the administrator schedules: the notice period never below two days, the recovery delay never below one day,
a seven-day quarantine on wallet moves after any change to the issuer, the recovery key or the gatekeeper network,
and a wind-down that needs the successor authority's signature beside the administrator's.

Back up: the identity store (the only link between people and memberships), `PERSON_HASH_SECRETS`, the gatekeeper
network keypair, and `launch-result.json`. Without the store the fingerprints are useless; without the keys the store
is.

## The cranker

`npm run cranker -- --interval 300` (or `--once` from cron every few minutes; `CRANKER_KEYPAIR` set). Each pass, in
order: applies a settings change whose notice period has passed; settles loans past the cutoff; collects what settled
loans owe the fund from their escrows into the vault (`collected`); releases what co-signers are owed, from escrows
and from the vault (creating their token account at the fund's expense when it is missing; `claims` in the report says
so); closes expired requests; finalises recoveries whose delay has passed; sweeps the vault, less what co-signers are
owed from it, to the successor once a wind-down is in effect with no loan open; and reconciles the identity service
with the chain (`/api/identity/reconcile`): every person the chain bars right now with the end of their bar, whoever
settled the loan and whatever relaxed or lifted the bar since; the service lifts the stored bars the chain no longer
has, closes recovery requests the chain finalised or vetoed, and retries notices that failed. `--dry-run` prints what
is due without sending. Everything it does is permissionless: when it is down, members can do each step from the app
or `npm run member`, and `npm run admin -- apply` applies a due change.

Watch its report (one line per kind), its `waiting` line and its `errors`. `waiting` is work the pass could not do yet
and will retry: a frozen escrow (the fund's collection and the escrow part of the claim wait until it thaws; the vault
part of a claim is paid around it; nothing is written off) or a claim for a co-signer whose wallet move is pending.
`errors` is what actually failed; `--once` exits non-zero only on those, so a frozen escrow does not page anyone.

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

A member who lost their wallet verifies from a new one and signs the request from it; the service records the request
(status `review`) and sends a notice to the contact on file from before the request. The operator runs `cd scripts &&
npm run recovery -- list` (env: `IDENTITY_URL`, `IDENTITY_ADMIN_KEY`, `RECOVERY_KEYPAIR`, `RPC_URL`): each line is a
request with the person id, the new wallet, when it was asked, the current wallet, any move already pending, any bar,
and whether the notice was delivered (`notice sent`, `NOTICE FAILED`, `no contact on file`). Before approving, make
sure the notice reached the member (or reach them another way), that nothing about the request looks off (a wallet
that just verified, a person with a loan due, a burst of requests), and let it age: the service refuses to prepare a
proposal younger than `RECOVERY_MIN_AGE_SECONDS` (one day by default) or whose notice failed, unless you pass `--force`
and own that decision. Then check what the service cannot vouch for (`docs/identity.md`, "Whom to approve"): the CLI
reads the verification straight from the provider with your own `PERSONA_API_KEY`; you compare the contact with your
own export from before the request and read the notice's delivery in the relay's own log.
`approve <personId> <newWallet> --checked` names the wallet you checked; without `--checked` nothing is signed. The CLI fetches the proposal
the service prepared with the issuer's signature, decodes it, refuses anything but the one `propose_rebind` for that
person and wallet signed by nobody but the issuer and this key, prints what it saw, adds the recovery key's signature,
sends it and tells the member. A request is never proposed twice. `reject <personId>` turns it down and tells them.
On chain the old wallet (or the authority) can veto for `recovery_delay_seconds`; the app shows the old wallet that a
move is pending, and what that person is owed as a co-signer waits until the move is settled either way. Then the
cranker, or the member, finalises, and the cranker's next pass closes the request. Watch `RebindProposed` events: a
proposal you did not approve means the recovery key file is compromised; veto it and rotate the recovery authority
(after which the program refuses every move for seven days). A member whose **old wallet was stolen** cannot be
recovered while the thief vetoes: freeze that wallet's pass and take the case to the administrator as an appeal
(`docs/identity.md`).

## Settings changes

`npm run admin -- schedule --set <field>=<value> ...` (base units and seconds; `permanent` for a bar that never
expires), then anyone applies after the notice period (`apply`, or the cranker). `admin show` lists the pending
change and when it applies; `cancel-params` withdraws it. Announce changes to members in plain words before they
apply; the app shows the pending change and its time. The notice period can never be scheduled below two days once
the pool runs with at least that much.

## Settlements, pay-backs and fairness

The program settles money without anyone's discretion, and there is one path after the cutoff: settle, then pay
back. Settlement also puts the borrower back on the first-loan cap. A settled loan carries two claims: the fund's
(its loss) and the co-signer's (their used deposit); pay-backs reach the fund's first. The co-signer's bar ends at its
expiry or, earlier, as soon as the fund's loss on every loan they guaranteed is paid back, whoever pays. The
borrower's bar shortens to the late bar once both claims are settled, whoever pays. A co-signer may waive their own
claim (`npm run member -- waive <loanId>`, or the button in the app); the fund's claim stays owed. What is left to
the administrator is the bar that should not have been set at all, or should end sooner, and a fund claim that
should not be pursued:

- **An outage across cutoffs.** Publish which cutoffs it covered. For each affected borrower who pays back promptly,
  `npm run admin -- lift-bar <personAccount> <reason words>`: the hash of the reason goes on chain in `BarLifted`, the
  CLI prints the hash, and you publish the reason beside it so anyone can check. The CLI also tells the identity
  service (`until=0`) so the person's record follows. An outage costs more than the borrower's bar: the co-signer's
  deposit was used and they are barred until the borrower pays back, and the borrower lost the loan's cap credit and
  their cap steps. The remedy list is: lift the bars of both people where the outage was the cause, publish the
  reasons, and help the borrower pay back so the co-signer is made whole; the cap steps are not restored.
- **A lift keeps the count.** `lift_bar` clears a person's bars but not the number of guaranteed losses still unpaid,
  so a later loss bars the co-signer again and that bar stays until every loss, the lifted one included, is paid back;
  lift again if that is the right outcome.
- **An appeal.** The member writes; the operator answers in a set time (say ten days) with one of: no change, lift
  the bar (as above), or schedule different durations for future loans where a pattern shows they are wrong. While
  barred, a member keeps every right but new loans and guarantees: repaying, paying back, collecting what they are
  owed, recovering a lost wallet and donating all work.
- **Forgiving the fund's claim** (`npm run admin -- forgive-fund-claim <loanId> <reason words>`): for hardship or an
  error, in public with the reason's hash, like a lift. It moves no money and is not a recovery: the loss stays in
  the books (`total_lost`, with `total_forgiven` beside it), the co-signer's claim stays the borrower's to pay, no bar
  changes, and the borrower does not get the late bar. Lift bars separately if that is the right outcome.
- **Reinstatement** after a bar ends needs nothing from the operator: eligibility returns on the chain's clock, and
  the identity service's record lapses with it on the cranker's next pass. A permanent bar freezes the person's passes;
  a lift or a pay-back thaws them on the wallets they had, so nobody has to verify again to come back.

Keep a written log of every lift with its hash; `disputes` in the economics model is the time this takes, and the
outage row counts the review.

## Wind-down

`announce-wind-down <successor token account>` (a token account of the pool mint not controlled by the pool: the
next version's vault, or a charity's account), signed by the administrator and by the successor authority
(`SUCCESSOR_KEYPAIR`, or the same key on a test pool that names the administrator as both). After the notice period no new loans or donations are taken; open
loans run their course; loans past their cutoff still settle and are paid back; everything owed is still collected;
members can still recover a wallet. When `active loans` reaches zero the cranker (or `admin sweep`) moves the
balance, less what co-signers are owed from the vault, to the successor; what sits in escrow accounts is collected
before or after. Collections and pay-backs that arrive after the first sweep land in the old vault, and the cranker
sweeps again on every pass, so they follow to the successor; a pay-back's share for the co-signer is booked as owed
from the vault in the same instruction, so no sweep can take it, and escrow refunds never leave their escrow. Nobody's entitlement is written off by a
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
  down, active loans, outstanding principal, lifetime lending against its budget, recognised and forgiven losses,
  the three entitlement totals, scheduled change), sponsor liveness and each sponsor lane's use today (`alert` from
  80%), identity configuration and where notices go.
- The sponsor's three lanes (`SPONSOR_PROTECTED_DAILY_TX`, `SPONSOR_ONBOARDING_DAILY_TX` with
  `SPONSOR_DAILY_NEW_WALLETS`, `SPONSOR_DAILY_BUDGET_TX` for members): set them from the pilot's real demand, not for
  growth. The route logs a warning when a lane reaches 80% and when it runs out. Strangers exhausting onboarding do not
  touch the protected lane (settling, repaying, paying back, releasing, collecting, waiving, vetoing, finalising). The
  sponsor never pays a close, and pays rent only for members' token accounts, so its money cannot be collected back
  by closing accounts.
- The lifetime lending budget (`max_total_lent`): review before raising it. Track realised losses (`total_lost`) apart
  from open exposure (`outstanding_principal`): the ceiling on the second says nothing about the first.
- The cranker's `identity` line (how many people the chain bars, what the service set, lifted, closed and retried)
  and its `waiting` line (frozen escrows, claims held by a pending move); `recovery list` for requests whose notice
  failed.
- Kora's metrics (port 8081): the sponsor's balance; alert well above the rent of a first co-sign (about 0.007 SOL)
  times the daily volume.
- Events: `LoanSettled` (how often, how much lost), `Restituted` (how much comes back, how fast, and by whom:
  `fund_owed` and `cosigner_owed` say what is left), `ReimbursementWaived`, `FundClaimForgiven` (every one should have a
  published reason), `BarLifted` (every one should have a published
  reason), `RebindProposed` (every one should match an approval in the recovery CLI), `LendingPaused`,
  `ParamsScheduled` (a change to the identity keys starts the seven-day quarantine), `WindDownAnnounced`.
- The economics inputs to measure: settlement rate per cohort, share repaid before a settlement and paid back after
  one, waivers and forgiveness, cycle length, loans per borrower, identity approval rate and cost, sponsor spend per loan, support hours
  per loan and per settlement reviewed, time from incident to pause. Feed them back into `scripts/launch.json` and
  `app/src/lib/economics.ts`.
