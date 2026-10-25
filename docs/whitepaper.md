# Good Faith

**Interest-free, fee-free loans, funded by gifts. goodfaith.fi**

*Status: version 7 of the design, running on a test network with play money. The source is published for inspection under a proprietary licence (all rights reserved). The program has been through an internal security review and automated testing; an independent audit is still ahead. Nothing here is financial or legal advice.*

---

## 1. The problem

When money is tight, borrowing is expensive. The Consumer Financial Protection Bureau (CFPB) found a [median overdraft fee of $35](https://files.consumerfinance.gov/f/documents/cfpb_overdraft-nsf-report_2023-12.pdf) at large banks and credit unions that charge one. A common payday-loan fee of $15 per $100 for two weeks works out to [an annual rate of nearly 400%](https://www.consumerfinance.gov/ask-cfpb/what-are-the-costs-and-fees-for-a-payday-loan-en-1589/). Carrying a credit-card balance means paying interest every month at [the rates the Federal Reserve publishes](https://www.federalreserve.gov/releases/g19/current/).

Good Faith is an attempt to offer a different option: borrow what you need, pay back exactly that, and pay nothing extra.

## 2. How it works

### The loan fund

People donate money to a shared loan fund. These are **gifts**, not deposits: donors earn nothing and cannot take the money back, which is what lets the fund lend at zero cost. The fund holds USDC (a "stablecoin" designed to be worth one US dollar; section 3 says what that does and does not mean) in a public program on the Solana blockchain. The rules here are the program's rules. Two roles run it: the **administrator**, a multisig of independent people that holds the settings, and the **operator**, the organisation that runs the services. Section 5 says exactly what each can do.

### Borrowing

- **Repay exactly what you borrow.** Borrow $300, repay $300. No interest, no fees, no penalties.
- **Caps that grow slowly.** A new member can borrow up to $150 at first. Each loan repaid by its deadline that ran at least 30 days raises the cap by $100, at most once every 30 days, up to $500. A settled loan (below) never counts, and puts you back on $150.
- **One loan at a time, per person**, whichever wallet you use. What you borrow plus what you guarantee for others is capped at $1,000.
- **The fund has limits too.** The pilot fund is $10,000: at most $9,000 out on loan at once, at most $1,000 lent per day, and at most $15,000 lent in total during the pilot's first phase (about six months): the total does not reset when loans are repaid or settled, and raising it needs notice and a review (section 5). Money the fund owes to co-signers is never lent.
- **A set term and grace period.** Each loan has a due date and a grace period after it. The last second of the grace period is the **cutoff**. The term, the grace period, the deposit rate, the bar durations and the cap rules are written into the loan when it opens; later settings changes never touch it.

### The co-signer

Every loan needs a **co-signer**: a different person who puts up 25% of the loan as a deposit, held in escrow until the loan ends. This is a real commitment:

- If the loan is repaid by the cutoff, the deposit is the co-signer's again, in full.
- If not, the deposit covers what is missing, up to the whole deposit, and comes back only if the borrower later pays back. The co-signer can **waive** what they are owed; that is their own claim only, and the fund's claim stays.
- If the deposit did not cover everything, so the fund lost money, the co-signer is **barred** from borrowing and co-signing for a year at launch, ending sooner if the fund is paid back on every loan they guaranteed (section 2, "Bars, exactly").
- A co-signer backs at most two loans at once; two people cannot guarantee each other at the same time.
- The co-signer approves the exact terms they see (amount, term, grace period, deposit, bar). If anything changes, they have to look again. A request nobody co-signs expires after a week.

We know this asks a lot: cash up front, a risk of being barred, and the social weight of a friend's debt. Whether people will co-sign on these terms is something we will test with prospective borrowers and co-signers, including those who decline, before the pilot (section 8).

### After the cutoff: one path

Before the cutoff, a loan is **open** and any repayment is accepted. After it, no repayment is accepted; the loan is **settled**, by anyone (the fund's scheduled job within minutes, or the borrower as the first half of "settle and pay back"). There is one path, so the outcome is the same whoever moves first.

A settled loan carries **two separate claims**, both recorded on chain:

- **the fund's claim**: what the deposit did not cover, the fund's loss;
- **the co-signer's claim**: the part of their deposit that was used.

Anyone can **pay back** a settled loan, in any amounts, from any wallet. Payments reach the fund's claim first, then the co-signer's. Each claim can be given up only by its owner: the co-signer can waive theirs, and the administrator can forgive the fund's, in public, with a published reason. Forgiving a claim ends what is owed; it does not erase the loss from the books, and it is not the same as being paid back.

| state | how it gets there | the money | the borrower | the co-signer |
|---|---|---|---|---|
| **repaid** | paid in full by the cutoff | the deposit is the co-signer's again | the loan counts towards a higher cap | unaffected |
| **settled** | after the cutoff | nothing moves; both claims are recorded | barred 2 years; back on $150 | barred 1 year if the fund lost money; deposit used |
| **paid back** | both claims settled: the fund's paid, the co-signer's paid or waived, by anyone | the fund and the co-signer are made whole | bar shortens to 90 days from that day; the loan still does not raise the cap | bar ends once the fund is paid back on every loan they guaranteed |
| **closed by forgiveness** | the administrator forgave the fund's claim, and the co-signer's was paid or waived | the loss stays a loss | bar unchanged (the administrator can lift it separately) | bar unchanged: forgiveness is not pay-back |

A worked example: a $300 loan, a $75 deposit, nothing repaid by the cutoff. At settlement the fund's claim is $225 and the co-signer's is $75. If $300 is paid back on day 40 (by the borrower or anyone else), $225 goes to the fund and $75 to the co-signer, the co-signer's bar ends, and the borrower's bar becomes 90 days counted from day 40. If instead the co-signer waives their $75, the borrower still owes the fund $225; paying that ends the co-signer's bar and shortens the borrower's the same way. The co-signer cannot make the fund's $225 go away; only the administrator can, publicly, and then the borrower's bar stays as it was.

The program does not ask who paid. It can see which wallet signed, not whose money it was, so it rewards the outcome (the loan paid back), not a guess about the payer.

There are no collection agencies, no late fees and no credit reporting. What a settled loan still owes can be paid back at any time; nothing forces it.

### Bars, exactly

A person is eligible when the current time is past both of their bars.
- **Borrower bar.** A settlement sets it to the settlement date plus the loan's default bar (2 years at launch). When that loan is paid back, it shortens to the pay-back date plus the late bar (90 days), if that is sooner. A later settlement's bar is never shortened by an earlier loan's pay-back.
- **Co-signer bar.** Each settlement that left the fund a loss sets it to at least the settlement date plus the co-signer bar (1 year). It ends at the **earlier** of the latest such date and the moment the fund is paid back on **every** loss the person guaranteed. It is one date per person, not one per loan: paying back the loan with the latest date does not end the bar while an earlier loss is unpaid, and the bar then runs to that latest date. A forgiven claim is not paid back.
- **Lifts.** The administrator can lift a person's bars early, in public, with a reason (section 5). A lift clears the bars, not the record: a later loss bars again.

Bars can be made permanent by a settings change; they are not at launch. Paying back a loan you borrowed never touches a bar you carry as a co-signer, and the other way round.

### Your money, and ours

The app includes a plain **wallet**: your own USDC, in a wallet made for you when you sign up. There is no wallet app to install and no recovery phrase: you sign in with a passkey (your device's Face ID, fingerprint or PIN) or a code sent to your email, and the wallet's key stays with our wallet provider, Turnkey, in secure hardware, used only when you sign in. Good Faith never holds that key and cannot move your USDC; you can export the key from the app at any time, and every action in this paper can be done without our website (section 6). The program holds two kinds of money: the donated fund, and co-signer deposits until they are released. The one privileged action over your membership is a wallet recovery (section 4), which needs two of our keys, waits three days, and which your old wallet can cancel.

- **The stablecoin issuer can freeze USDC.** Circle can freeze any USDC account, including your wallet, the fund and an escrow. A freeze delays money without changing who it belongs to: settlement moves nothing, each side collects when the account can move, and nothing is written off. If a loan is paid back while its escrow is frozen, the fund keeps the payment in place of the frozen recovery and the co-signer's share is released from the escrow once it thaws, so the fund never owes money it has not received. A frozen loan fund stops everything until it thaws.
- **Accounting.** The specification follows a loan through every path (settlement, partial pay-back, collection before and after pay-back, a frozen escrow, a waiver, forgiveness, and a wind-down with late recoveries) with the fund's cash, both claims, the borrower's obligation and the recognised loss in separate columns.

### What to expect as a borrower

1. **Verify once** (section 4), a few minutes. The pass lasts a year and renews from the app.
2. **Ask a friend.** Enter the amount, the term and your co-signer's wallet; they get a link and approve within a week. The USDC arrives the moment they do.
3. **Spend it.** USDC is not yet dollars in a bank. You can send it, spend it where it is accepted, or turn it into cash at a MoneyGram counter from the app's Checking page: MoneyGram checks your ID, shows its fee and rate, and gives you a reference number to collect US dollars with (section 3 has the cost). The same card turns cash into USDC, where MoneyGram offers cash deposits (its test environment does for the US; production coverage for Texas is still to confirm). A bank partner would remove this step (section 8).
4. **Repay** any amount, from any wallet, until the cutoff. The app shows the due date, the grace days left and what is still owed.

## 3. Why Solana, and what the fee sponsor does

A Solana transaction costs a fraction of a cent and confirms in about a second. To spare users the separate coin that network fees need, a **fee sponsor** (Kora) pays the fees and the small account deposits ("rent") of Good Faith's own transactions. "Fee-free" means Good Faith charges nothing and, while the sponsor runs, the network charges you nothing either. If the sponsor is down, your wallet pays the fee itself and the app tells you first.

The sponsor's money is bounded and kept apart by purpose:
- **Three daily budgets.** *Protected* operations (settling, repaying, paying back, releasing or collecting what is owed, waiving, cancelling or finishing a recovery) have their own budget, so nobody can stop a member protecting themselves or paying what they owe by exhausting another. *Onboarding* (a wallet's first sponsored transaction, and joining) is small: 60 transactions and 20 new wallets a day at launch. *Members* have the rest. Each budget warns the operator at 80%.
- **Where rent goes.** The rent of a loan request and of an escrow goes back to whoever paid it (the sponsor, when it sponsored them) when they close. The rent of person, membership and loan records is never returned; those records are permanent. The sponsor pays for a token account only when its owner is a verified member, within a lifetime allowance per wallet, and never pays to close one, so its money cannot be collected back by opening and closing accounts.

**What "fee-free" leaves out.** Converting to cash is not free. The app's cash card uses MoneyGram Ramps, which charges its own fee: its test environment quoted 3.00 USDC on a 25 USDC cash-out in Texas, at one dollar per USDC; production fees are not yet published to us. At $3 each way, a $150 loan converted out and back costs about $6, 4% of the loan, paid to MoneyGram. A cash-out carries a memo with MoneyGram's ID for matching the deposit (a random code, not the pickup reference number, which stays between you and MoneyGram); like everything on chain it is public. The fee sponsor pays for it like any transfer, and pays for a memo only next to the wallet's own transfer. A borrower who spends USDC directly pays nothing.

**Tradeoffs.** Solana has had outages. During one, nobody can borrow or repay; funds are not lost, but access pauses (section 2 and section 6 say what an outage across a cutoff does).

## 4. Who can use it, and how we know

**Texas residents, 18 or older**, for now. Everyone who borrows or co-signs verifies once with Good Faith's identity service.

### One verified person, one membership

- **The check.** Our verification partner (Persona) checks a government ID, age, and that the state on the ID is Texas (the address state Persona reads from it; a proxy for residency, not proof). Our server learns the outcome and a few ID fields, never the selfie or documents; Persona keeps those under its own policy, which we will publish before launch.
- **The fingerprint, off chain.** From the ID number, state and birth date the server computes a keyed fingerprint, so the same document is recognised again. Whoever holds the key and knows someone's ID fields can tell whether they are a member, so a leaked key is treated as a breach.
- **The person id, on chain.** The program keeps one **person** per random id and one wallet per person; eligibility, loans, guarantees and caps live on the person. The chain shows what the id did; anyone who learns your wallet can read that history. "Private" means the documents and the fingerprint stay off chain, not that the chain is anonymous.
- **The pass and the membership.** The server issues a pass on the fund's own gatekeeper network, which the program checks on every request and co-sign. Joining is a transaction signed by you and by the fund's identity issuer, and it needs a valid pass. **Joining and borrowing need both keys**: the issuer's signature and the gatekeeper's pass.

The fingerprint catches people who return with the same document; it does not prove that two documents are two people. The caps bound what that is worth.

You may leave an email for notices about your membership (a recovery request, a bar set or lifted, a pass renewed, the contact changed). It can be changed only from your current wallet, and the old contact is told. The relay that sends notices sees it; we will name that service before launch.

### Lost keys: recovery you can stop

Losing a passkey does not lose the wallet: you sign in with an emailed code and add a new one. If you lose the wallet itself (both your passkey and your email account), you verify again from a new one and, with a message signed by it, ask to move your membership there.

1. **Your contact is told first**: the contact on file from before the request, and the new wallet's if it differs.
2. **A person decides, with a key the website does not have.** After at least a day, the operator reviews the request and proposes the move with the **recovery key**, which lives on the operator's own machine. The operator's tool checks *what* it signs: exactly one instruction, moving your person to the wallet the operator named. Deciding *whom* to approve does not rest on the web service's word, because a compromised service controls its own records. Before signing, the operator checks three things outside it: the verification itself, read directly from Persona with the operator's own key; your contact, against the operator's own history of contacts from before the request; and that the notice was delivered, from the relay's own log. The tool refuses to sign until the operator confirms those checks.
3. **Nothing moves for three days.** Your old wallet keeps working, the app shows it a move is pending, and nothing you are owed as a co-signer is paid out meanwhile.
4. **Your old wallet can say no**, with one click. The administrator can cancel too.

After the delay anyone finalises the move. A recovered membership sits on the first-loan cap for a month. For seven days after the fund changes its identity keys, no membership can be moved at all.

**A stolen wallet.** The old wallet's veto is unconditional, because it is what stops a fraudulent recovery, and the program cannot tell a member who lost a wallet from a thief who took it. A thief who holds your old wallet can therefore block your recovery. The policy for the pilot: the stolen wallet's pass is frozen, so it can take no loan or guarantee; your case goes to the administrator as an appeal; and everything you owe can still be paid back from any wallet. What remains is real: the thief can keep vetoing and can release to the stolen wallet what you are owed as a co-signer. A program path for the administrator to override a veto would fix that at the price of more administrator power; we have not built it.

### What we trust, and how much

| key | lives | can | cannot |
|---|---|---|---|
| **issuer** | the web service | vouch for a new membership; co-sign a recovery proposal | register anyone without a pass; move money; move a membership alone |
| **gatekeeper** | the web service | issue, renew, freeze and thaw passes | register anyone (that needs the issuer) |
| **recovery** | the operator's machine | co-sign a recovery proposal it has checked | anything alone |
| **administrator** | a multisig of independent people | section 5 | move money except to an announced successor, which a second key must agree to |

- **The issuer key alone** cannot register anyone: a membership also needs a pass, which only the gatekeeper issues. What it can do is co-sign recovery proposals, which still need the recovery key and a pass on the new wallet.
- **The whole web service** (issuer, gatekeeper, the store) can register fake people with passes and lend to them, bounded by the first-loan cap, the forfeited 25% deposits, the daily cap, the ceiling and the lifetime budget (section 9 prices it). It can prepare a recovery proposal and try to mislead the operator about it, which is why the operator's checks read sources the service does not control. It cannot move a membership without the recovery key.
- **The recovery key alone** can do nothing: every proposal needs the issuer too, and is visible on chain for three days.

### The legal approach

*This is the project's own reading of the law. It is not legal advice, and it has not been confirmed by a regulator or a court.*

- **0% loans.** Texas Finance Code chapter 342 does not apply to loans at 10% a year or less ([§342.004](https://law.justia.com/codes/texas/finance-code/title-4/subtitle-b/chapter-342/subchapter-a/section-342-004/)). Good Faith loans charge 0%.
- **Donations, not deposits.** Nobody is promised their money back.
- **Custody.** Your wallet is yours: its key is held by Turnkey and used only when you sign in, and you can export it. Whether Good Faith's Turnkey organisation could ever act in a member's account is to be confirmed with Turnkey and counsel before launch. The fund and the escrows are held by the program under rules the administrator changes only with notice.

**Open questions for counsel**, which we will put to a Texas attorney before any real-money launch: which legal entity runs the fund and holds the keys; who the lender is in law; who owns the donated assets; what the loan and co-signer agreements must say, and whether a co-signer is a guarantor or a surety; whether the Equal Credit Opportunity Act and Regulation B apply, and what notices a refused or barred person is owed; whether the FTC's co-signer notice rule applies; what sanctions screening is owed; how unclaimed escrow and entitlements are treated; whether the selfie match is a biometric identifier under Texas law; whether any licensing or money-transmission rules apply, including to offering MoneyGram's cash service inside the app (MoneyGram is the licensed party and runs its own identity check; the operator would be its integration partner); which disclosure rules apply to time-limited bars; the privacy of the check and the fingerprint; whether the upgrade authority changes any of this; and how donations are treated for tax. Answers will be published before launch.

## 5. How the fund is run

| who | may | how fast | after the administrator renounces |
|---|---|---|---|
| **administrator** (a multisig) | change settings; hand over the role; suspend the issuer; pause and resume lending; cancel a recovery; lift a bar or forgive a fund claim, in public, with a reason; announce a wind-down (with the successor key); renounce the role | settings and wind-down after the notice period (7 days at launch, never below 2); the rest at once | gone: nothing can be resumed, lifted, forgiven or changed again |
| **successor key** (the upgrade multisig at launch) | agree to a wind-down and its destination | with the administrator | useless unless a wind-down was announced before |
| **pause key** | pause new lending | at once | still works, and a pause is then permanent, since only the administrator resumes |
| **issuer and recovery key** | section 4 | a recovery waits 3 days (never below 1) and can be vetoed; none for 7 days after the identity keys change | unchanged, and can no longer be replaced or suspended |
| **program upgrade key** (a separate multisig) | replace the code during the pilot | its own delay | unchanged: renouncing the administrator does not remove it |
| **co-signer of a settled loan** | waive their own claim | at once | unchanged |
| **anyone** | apply a due change; settle; repay; pay back; collect; release; finalise a due recovery; close an expired request; sweep after a wind-down | by the rules | unchanged |

**Upgrades come first.** During the pilot the program's code can be replaced by a separate multisig through its own delay (we intend seven days), with every upgrade queued visibly on chain and each release's hash published. The key is removed once an independent audit is published with its findings closed, two full loan cycles run without a bug-forced change, and the legal questions are answered. Until then every guarantee here holds "unless the upgrade multisig changes the code, with notice".

The settings are the caps, the term and grace limits, the deposit rate, the guarantee and exposure limits, the daily cap, the ceiling, the lifetime lending budget, the request lifetime, the recovery delay, the three bar durations (the late bar never longer than the default bar), the identity, recovery, pause and successor keys, and the notice period itself. No setting adds a fee or interest. The administrator cannot move money except to an announced successor. Donations leave the fund only as loans; repayments and pay-backs flow back into it; an escrow goes only to the co-signer or the fund.

- **Every change has a notice period**, measured with the notice in force when it was announced, and never below two days once a fund runs with two or more. Open loans are never changed.
- **Bars can be lifted, not set**, and a fund claim can be forgiven, only in public with the hash of a written reason. No key can bar anyone; only a settlement does.
- **Winding down needs two keys.** The administrator and the successor key announce it and name a destination not controlled by the fund. After the notice period no new loans or donations are taken; open loans run their course and are still repaid, settled and paid back. Once none is open, anyone moves the balance to the successor, less what co-signers are owed from it. Pay-backs and collections that arrive later land in the old fund and are moved on by the scheduled job's next pass; what co-signers are owed is booked before any sweep and is never moved, so no entitlement is written off.
- **The successor key is independent only while the administrator leaves it alone.** It is a setting: the administrator can replace it, with notice, and could then announce a wind-down with a key of its own choosing. That replacement is public for the whole notice period.
- **Renouncing is possible, not planned.** We expect to keep a live multisig administrator for as long as the fund runs.

### The administrator's reach, honestly

An administrator that turned against its members could, with notice, replace the identity keys that decide who is a member. The program puts floors under that: the recovery delay never below a day, no membership moved for seven days after the identity keys change, and a wind-down's destination needing a second key. **At the launch settings that is at least 17 days** (7 of notice, 7 of quarantine, 3 of recovery delay) **between the announcement and the first membership that could be moved; the floors the program enforces whatever the settings make it at least 10 days** (2, 7 and 1), once the shorter settings have themselves been announced and waited out. Throughout, the change is visible on chain, the old wallet can veto, and the pause key can stop new lending. That is visibility, not always an exit: a member whose money is in an open loan, as a borrower's obligation or a co-signer's deposit, has it committed until that loan ends.

## 6. Operations

Five pieces of software run beside the program, each replaceable:

- **The identity service** (section 4; [`docs/identity.md`](./identity.md)): checks, passes, memberships, recovery requests and notices, and a mirror of the chain's bars.
- **The recovery tool** (`scripts/recovery.ts`): the operator's command line, holding the recovery key, reading the verification directly from the provider and refusing to sign without the operator's confirmed checks.
- **The fee sponsor** (section 3) behind the app's own proxy.
- **The scheduled job** ("cranker"): settles loans past the cutoff, collects and releases what is owed, closes expired requests, finalises due recoveries, applies due settings, sweeps after a wind-down on every pass, and keeps the identity service's bars in step with the chain. If it stops, nothing is lost: every step can be done by anyone.
- **The member command line** (`scripts/member.ts`): everything a member can do, against the blockchain alone, when our website is down.

**Outages across a cutoff.** The fund's money is unaffected. The people are not: the borrower is barred and loses the loan's cap credit, and the co-signer's deposit is used until the loan is paid back. The remedy: the operator publishes which cutoffs the outage covered, the administrator lifts both people's bars in public, and the operator helps the borrower pay back. Cap steps are not restored.

**Appeals.** A member who thinks a bar is wrong writes to the operator. The administrator does nothing, lifts the bar, forgives the fund's claim where pursuing it is wrong, or schedules different durations for future loans; each public action carries the hash of a reason in a published log. While barred, a member keeps every right that is not a new loan or guarantee.

## 7. Security and testing

- **Published source**, under a proprietary licence: anyone can read it, nobody may reuse it without permission; the deployed program can be checked against a tagged build (appendix).
- **Checked math** everywhere; no fee or interest fields exist in the code.
- **Security review.** An internal review is published in [`docs/audit.md`](./audit.md), findings GF-01 to GF-42. Version 6 closes these:
  - a co-signer could forgive the fund's claim (GF-37), now two claims, each given up only by its owner;
  - the borrower's late bar depended on which wallet signed (GF-38), now on the loan being paid back;
  - the co-signer bar's expiry was described three ways (GF-39), now one rule;
  - the ceiling bounded open exposure but not cumulative loss (GF-40), now a lifetime lending budget;
  - the sponsor could be farmed for rent and had one budget for everyone (GF-41), now lanes, no sponsored closes, and rent only for members' accounts;
  - the recovery tool trusted the web service about whom to approve (GF-42), now independent checks.
  An independent audit is planned before any real-money launch.
- **What the tests check**, after every step of random sequences of up to forty operations (24 per developer run, 200 in continuous integration), and in scenario tests:
  - the fund's cash equals its inflows less its outflows, and always covers what co-signers are owed from it;
  - per settled loan, the fund's and the co-signer's claims are each paid only up to their own size, the fund's first;
  - the recognised loss equals the sum of the fund's unpaid claims, and forgiven claims are counted apart;
  - a loan is closed exactly when neither claim is owed;
  - bars follow the rules above;
  - exposure, caps, the ceiling and the budget hold;
  - settings change only through announced changes, above the floors.
  The whole system also runs end to end on a local copy of Solana's test network on every change, including the sponsor, the identity flow, the recovery tool and the scheduled job.

## 8. Roadmap

1. **Test network version (now)**, on a local fork of devnet.
2. **Devnet deployment**, with the appendix filled in.
3. **Identity partner in production mode.**
4. **Audit and counsel**, published.
5. **Research with the people it is for.** Interviews and a dry run with prospective borrowers and co-signers, including people who decline to take part, about the deposit, the bar, and the pressure a guarantee puts on a friendship. If the co-signer terms keep the people we mean to reach away, the design changes before money moves.
6. **A very small pilot with real dollars in Texas**: a $10,000 fund, run by volunteers, with the platform's one-off costs paid by the founder; a multisig administrator and a separate upgrade multisig; measuring what section 9 says we need. The fund grows only when the pilot's numbers say lending is working, and each step up (more capital, a higher ceiling or budget) is a settings change with notice and a published review.
7. **Permanence**: remove the upgrade key once the exit criteria are met.
8. **Cash access**: MoneyGram cash-out and cash-in through the app (on the test network now, against MoneyGram's test environment); production needs MoneyGram's partner review of the operator and counsel's answer above.
9. **A bank partner** for dollar accounts, then **more states**, one at a time after reviewing each state's law.

## 9. Economics

Good Faith has no revenue: capital lost and the cost of running the fund are paid from gifts. [`docs/economics.md`](./economics.md) has the model, every table and every assumption. Terms: the **settlement rate** is the share of loans made in a cycle that are settled after their cutoff; it is not the ultimate loss, because the deposit covers part and pay-backs may cover more. The model assumes nothing is paid back after a settlement, the conservative side.

**The pilot.** Version 6 planned a $100,000 fund held to a $25,000 ceiling, with paid staff and the one-off costs charged to donors. At that scale each completed loan cost donors about $160, and the same money given as grants would have reached more people. Version 7 launches smaller instead:
- **A $10,000 fund**, sized to its $9,000 ceiling, so no endowment sits idle.
- **Run by volunteers**: support, disputes, fraud response and bookkeeping, about 150 hours a year.
- **Platform costs paid by the founder**, not by donors: the audit ($30,000) and legal work ($15,000) before any real money moves, and the development already done ($20,000). These are the cost of building the platform, not of running the pilot.

| | per year |
|---|---|
| completed loans (5% settled) | about 87 |
| capital lost | about $750 |
| identity checks, renewals, sponsor, hosting | about $2,100 |
| **gifts needed, all donor-side costs in** | **about $2,900** |
| cost to donors per completed loan | about $33 |
| years the fund lasts with no gifts at all | about 4 |

| same money, ten years | people reached | what is left |
|---|---|---|
| grants of $300 each | about 130, once | nothing |
| loans | about 240 (430 borrower-years, 870 completed loans; half of each later year's borrowers borrowed before) | the $10,000, still lending |

Over three years the comparison is 87 people as loans against 62 as grants. **The pilot's case rests on the split of costs**: if the founder's $65,000 were charged to donors, grants would reach more people again, and paying the volunteers would narrow the margin. Read the figures as what a gift does, not as what the whole project costs. "People reached" is not equal benefit either: a loan is the use of money for a few months, with a co-signer, a deposit and a bar; a grant is the money. New members start at $150 and most reach the $300 they need in about eight months, so early loans are smaller than the model's average.

**What a settlement leaves.** In the pilot about $1,100 of principal a year is unpaid at settlement. Deposits cover about $340 of it; the rest is the fund's loss unless it is paid back. How much is paid back is the number we most need to measure.

**Costs others pay.** Co-signers lose about $340 a year of deposits until loans are paid back. Borrowers who need bank dollars pay about $6 a loan to convert.

**Stress scenarios**, at the pilot's settings and with their assumptions. These are scenarios, not bounds, and each attack row assumes **no attack loan settles and no other loan frees ceiling room before containment**.
- **A local shock.** One cycle at a 30% settlement rate costs about $1,500 that cycle and about $2,000 that year, a fifth of the fund.
- **A compromised identity service** (issuer and gatekeeper together; neither alone can register anyone, section 4):
  - contained in three days with the fund in normal use: $1,800 lent, $1,350 lost;
  - with an empty book: $4,000 lent, $3,000 lost;
  - a week to contain: $8,000 lent, $6,000 lost.
  Settlements free ceiling room, so the ceiling is not a lifetime limit. Unnoticed for a month, the attack is bounded by the $15,000 budget and, below it, by the fund itself: fake loans never come back, so it can take at most the $10,000 the fund holds, losing $7,500. That is the pilot's worst case, and the reason it is small.
- **Sponsor abuse.** Strangers can spend only the onboarding budget, and only on transaction fees: about $22 a year.
- **An outage across cutoffs** costs the fund nothing; it costs the affected people their deposits until loans are paid back, their cap credit, and a volunteer's review.

**Collusion is limited, not prevented.** Three people can form a ring with no reciprocal pair, each borrowing once with the next as co-signer: $338 on the first-loan cap, $1,125 if all three had grown to $500. It costs each of them years of eligibility and an ID on record, and cannot repeat with the same people. A colluding co-signer cannot end the borrower's debt to the fund.

## 10. Risks

Please read these before donating, borrowing or co-signing.

- **Smart contract bugs.** Code can have mistakes even after review and testing. During the pilot the program can be upgraded to fix one, by a multisig after a delay; that power could also be misused.
- **Co-signer risk.** Your deposit covers what the borrower does not repay and comes back only if the loan is paid back, which nothing forces. If the fund lost money you are barred for a year, or until the fund is paid back on every loan you guaranteed, whichever comes first. You can give up your own claim; you cannot end the borrower's debt to the fund. Only co-sign for someone you trust, with money you could lose.
- **Settlements draining the fund.** Deposits cover a quarter of each loan. If many loans are settled at once, the fund shrinks; there is no guarantee it is replenished. In the pilot the whole fund, $10,000, is the most that can be lost.
- **Scale and volunteer risk.** The pilot reaches more people than grants only because the founder pays the platform's costs and volunteers do the work. If volunteers leave and the work is paid, or if the fund grows without the volume to match, grants can again reach more people for the same money.
- **Regulatory change** could force changes or a shutdown; the wind-down path exists so that a shutdown is orderly.
- **Stablecoin risk.** USDC could lose its $1 value, and its issuer can freeze any account, including yours, the fund's and an escrow.
- **Identity risk.** The partner could decline people wrongly or go away; our keys could be compromised (section 4); a stored fingerprint is data about you that could leak.
- **Recovery risk.** A recovery you do not notice within the delay cannot be vetoed; the operator's independent checks and the notice to your contact are the protection, and a member with no contact who never opens the app has only the operator's checks. A thief holding your old wallet can block your recovery (section 4).
- **Administrator risk.** With notice, the administrator can replace the identity keys and the successor key. At least 17 days at the launch settings, and at least 10 whatever the settings, pass in public before a membership could move. The multisig's independent membership is the real protection, and it is a social one.
- **Network, operator and sponsor risk.** Our servers, the sponsor or Solana could go down. Repaying, settling, paying back, releasing, waiving and vetoing never depend on our servers. An outage across your cutoff settles your loan.
- **Upgrade risk.** Every guarantee here is subject to the upgrade multisig until its key is removed.
- **No deposit insurance.** Wallets and the fund are not FDIC-insured.

Good Faith is a small, early experiment. Only donate what you can afford to give away, and only co-sign for someone you trust.

## Appendix: verifying what is deployed

Everything below is meant to be checked, not believed. Items marked *to be filled at deploy* are empty until the deployment they describe exists.

- **Source:** the project repository, public to read, proprietary licence (all rights reserved); the paper, the specification ([`docs/spec.md`](./spec.md)), the review ([`docs/audit.md`](./audit.md)), the identity note ([`docs/identity.md`](./identity.md)), the operations note ([`docs/operations.md`](./operations.md)) and the economics ([`docs/economics.md`](./economics.md)) live beside the code and change with it.
- **Deployment status:** devnet only (test money), deployed 2026-10-24; no mainnet deployment. Program `BvYSoBvDqLGrnrMqSpPguFkApyNTTj219mLWQGnrkCGq` (keypair encrypted in `keys/devnet-program.json.enc`), pool `6WhSVqUVvjQ9ana2JAvx4gBKK2o1P7m2K6aCxeXWxCeA`, vault `FUbBuu4hfSDpiK5po711MesY8KureDLQ4R1utvs1zFCj`, mint devnet USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, gatekeeper network `B9p1QCuQDzj6dnds8sppuSzCjxTxyqFzCRnekEVmhnJj`. The administrator, issuer, recovery, pause key and gatekeeper are all the devnet admin key `2agNDw6soEttnATLgkhxup22GGoeCa7KVNfxyeeuHbve` (`keys/devnet-admin.json.enc`), and the pool runs with a one-hour notice period and recovery delay so it can be tested; a real deployment separates the keys and keeps the seven-day notice.
- **Release tag and build hash:** devnet build from commit `b40ad75d33b15713207cd301cf2d7de8a1c660ba` with `anchor build --arch v2`; SHA-256 of `target/deploy/goodfaith.so` `35e88cb1b91a84e91702ad108f232fc4aa470d3f685bb0afb37bf60d25445389`, which `solana program dump` of the deployed account matches. A mainnet release is built from a tagged commit and its hash published with the tag.
- **Upgrade authority:** on devnet the admin key `2agNDw6soEttnATLgkhxup22GGoeCa7KVNfxyeeuHbve`. *Mainnet: to be filled at deploy*: the upgrade multisig and its delay during the pilot; "none" once the program is made permanent (`solana program show` prints "Upgrade authority: none").
- **Pool account, mint, administrator, successor key, pause key, issuer, recovery key, every setting:** read from the pool account on chain (`Pool` layout in the specification), including when the identity keys last changed; the app pins the pool address, the mint, the gatekeeper network and the administrator in its configuration and refuses anything else. The member command line reads the same account. Every loan carries its own term, grace period, deposit rate, bar durations and cap rules, so what applies to a loan is read from the loan, not from today's settings; a settled loan also carries its two claims (what the fund and the co-signer are still owed), any waiver and any forgiveness.
- **Bar lifts and forgiveness:** every `BarLifted` and `FundClaimForgiven` event carries the hash of the administrator's written reason; the operator publishes the reasons so the hashes can be checked.
- **Gatekeeper network and keys:** the network's public key and the issuer, recovery, pause and successor keys are published with the deployment; passes can be looked up on chain for any wallet, with their expiry and whether they are frozen.
- **Audit scope and status:** internal review published in [`docs/audit.md`](./audit.md) (findings GF-01 to GF-42); *independent audit: to be filled when complete.*
- **Upgrade multisig:** *to be filled at deploy*: its members, threshold and delay, where queued upgrades can be seen, and the published exit criteria (section 5).
- **Tests:** the program's scenario and property tests (`cargo test -p goodfaith`; `PROPTEST_CASES=200` in continuous integration), the app's unit tests and simulator scenarios (`npm test`, `npm run test:svm` in `app/`), and the end-to-end scripts in `scripts/`, all run by the repository's continuous integration on every change; what they check is listed in section 7.
