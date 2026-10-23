# Good Faith

**Interest-free, fee-free loans, funded by gifts. goodfaith.fi**

*Status: version 2 of the design, running on a test network with play money. The code has been through an internal security review and automated testing; an independent audit is still ahead. Nothing here is financial or legal advice.*

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

The fund holds digital dollars (USDC, a "stablecoin" designed to always be worth one US dollar; see section 3 for what that does and does not mean). It sits in a public program on a blockchain (a shared record anyone can inspect and nobody can quietly edit). Rules are enforced by code, not by a staff member's discretion.

### Borrowing

- **Repay exactly what you borrow.** Borrow $300, repay $300. No interest, no fees, no penalties.
- **Per-loan cap.** Each loan has a maximum size, so the fund is spread across many people.
- **One loan at a time, per person.** A person can have only one open loan, whichever wallet they use.
- **Set term and grace period.** Each loan has a repayment deadline (up to a maximum number of days), followed by a grace period before it counts as a default.

### The co-signer

Every loan needs a **co-signer**: a different person who vouches for you and puts up part of the loan amount as a safety deposit. By default that is **25% of the loan** (the fund can change this setting, with notice). The deposit is locked in "escrow", a separate holding account that neither of you can touch until the loan ends.

- If you repay in full, the co-signer gets the full deposit back.
- If you do not repay, the deposit is used to cover what is missing (see "What a default means").
- A co-signer can back only a limited number of loans at once (two, at launch).
- The co-signer agrees to the exact terms they see. If the request changes after that, their approval no longer applies and they have to look again.

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
    +-- On time:  escrow returned to co-signer. Done.

    +-- Late past the grace period (default):
          escrow pays the unpaid balance to the fund, up to the
          amount held. Anything left over goes back to the co-signer.
          The borrower can no longer use Good Faith. The co-signer
          can, unless the fund lost money on the loan.
```

### What a default means

A loan is in default once it is still unpaid after its term and its grace period, to the second. From that moment anyone may trigger the default step, and the fund's own scheduled job (the "cranker", section 6) does so within minutes, so the outcome does not depend on who happens to be watching. Then:

1. The unpaid balance is taken from the co-signer's escrow and sent to the fund.
2. If the escrow is bigger than the unpaid balance, the extra goes back to the co-signer.
3. If the escrow is smaller, the fund absorbs the loss. That is why the escrow amount and the loan cap matter.
4. The borrower becomes **ineligible** for future loans or co-signing, under any wallet.
5. The co-signer becomes ineligible **only if the fund lost money**: their deposit did not cover what was owed. If the escrow covered everything, the co-signer keeps their standing. Their deposit was the promise, and they kept it.

There are no collection agencies, no late fees and no added charges. The default step ends the debt as far as the program is concerned: nothing more is owed on chain. Until someone triggers it, a late loan can still be repaid in full and closes normally, and a repayment made during a network outage counts the moment it lands.

### Your money stays yours

Good Faith does not hold your money. The app includes a plain **wallet** view: your own digital wallet, holding USDC under a private key only you control. Good Faith cannot move it. If our website disappeared tomorrow, your wallet and your USDC would still be there.

Two things that are true of every USDC wallet, including this one:

- **The stablecoin issuer can freeze USDC.** USDC is issued by Circle, and the token on Solana has a "freeze authority": Circle can freeze any USDC account, which it does under legal orders. That applies to your wallet, to the loan fund and to escrows alike. Good Faith has no such power and cannot undo a freeze. On the test network the play-money USDC has the same property.
- **Creating an account costs a little.** Sending USDC to a wallet that has never held it creates a small account on the blockchain, which costs the sender about 0.002 SOL (a few cents). The fee sponsor (section 3) covers Good Faith's own transactions, not accounts created for other people.

### What to expect as a borrower

This is what the journey looks like today. These are the current options, not promises.

1. **Verify once.** A one-time identity check (section 4) from a phone or computer, a few minutes.
2. **Ask a friend.** You enter the amount, the term and your co-signer's wallet address; they get a link, review the exact terms and approve. The moment they do, the USDC is in your wallet.
3. **Spend it.** USDC in a wallet is not yet dollars in a bank account. Today you can send it to anyone with a Solana wallet, spend it where USDC is accepted, or convert it through a crypto exchange or an "off-ramp" service that pays out to a bank account. Those services charge their own fees (typically well under 1%) and take minutes to a few days, and they have their own identity checks. We are working on a bank partner so that this step disappears (section 8).
4. **Repay.** Any amount, any time, from any wallet, including a friend's. The app shows the due date, the grace days left and exactly what is still owed.

## 3. Why Solana, and what the fee sponsor does

Good Faith runs on Solana, a public blockchain, for two practical reasons: a transaction costs a fraction of a cent and confirms in about a second.

On most blockchains you must hold a separate coin just to pay network fees. That is a real barrier for a new user. Good Faith avoids it with a **fee sponsor** (software called Kora): when the sponsor is running, joining, borrowing, co-signing, repaying and donating cost you nothing, including the small refundable deposits ("rent") Solana requires for new accounts. The app shows you whether fees are covered at any moment. If the sponsor cannot be reached, your wallet pays the network fee and rent itself, and the app tells you so before you act. The sponsor never quietly charges you, it only pays for Good Faith's own transactions, and it never pays to create accounts for strangers.

**Honest tradeoffs.** Solana has had outages in the past, some lasting hours. If the network is down, you cannot borrow or repay until it returns. Your funds are not lost during an outage, but access is paused. The grace period exists partly to soften late repayments caused by an outage, and a default is only ever triggered after the grace period ends.

## 4. Who can use it, and how we know

**Texas residents, 18 or older**, for now. Everyone who borrows or co-signs verifies once with Good Faith's own identity service.

### One verified person, one membership

The earlier design relied on Civic Pass, a third-party identity pass tied to a wallet. Civic discontinued that service in July 2025, and it never answered the question that matters most to a lending fund: a wallet is not a person. Someone barred for a default could have come back with a new wallet. Version 2 fixes both.

- **The check.** Our verification partner (Persona) checks your government ID, that it is issued in Texas, and your age, in a hosted flow on your phone or computer. Good Faith's server learns the outcome and a few fields of the ID, never your selfie or your documents.
- **The fingerprint.** From the ID number, the issuing state and the birth date, the server computes a keyed hash: a fixed-length fingerprint that is the same every time the same ID is verified and cannot be turned back into the ID. The key is a server secret. Nothing else about you (not your name, address or photo) is stored by Good Faith or put on the blockchain.
- **The pass.** The server issues a pass to your wallet on the fund's own gatekeeper network (the same on-chain pass format the earlier Civic design used, now issued by us). The program checks the pass on every request and co-sign.
- **The membership.** Joining is a transaction signed by you *and* by the fund's identity issuer, which vouches on chain that your wallet belongs to your fingerprint. The program keeps one **person** record per fingerprint, and one wallet per person. Eligibility, the open loan and the guarantees live on the person, not the wallet.

### Lost keys, and why a ban sticks

If you lose your wallet, you verify again from a new one. The server recognises the same fingerprint, and the issuer signs a "replace my wallet" transaction: the old wallet is retired for good, the new wallet takes over your membership, open loans and guarantees, and any escrow refund you are owed goes to the new wallet. The old wallet never has to sign, because you no longer have it.

The same mechanism is what makes a default final. A barred person who verifies again, from any wallet, produces the same fingerprint, and the server refuses them before anything reaches the chain. Their pass is revoked at the moment of the default.

### Borrower and co-signer are different people

The program checks that the two people behind a loan are different person records, not merely different wallets.

### What we trust

The issuer is a key held by Good Faith's server. It cannot move money, open loans or change the fund's settings. What it can do is vouch for memberships and wallet replacements, which is why it is treated as a privileged key: it can be replaced only through the fund's seven-day notice process, it can be suspended instantly if it is ever compromised, and every registration and wallet replacement is a public event the operator monitors. The security review (section 7) rates this as the design's main residual risk and lists the mitigations.

### The legal approach

*This is the project's own reading of the law. It is not legal advice, and it has not been confirmed by a regulator or a court.*

- **0% loans.** The Texas Finance Code chapter 342, which regulates consumer loans, does not apply to loans at 10% a year or less (Texas Finance Code [§342.004](https://law.justia.com/codes/texas/finance-code/title-4/subtitle-b/chapter-342/subchapter-a/section-342-004/)). Good Faith loans charge 0%.
- **Donations, not deposits.** The fund is built from gifts. Nobody is promised their money back, so Good Faith is not taking deposits.
- **Non-custodial.** Good Faith never holds anyone's personal money. Your wallet is yours. The only pooled money is the donated fund, and the only temporary holds are co-signer escrows governed by public code.

**Open questions for counsel.** Before any launch with real money we will put these to a Texas attorney, and we do not claim to know the answers: who the lender is in law when a program lends donated money (the operator, the donors, nobody); who owns the donated assets and what duties come with holding them; whether facilitating loans between people, or issuing identity passes, brings licensing obligations; whether the fee sponsor or the wallet feature touch money-transmission rules; which consumer-protection and disclosure rules apply to a 0% loan; what the privacy law says about the identity check and the stored fingerprint; and how donations are treated for tax purposes on both sides.

## 5. How the fund is run

The fund has one **administrator** key. It can change the fund's settings: the loan cap, the longest term, the grace period, the co-signer deposit rate, how many loans one co-signer may back, which gatekeeper network and which identity issuer are accepted, and the length of the notice period itself. It cannot move money, except in one announced case described below. Donations can only leave the fund as loans, repayments only flow back into it, and an escrow can only go to the co-signer or to the fund. No setting adds a fee or interest; the code has no field for one.

- **Every change has a notice period.** A settings change is announced first and takes effect only after the fund's notice period (**7 days** at launch, shown in the app), measured with the notice period in force when it was announced, so shortening the notice period itself waits the old delay. Anyone, not just the administrator, can apply the change once the time has passed; the administrator can withdraw it before then. Nothing applies silently.
- **Open loans are never changed.** A settings change applies to future loans only. Each loan keeps the grace period it was opened with, so the administrator cannot shorten a deadline after the fact.
- **Handing over the role takes two steps.** The current administrator names the next key, and that key has to accept. A mistyped key cannot lock the fund. The plan is to hand the role to a multi-signature wallet (two of three devices must agree) before real money is involved.
- **An instant brake, nothing else.** The one thing the administrator can do at once is suspend the identity issuer, which stops new memberships and wallet replacements until a new issuer is announced and applied. Existing members are unaffected.
- **Winding down, with a successor.** The administrator can announce that the fund is closing and name a successor: a token account of the same currency that is not controlled by the fund itself (for example a new version of Good Faith, or a charity). After the notice period, the fund stops taking new loans and donations; open loans run their course, repayments still come in, defaults still settle, and members can still join or replace a wallet. Once no loan is open, anyone can move the remaining balance to the successor. The announcement can be withdrawn before it takes effect, not after.
- **Freezing the rules is optional.** The administrator can still permanently give up the role, which also discards any announced settings change. A frozen fund keeps an already announced wind-down, so it can still be retired in an orderly way. With the notice period in place, freezing is no longer the only way to protect members from a rushed change, so we may keep a live, multi-signature administrator for as long as the fund runs.
- **Everything is announced.** Every action, from a loan opening to a settings change, a handover, an issuer suspension or a wind-down, is recorded as a public event on the blockchain.

## 6. Operations

Three pieces of software run beside the program, all open to inspection and all replaceable:

- **The identity service** (section 4): opens checks, receives the partner's results, issues and revokes passes, co-signs memberships. It stores the fingerprint, the wallet, the inquiry id and a status, in a database on the server.
- **The fee sponsor** (section 3): a Kora server behind the app's own proxy, which holds the credentials, forwards only three operations and limits each client.
- **The cranker**: a scheduled job that does, on time, what anyone is allowed to do: it marks loans past due and grace as defaulted (and, where the fund lost money, bars the co-signer too), applies settings changes whose notice period has passed, moves the balance to the successor once a wind-down is complete, and tells the identity service which people were barred so their passes are revoked. If the cranker stops, nothing is lost: any member or stranger can do each of these things by hand, and the program's rules do not change.

## 7. Security and testing

- **Public and verifiable on chain.** The deployed program and every loan, repayment and donation are recorded on the blockchain for anyone to check. The source code is proprietary and is shared with independent auditors.
- **Checked math.** Every calculation uses overflow-safe arithmetic. If a number would go out of range, the transaction fails instead of producing a wrong result. The code contains no fee or interest fields at all.
- **Security review.** An internal review of the program is published in [`docs/audit.md`](./audit.md). Its findings, such as binding a co-signer to the exact terms they approved and fixing each loan's grace period at opening, were corrected and are covered by tests that would catch them coming back. The version 2 review adds the issuer key as the main residual risk (a compromised issuer colluding with a wallet could register one human twice, or move someone's membership to a wallet it controls, but could not move fund money), the notice-period lag when rotating that key, and the trust placed in the successor named in a wind-down. An independent audit is planned before mainnet.
- **Frozen upgrades.** Before real money is involved (mainnet), the program's upgrade key is permanently removed. After that, nobody, including us, can change the code. The tradeoff: if a bug is found later, fixing it means launching a new version and moving over deliberately, which is exactly what the wind-down and successor path is for.

Tests reduce risk; they do not remove it. See the risks in section 10. What runs today, automatically, on every change:

- **The program.** 59 automated tests, including property tests that play thousands of random sequences of donations, loans, repayments, defaults, wallet replacements, announced and applied settings changes, wind-downs and sweeps, and check after every step that the fund's books balance: the money in the fund equals gifts plus repayments plus recovered escrow minus loans out minus anything moved to the successor, and that eligibility, open loans and guarantees always sit with the right person.
- **The app.** The web app's own transaction code runs against the compiled program in a local simulator in 19 scenarios, from an issuer-signed join to a wallet replacement whose escrow refund lands in the new wallet, a settings change applied by a stranger after its notice period, and a wind-down swept to a successor. 59 further unit tests cover the identity service (the partner's signed webhooks, the fingerprint, the stores, the wallet's proof of control, the join and replacement transactions), the fee-sponsor proxy and the economic model.
- **End to end.** On a local copy of Solana's test network: the fund's own gatekeeper network is created and real passes are issued by the on-chain gateway program; the full loan cycle runs with cancellation, a wallet replacement, a settings change across a time jump, an issuer suspension and restoration, a wind-down with sweep, the administrator handover and freezing; the sponsored flows run against a real sponsor, directly and through the app's proxy, checking that users paid nothing and the sponsor paid exactly what it should; the identity flow runs from the wallet's signed proof to the sponsored join, a replacement, a declined and an out-of-state check and a ban with the pass revoked; and the cranker marks a one-day loan as defaulted and has the pass revoked.

## 8. Roadmap

1. **Test network version (now).** Working program, web app, identity service (with a mock partner on the test network), fee sponsor, cranker and automated testing, using play money on Solana's test network ("devnet").
2. **Identity partner in production mode.** Persona's live checks, the field mapping confirmed against real inquiries, the notice period set to 7 days.
3. **Audit.** Independent security audit and fixes.
4. **Hand over.** Move the administrator role to a multi-signature wallet; decide whether to freeze.
5. **Mainnet in Texas.** Launch with real dollars, a conservative loan cap and Texas-only access.
6. **Bank partner for dollar accounts.** A regulated bank partner so users can hold ordinary US dollar accounts alongside their wallet and skip the conversion step.
7. **More states.** Expand state by state, after reviewing each state's law.

## 9. Economics

Good Faith has no revenue. Capital lost to defaults and the cost of running the fund are both paid from gifts. [`docs/economics.md`](./economics.md) has the model and nine scenarios; the headline numbers, with our launch assumptions (a $100,000 fund, 80% out on loan, $300 average loan, a 120-day cycle, a fifth of the principal repaid before a default, 25% escrow):

| default rate | capital lost per year | share of the fund | gifts needed per year (incl. running costs) |
|---|---|---|---|
| 2% | $2,700 | 2.7% | $16,500 |
| 5% | $6,700 | 6.7% | $20,500 |
| 10% (reviewer's case, nothing repaid, fully lent) | $22,800 | 22.8% | $36,700 |
| 15% | $20,100 | 20.1% | $33,900 |

Running costs are about $13,800 a year at those assumptions: identity checks for new members, the sponsor's unrecoverable rent and fees per loan, hosting, and an independent audit amortised over the year. They are mostly fixed, so a small fund costs nearly as much to run as a large one.

**Collusion.** A borrower and co-signer who never intend to repay walk away with the loan minus the escrow: $225 on a $300 loan at 25% escrow. The fund limits each person to one open loan and each co-signer to two guarantees, caps loans, and keeps one membership per verified person, so a pair can do it once and both lose their membership for good with a verified ID on record. Raising the escrow rate lowers the payoff; at 100% there is none. The default rate and the share repaid before default are the two numbers we most need to measure after launch, and the tables will be regenerated from them.

## 10. Risks

Please read these before donating, borrowing or co-signing.

- **Smart contract bugs.** Code can have mistakes even after review and testing. A bug could cause losses or lock funds.
- **Defaults draining the fund.** Escrow covers only part of each loan (25% by default). If many borrowers default, the fund shrinks and there is less to lend. Donations are gifts, and there is no guarantee the fund is replenished. Section 9 puts numbers on this.
- **Regulatory change.** Laws and regulator views can change. Our reading of Texas law could be wrong or could be overtaken by new rules, which might force changes or a shutdown. The wind-down path exists so that a shutdown is orderly.
- **Stablecoin risk.** USDC could lose its $1 value, and its issuer can freeze any USDC account, including yours, the fund's and an escrow, under legal orders. Funds in the loan fund and your wallet are exposed to this.
- **Identity risk.** The identity partner could decline people wrongly, change terms or go away; the issuer key could be compromised (see section 4 for what that could and could not do). A stored fingerprint, though keyed, is still data about you that could be lost in a breach of our server.
- **Network, operator and sponsor risk.** Solana, Good Faith's server (identity service, cranker, proxy) or the fee sponsor could go down, pausing joining, borrowing or sponsorship. Repayment and default never depend on our server: they can always be done directly on chain, and if only the sponsor is down you can act by paying the small network fee yourself.
- **Fee-sponsor funding.** The sponsor is a wallet we keep topped up. If it runs dry, users pay their own network fees until it is refilled.
- **No deposit insurance.** Wallets and the loan fund are not covered by FDIC insurance.

Good Faith is a small, early experiment. Only donate what you can afford to give away, and only co-sign for someone you trust.

## Appendix: verifying what is deployed

Everything below is meant to be checked, not believed. Items marked *to be filled at deploy* are empty until the test-network or mainnet deployment they describe exists.

- **Program id:** `BM71D4Kdnq3Mtc2cqDuMBLyYguFihDqsjk9btdTWtoRd` (the id declared in the source; on the test network it is planted on a local fork for testing. *Devnet and mainnet deployments: to be filled at deploy.*)
- **Release tag and build hash:** *to be filled at deploy.* The program is built with `anchor build --arch v2` from a tagged commit; the SHA-256 of `target/deploy/goodfaith.so` is published with the tag, and `solana program dump` of the deployed account must hash to the same value.
- **Upgrade authority:** *to be filled at deploy.* Before mainnet it is set to none (`solana program show` prints "Upgrade authority: none").
- **Pool account, mint, administrator and issuer keys, notice period:** read from the pool account on chain (`Pool` layout in [`docs/spec.md`](./spec.md)); the app pins the pool address, the mint, the gatekeeper network and the administrator in its configuration and refuses anything else.
- **Gatekeeper network and issuer:** the network's public key and the issuer's public key are published with the deployment; passes can be looked up on chain for any wallet.
- **Audit scope and status:** internal review published in [`docs/audit.md`](./audit.md) (findings GF-01 to GF-13); *independent audit: to be filled when complete.*
- **Tests:** `cargo test -p goodfaith` (59), `npm test` in `app/` (59), `npm run test:svm` (19), and the end-to-end scripts in `scripts/`, all run by the repository's continuous integration on every change.
