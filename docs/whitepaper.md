# Good Faith

**Interest-free, fee-free loans, funded by gifts. goodfaith.fi**

*Status: version 3 of the design, running on a test network with play money. The source is published. The program has been through an internal security review and automated testing; an independent audit is still ahead. Nothing here is financial or legal advice.*

---

## 1. The problem

When money is tight, borrowing is expensive. The people with the least cushion pay the most.

- **Overdraft fees.** When a bank lets a payment go through that your account cannot cover, it charges a fee. The Consumer Financial Protection Bureau (CFPB) found a [median overdraft fee of $35](https://files.consumerfinance.gov/f/documents/cfpb_overdraft-nsf-report_2023-12.pdf) at large banks and credit unions that charge one.
- **Payday loans.** A common fee is $15 per $100 borrowed on a two-week loan. The CFPB says that works out to [an annual rate of nearly 400%](https://www.consumerfinance.gov/ask-cfpb/what-are-the-costs-and-fees-for-a-payday-loan-en-1589/).
- **Credit cards.** Carrying a balance means paying interest every month, and the Federal Reserve [publishes the rates banks charge](https://www.federalreserve.gov/releases/g19/current/) each month. Anyone who has carried a balance knows how quickly it grows.

A small shortfall of a few hundred dollars can turn into a long, costly cycle. Good Faith is an attempt to offer a different option: borrow what you need, pay back exactly that, and pay nothing extra.

## 2. How it works

### The loan fund

People donate money to a shared loan fund. These are **gifts**, not deposits. Donors do not earn anything, and they cannot take the money back. That is what lets the fund lend at zero cost: nobody is waiting to be paid a return.

The fund holds digital dollars (USDC, a "stablecoin" designed to always be worth one US dollar; see section 3 for what that does and does not mean). It sits in a public program on a blockchain (a shared record anyone can inspect and nobody can quietly edit). The rules in this paper are the program's rules; the people who run the fund can change the settings, with notice, and nothing else (section 5 says exactly what).

### Borrowing

- **Repay exactly what you borrow.** Borrow $300, repay $300. No interest, no fees, no penalties.
- **Caps that grow with you.** A new member can borrow up to the first-loan cap ($150 at launch) for the first month. Every loan repaid on time raises your personal cap by $100, up to the fund's maximum ($500).
- **One loan at a time, per person.** A person can have only one open loan, whichever wallet they use, and the total of what they borrow and what they guarantee for others is capped ($1,000 at launch).
- **Set term and grace period.** Each loan has a repayment deadline (up to a maximum number of days), followed by a grace period. The last second of the grace period is the cutoff.

### The co-signer

Every loan needs a **co-signer**: a different person who vouches for you and puts up part of the loan amount as a safety deposit. By default that is **25% of the loan** (the fund can change this setting, with notice). The deposit is locked in "escrow", a separate holding account that neither of you can touch until the loan ends.

- If you repay in full, the co-signer's deposit is owed back to them in full, and they (or anyone on their behalf) release it to their wallet.
- If you do not repay, the deposit is used to cover what is missing (see "What a default means").
- A co-signer can back only a limited number of loans at once (two, at launch), two people cannot guarantee each other at the same time, and a co-signer's guarantees count against their own exposure cap.
- The co-signer agrees to the exact terms they see. If the request changes after that, their approval no longer applies and they have to look again. A request that nobody co-signs expires after a week.

### The life of a loan

```
  Donors
    |  gifts
    v
 [ LOAN FUND ] ----- loan: $300 -----> Borrower
    ^   ^                                  |
    |   |   co-signer locks $75 (25%)     |
    |   |   in escrow at the start         |
    |   |                                  |
    |   +------ repay $300 (any amount, any time, by anyone) ---+
    |
    +-- Repaid by the cutoff:  the $75 is owed back to the co-signer,
    |                          who releases it to their wallet. Done.
    |
    +-- Repaid after the cutoff: same money, but the loan is recorded
    |                          as late and the borrower is barred for a while.
    |
    +-- Still unpaid after the cutoff (default):
          the escrow pays the unpaid balance to the fund, up to the
          amount held. Anything left over is owed back to the co-signer.
          The borrower is barred for a long time. The co-signer is barred
          too, for a shorter time, only if the fund lost money.
```

### What a default means

The cutoff is the end of the grace period, to the second. What happens after it does not depend on who moves first:

| what happens after the cutoff | the money | the borrower | the co-signer |
|---|---|---|---|
| the loan is repaid in full | the fund is made whole; the escrow is owed back to the co-signer | loan recorded as **repaid late**; barred for 90 days (launch setting); it does not count towards a higher cap | keeps their standing |
| anyone triggers the default (the fund's scheduled job does within minutes) | the unpaid balance is taken from the escrow into the fund; anything left over is owed back to the co-signer; if the escrow is smaller than the unpaid balance, the fund absorbs the loss | barred for 2 years (launch setting) | barred for 1 year, **only if the fund lost money** |

Whichever of the two lands first, the fund receives the same money and the co-signer is owed the same escrow. There are no collection agencies, no late fees and no added charges. The default step ends the debt as far as the program is concerned: nothing more is owed on chain.

All bars are for a set time, set by the fund with notice; they can be made permanent but are not at launch. A bar is never shortened by a later, lighter one.

**If the network or our servers are down across a cutoff**, nobody can repay or trigger a default until they are back; the money works out the same either way, but a borrower who tried to pay on time may be recorded as late. The grace period exists partly to soften this, and section 6 says how the operator handles it.

### Your money, and ours

The app includes a plain **wallet** view: your own digital wallet, holding USDC under a private key only you control. Good Faith cannot move it. If our website disappeared tomorrow, your wallet and your USDC would still be there, and every action in this paper can be done without our website (section 6).

Two kinds of money are held by the program, not by you: the donated fund, and co-signer escrows while a loan is open or until they are released. Both are governed by the program's rules, which the fund's operator can change only as section 5 describes. And one privileged action exists over your membership: a wallet recovery (section 4), which needs two of our keys, waits three days, and which you can cancel.

Two things that are true of every USDC wallet, including this one:

- **The stablecoin issuer can freeze USDC.** USDC is issued by Circle, and the token on Solana has a "freeze authority": Circle can freeze any USDC account, which it does under legal orders. That applies to your wallet, to the loan fund and to escrows alike. Good Faith has no such power and cannot undo a freeze. A frozen escrow or wallet no longer blocks a loan from closing (version 3 made every refund a claim the co-signer collects when they can), but it does block that money until the freeze is lifted. On the test network the play-money USDC has the same property.
- **Creating an account costs a little.** Sending USDC to a wallet that has never held it creates a small account on the blockchain, which costs the sender about 0.002 SOL (a few cents). The fee sponsor (section 3) covers Good Faith's own transactions, not accounts created for other people.

### What to expect as a borrower

This is what the journey looks like today. These are the current options, not promises.

1. **Verify once.** A one-time identity check (section 4) from a phone or computer, a few minutes.
2. **Ask a friend.** You enter the amount, the term and your co-signer's wallet address; they get a link, review the exact terms and approve within a week. The moment they do, the USDC is in your wallet.
3. **Spend it.** USDC in a wallet is not yet dollars in a bank account. Today you can send it to anyone with a Solana wallet, spend it where USDC is accepted, or convert it through a crypto exchange or an "off-ramp" service that pays out to a bank account. Those services charge their own fees (typically well under 1%) and take minutes to a few days, and they have their own identity checks. We are working on a bank partner so that this step disappears (section 8).
4. **Repay.** Any amount, any time, from any wallet, including a friend's. The app shows the due date, the grace days left and exactly what is still owed.

## 3. Why Solana, and what the fee sponsor does

Good Faith runs on Solana, a public blockchain, for two practical reasons: a transaction costs a fraction of a cent and confirms in about a second.

On most blockchains you must hold a separate coin just to pay network fees. That is a real barrier for a new user. Good Faith avoids it with a **fee sponsor** (software called Kora): when the sponsor is running, joining, borrowing, co-signing, repaying, releasing an escrow and donating cost you nothing, including the small refundable deposits ("rent") Solana requires for new accounts. "Fee-free" therefore means: Good Faith charges nothing, and while the sponsor runs the network charges you nothing either. The app shows you whether fees are covered at any moment. If the sponsor cannot be reached, your wallet pays the network fee and rent itself, and the app tells you so before you act. The sponsor only pays for Good Faith's own transactions: it reads every transaction before paying, refuses anything else, and each wallet has a daily allowance.

**Honest tradeoffs.** Solana has had outages in the past, some lasting hours. If the network is down, you cannot borrow or repay until it returns. Your funds are not lost during an outage, but access is paused. See "What a default means" for what an outage across a cutoff does.

## 4. Who can use it, and how we know

**Texas residents, 18 or older**, for now. Everyone who borrows or co-signs verifies once with Good Faith's own identity service.

### One verified person, one membership

A wallet is not a person. Someone barred for a default could otherwise come back with a new wallet, and someone with two wallets could borrow twice. So the fund keeps track of people.

- **The check.** Our verification partner (Persona) checks your government ID, that it is issued in Texas, and your age, in a hosted flow on your phone or computer. Good Faith's server learns the outcome and a few fields of the ID, never your selfie or your documents.
- **The fingerprint, kept off chain.** From the ID number, the issuing state and the birth date, the server computes a keyed fingerprint: the same every time the same document is verified, and not reversible into the document. It is stored on our server, keyed with a secret we can rotate, and it never goes on the blockchain.
- **The person id, on chain.** What goes on chain is a random identifier the server draws for you the first time. The program keeps one **person** record per id and one wallet per person. Eligibility, the open loan, the guarantees and your personal cap live on the person, not the wallet. Nothing on the public chain can be traced back to your ID.
- **The pass.** The server issues a pass to your wallet on the fund's own gatekeeper network. The program checks the pass on every request and co-sign.
- **The membership.** Joining is a transaction signed by you *and* by the fund's identity issuer, which vouches on chain that your wallet belongs to your person id.

A renewed or second document can be added to your membership by verifying again from your wallet. We say this plainly: the fingerprint catches people who come back with the same document; it does not prove that two different documents are two different people. The caps in section 2 bound what that is worth.

### Lost keys: recovery you can stop

If you lose your wallet, you verify again from a new one. The server recognises you and, after a review period, proposes a move of your membership to the new wallet. Three things make that safe:

1. **Two of our keys must agree.** The proposal is signed by the identity issuer *and* by a separate recovery key. Neither alone can move a membership.
2. **Nothing moves for three days.** During the delay your old wallet keeps working, and the app shows it that a move is pending.
3. **Your old wallet can say no.** If you still have it, one click cancels the move. The fund's administrator can cancel it too.

After the delay, anyone (you, or the fund's scheduled job) finalises the move: the old wallet is retired for good, the new wallet takes over your membership, open loans and guarantees, and any escrow you are owed is released to the new wallet when claimed. A recovered membership sits on the first-loan cap for a month, like a new one.

The same machinery is what makes a bar stick: a barred person who verifies again, from any wallet, is recognised and refused before anything reaches the chain, and their passes are revoked at the moment of the default.

### Borrower and co-signer are different people

The program checks that the two people behind a loan are different person records, not merely different wallets, and that they do not guarantee each other at the same time.

### What we trust, and how much

Our identity service holds three keys with different jobs, and the program limits what each can do:

| key | can | cannot |
|---|---|---|
| **issuer** | vouch for a new membership; co-sign a recovery proposal | move money; move a membership alone; skip the delay or the veto |
| **recovery** | co-sign a recovery proposal | anything alone |
| **gatekeeper** | issue and revoke passes | register anyone (that needs the issuer too) |

The worst a compromised issuer can do is register fake people and lend to them. The program bounds that: each fake membership starts on the first-loan cap, every fake loan still forfeits a 25% escrow, each person's exposure is capped, and the fund lends at most a fixed amount per day ($5,000 at launch). The administrator can pause all new lending instantly and suspend the issuer instantly. Section 9 puts a dollar figure on that scenario. The security review (section 7) lists the residual risks.

### The legal approach

*This is the project's own reading of the law. It is not legal advice, and it has not been confirmed by a regulator or a court.*

- **0% loans.** The Texas Finance Code chapter 342, which regulates consumer loans, does not apply to loans at 10% a year or less (Texas Finance Code [§342.004](https://law.justia.com/codes/texas/finance-code/title-4/subtitle-b/chapter-342/subchapter-a/section-342-004/)). Good Faith loans charge 0%.
- **Donations, not deposits.** The fund is built from gifts. Nobody is promised their money back, so Good Faith is not taking deposits.
- **Custody, stated precisely.** Your wallet is yours; Good Faith has no key to it. The donated fund and the escrows are held by the program under rules the operator can change only with notice. The one privileged power over a member is the recovery described above, which two keys must sign and the member can veto.

**Open questions for counsel.** Before any launch with real money we will put these to a Texas attorney, and we do not claim to know the answers: who the lender is in law when a program lends donated money (the operator, the donors, nobody); who owns the donated assets and what duties come with holding them; whether facilitating loans between people, or issuing identity passes, brings licensing obligations; whether the fee sponsor or the wallet feature touch money-transmission rules; which consumer-protection and disclosure rules apply to a 0% loan with time-limited bars; what the privacy law says about the identity check and the stored fingerprint; whether a program upgrade authority changes any of the above; and how donations are treated for tax purposes on both sides. Answers will be published before launch; until then the real-money launch is not scheduled.

## 5. How the fund is run

Several keys run the fund, each with a job, and the program limits each one. The full table is in the specification; in short:

| who | may | how fast |
|---|---|---|
| **administrator** (a multisig of independent people) | change the settings; hand over the role; suspend the issuer; pause and resume new lending; cancel a recovery; announce a wind-down; give up the role for good | settings and wind-down after the notice period (7 days at launch, never below 2); the rest at once |
| **pause key** (held separately) | pause new lending | at once |
| **identity issuer and recovery key** | section 4 | a recovery waits 3 days and can be vetoed |
| **program upgrade key** (a separate multisig, with its own delay) | replace the program's code during the pilot | see "Upgrades" |
| **anyone** | apply an announced change once its time has passed; finalise a due recovery; close an expired request; repay; trigger a default; release an escrow; move the balance to the successor after a wind-down | by the rules above |

The settings are: the loan cap, the first-loan cap and how it grows, the cooldown, the longest term, the grace period, the co-signer deposit rate, how many loans one co-signer may back, the exposure cap, the daily lending cap, the request lifetime, the recovery delay, the three bar durations, which gatekeeper network, issuer, recovery key and pause key are accepted, and the length of the notice period itself. No setting adds a fee or interest; the code has no field for one. The administrator cannot move money, except in the announced wind-down case below. Donations can only leave the fund as loans, repayments only flow back into it, and an escrow can only go to the co-signer or to the fund.

- **Every change has a notice period.** A settings change is announced first and takes effect only after the fund's notice period, measured with the notice period in force when it was announced, so shortening the notice period itself waits the old delay, and once a fund runs with two days or more of notice, no change can ever take it below two days. Anyone can apply the change once the time has passed; the administrator can withdraw it before then. Nothing applies silently.
- **Open loans are never changed.** A settings change applies to future loans only. Each loan keeps the grace period it was opened with.
- **Handing over the role takes two steps.** The current administrator names the next key, and that key has to accept.
- **Two instant brakes.** Pausing new lending (new requests and co-signs stop; repayments, defaults, releases and recoveries continue) and suspending the issuer (no new memberships or recovery proposals until a new issuer is announced and applied). Neither touches money or existing members.
- **Winding down, with a successor.** The administrator can announce that the fund is closing and name a successor: a token account of the same currency that is not controlled by the fund itself. After the notice period, the fund stops taking new loans and donations; open loans run their course, repayments still come in, defaults still settle, escrows are still released, members can still recover a wallet. Once no loan is open, anyone can move the remaining balance to the successor. The announcement can be withdrawn before it takes effect, not after.
- **Giving up the role is possible, not planned.** The administrator can permanently give up the role, which also discards any announced change. We expect to keep a live, multi-signature administrator for as long as the fund runs, because a fund with no administrator cannot pause, cannot resume, and cannot be wound down unless that was announced first.
- **Everything is announced.** Every action, from a loan opening to a settings change, a recovery proposal, a pause or a wind-down, is recorded as a public event on the blockchain.

### Upgrades

The program is upgradeable during the pilot. A separate multisig of independent people holds the upgrade key behind its own delay, so a code change is visible before it lands and no single person can make one. Once the pilot has run long enough to trust the code, the upgrade key is removed and the program becomes permanent; from then on fixing a bug means launching a new version and winding this one down into it. Until that day, "the rules are the program's rules" means the program as it stands and as that multisig may change it; we say so rather than claim immutability we do not yet have.

## 6. Operations

Four pieces of software run beside the program, all published and all replaceable:

- **The identity service** (section 4): opens checks, receives the partner's results, issues and revokes passes, co-signs memberships and recovery proposals, and holds recovery requests for review. It stores the fingerprints (keyed, versioned), the person ids, the wallets, the inquiry ids and statuses. [`docs/identity.md`](./identity.md) describes it, including what happens when a key is rotated, lost or leaked.
- **The fee sponsor** (section 3): a Kora server behind the app's own proxy, which holds the credentials, forwards only three operations, reads every transaction against the sponsorship policy, and limits each client and each wallet.
- **The cranker**: a scheduled job that does, on time, what anyone is allowed to do: it marks loans past the cutoff as defaulted, releases escrows owed to co-signers (creating their token account at the fund's expense when needed), closes expired requests, finalises recoveries whose delay has passed, applies settings changes whose notice period has passed, moves the balance to the successor once a wind-down is complete, and tells the identity service which people were barred so their passes are revoked. If the cranker stops, nothing is lost.
- **The member command line** (`scripts/member.ts`): everything a member can do in the app (see their standing, request, co-sign, repay, release an escrow, close an expired request, veto or finalise a recovery, donate), from a terminal, against the blockchain alone, paying the small network fee themselves. It is the supported path when our website or the sponsor is down. Joining and recovering still need the identity service, because they need its signatures.

**Outages across a cutoff.** When our servers or the network were down across a loan's cutoff, the operator can see which loans were affected and the bar on a borrower who was recorded late through no fault of theirs is a matter of the operator's judgement, not the program's: the program cannot lift a bar, so the remedy is to say so publicly and to take it into account for that person's future caps. We would rather state this limit than pretend the code handles fairness.

## 7. Security and testing

- **Public source, verifiable on chain.** The program, the app, the identity service, the sponsor policy and every script are published under the Apache License 2.0 in the project repository, and the deployed program can be checked against a tagged build (appendix). Every loan, repayment, release and donation is recorded on the blockchain for anyone to check.
- **Checked math.** Every calculation uses overflow-safe arithmetic. If a number would go out of range, the transaction fails instead of producing a wrong result. The code contains no fee or interest fields at all.
- **Security review.** An internal review of the program is published in [`docs/audit.md`](./audit.md), findings GF-01 to GF-20. The version 3 findings are the ones this paper is built around: the default race (fixed by deadline-based lateness), pushed refunds that a frozen account could block (fixed by claims), unbounded collusion and exposure (fixed by the caps), no emergency stop (fixed by the pause and the minimum notice), requests that never expired, the issuer as a financial authority (now two keys, a delay and a veto), and a credential-derived identifier on chain (now a random id). An independent audit is planned before any real-money launch.
- **What the tests check**, rather than how many there are: that the money in the fund always equals gifts plus repayments plus recovered escrow minus loans out minus anything moved to the successor; that every token ever handed out is in the fund, an escrow, a wallet or the successor; that while a loan is open its escrow holds exactly the deposit, and once closed it holds exactly what is owed back until claimed; that eligibility, caps, exposure and guarantees always sit with the right person and never exceed their limits; that no two open loans guarantee each other; that nothing is lent while paused; that a late repayment is recorded as late exactly when it landed after the cutoff; that settings change only through an announced and applied change and never below the minimum notice; and that a wind-down, once in effect, never reverses. These are checked after every step of thousands of random sequences of operations, with clock jumps across deadlines, in the program's property test, and in the scenario tests of the program, the web app's own transaction code, the identity service and the sponsorship policy. On a local copy of Solana's test network the whole system runs end to end on every change: a fund is created, passes are issued by the real gateway program, the loan cycle runs with a cancellation, a late repayment, a recovery with a veto and a finalisation, an expired request, a pause, a settings change across a time jump, a default with a claim to a replaced wallet, a wind-down with a sweep; the sponsored flows run against a real sponsor, directly and through the policy, checking that users paid nothing, the sponsor paid exactly what it should, and that the policy refused what it should; the identity flow runs from the wallet's signed proof to a sponsored join, a linked document, a recovery, a declined and an out-of-state check and a ban; and the cranker does its rounds.

## 8. Roadmap

1. **Test network version (now).** Working program, web app, identity service (with a mock partner on the test network), fee sponsor with policy, cranker, member command line and automated testing, using play money on Solana's test network ("devnet"). Not yet deployed to a public test network: it runs on a local fork of one.
2. **Devnet deployment.** The program at a published id, the fund created with the launch settings, the app and services hosted, the cranker on a schedule, the appendix filled in.
3. **Identity partner in production mode.** Persona's live checks, the field mapping confirmed against real inquiries.
4. **Audit and counsel.** Independent security audit and fixes; answers to the open legal questions, published.
5. **Capped pilot with real dollars in Texas.** A small fund, the launch caps, a multisig administrator and a separate upgrade multisig, with the data this paper says we need to measure.
6. **Permanence.** Once the pilot has run, remove the upgrade key.
7. **Bank partner for dollar accounts.** A regulated bank partner so users can hold ordinary US dollar accounts alongside their wallet and skip the conversion step.
8. **More states.** Expand state by state, after reviewing each state's law.

## 9. Economics

Good Faith has no revenue. Capital lost to defaults and the cost of running the fund are both paid from gifts. [`docs/economics.md`](./economics.md) has the model, the definitions, and every table; the headline numbers at our launch assumptions (a $100,000 fund, 80% out on loan, $300 average loan, a 120-day cycle, a fifth of the principal repaid before a default, 25% escrow, where the "default rate" is the share of loans made in a cycle that end in default):

| default rate | capital lost per year | gifts needed per year, all costs in | cost to donors per completed loan | years for the fund to halve with no gifts |
|---|---|---|---|---|
| 2% | $2,700 | $39,500 | $50 | 25 |
| 5% (base) | $6,700 | $43,500 | $57 | 10 |
| 10% | $13,400 | $50,200 | $69 | 5 |
| 15% | $20,100 | $56,900 | $83 | 3 |

Running costs are about $36,900 a year at those assumptions, five times the capital loss: identity checks, the sponsor's unrecoverable rent and fees, hosting, support, disputes, fraud response and bookkeeping recur ($15,200 a year); the audit, legal work and development are paid once and spread over three years ($21,700 a year). A completed $300 loan costs the donors about $57. The same yearly gifts handed out as $300 grants would reach 145 people; as loans they reach about 770 completed borrowers a year, because the money comes back. That ratio is the case for lending rather than giving, and the default rate is what decides it.

**Bounded bad cases**, from the same model: one cycle at a 30% default rate (a local shock) costs about $13,200; a compromised issuer found after three days can lend at most $15,000 to fake members and lose at most $11,250 under the launch caps ($22,500 and $16,875 without the daily cap); a thousand abusive wallets cost the sponsor about $3,600 a day; an outage across cutoffs costs no money, only fairness to the two or so members whose deadline fell inside it.

**Collusion.** A borrower and co-signer who never intend to repay walk away with the loan minus the escrow: $225 on a $300 loan at 25% escrow, and $113 while the borrower is on the $150 first-loan cap. It costs both of them their eligibility for years, a verified ID on record, and the exposure limits keep any one pair from scaling it. The default rate and the share repaid before default are the two numbers we most need to measure after launch.

## 10. Risks

Please read these before donating, borrowing or co-signing.

- **Smart contract bugs.** Code can have mistakes even after review and testing. A bug could cause losses or lock funds. During the pilot the program can be upgraded to fix one, by a multisig after a delay; that is also a power that could be misused.
- **Defaults draining the fund.** Escrow covers only part of each loan (25% by default). If many borrowers default at once, the fund shrinks and there is less to lend. Donations are gifts, and there is no guarantee the fund is replenished. Section 9 puts numbers on this.
- **Regulatory change.** Laws and regulator views can change. Our reading of Texas law could be wrong or could be overtaken by new rules, which might force changes or a shutdown. The wind-down path exists so that a shutdown is orderly.
- **Stablecoin risk.** USDC could lose its $1 value, and its issuer can freeze any USDC account, including yours, the fund's and an escrow, under legal orders. A frozen escrow no longer blocks a loan from closing, but the money in it stays frozen.
- **Identity risk.** The identity partner could decline people wrongly, change terms or go away; our keys could be compromised (section 4 says what each can and cannot do, and section 9 what it could cost). A stored fingerprint, though keyed and off chain, is still data about you that could be lost in a breach of our server. Duplicate detection is not proof of uniqueness.
- **Recovery risk.** A recovery proposal you do not notice within the delay cannot be vetoed. The app shows pending recoveries and the service holds requests for review first, but the protection depends on someone looking.
- **Network, operator and sponsor risk.** Solana, Good Faith's servers (identity service, cranker, proxy) or the fee sponsor could go down, pausing joining, borrowing or sponsorship. Repayment, default, releases and vetoes never depend on our servers: they can always be done directly on chain with the member command line, and if only the sponsor is down you can act by paying the small network fee yourself. An outage across your cutoff can record you as late.
- **Fee-sponsor funding.** The sponsor is a wallet we keep topped up. If it runs dry, users pay their own network fees until it is refilled.
- **No deposit insurance.** Wallets and the loan fund are not covered by FDIC insurance.

Good Faith is a small, early experiment. Only donate what you can afford to give away, and only co-sign for someone you trust.

## Appendix: verifying what is deployed

Everything below is meant to be checked, not believed. Items marked *to be filled at deploy* are empty until the deployment they describe exists.

- **Source:** the project repository, Apache License 2.0; the paper, the specification ([`docs/spec.md`](./spec.md)), the review ([`docs/audit.md`](./audit.md)), the identity note ([`docs/identity.md`](./identity.md)) and the economics ([`docs/economics.md`](./economics.md)) live beside the code and change with it.
- **Deployment status:** no public deployment yet. The program runs on a local fork of the test network in automated tests. *Devnet program id, pool account and keys: to be filled at deploy.* The id declared in the source is `BM71D4Kdnq3Mtc2cqDuMBLyYguFihDqsjk9btdTWtoRd`; the devnet deployment will use a fresh keypair and the id will be published here.
- **Release tag and build hash:** *to be filled at deploy.* The program is built with `anchor build --arch v2` from a tagged commit; the SHA-256 of `target/deploy/goodfaith.so` is published with the tag, and `solana program dump` of the deployed account must hash to the same value.
- **Upgrade authority:** *to be filled at deploy*: the upgrade multisig and its delay during the pilot; "none" once the program is made permanent (`solana program show` prints "Upgrade authority: none").
- **Pool account, mint, administrator, pause key, issuer, recovery key, every setting:** read from the pool account on chain (`Pool` layout in the specification); the app pins the pool address, the mint, the gatekeeper network and the administrator in its configuration and refuses anything else. The member command line reads the same account.
- **Gatekeeper network and keys:** the network's public key and the issuer, recovery and pause keys are published with the deployment; passes can be looked up on chain for any wallet.
- **Audit scope and status:** internal review published in [`docs/audit.md`](./audit.md) (findings GF-01 to GF-20); *independent audit: to be filled when complete.*
- **Tests:** the program's scenario and property tests (`cargo test -p goodfaith`), the app's unit tests and simulator scenarios (`npm test`, `npm run test:svm` in `app/`), and the end-to-end scripts in `scripts/`, all run by the repository's continuous integration on every change; what they check is listed in section 7.
