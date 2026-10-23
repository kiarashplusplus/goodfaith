# Good Faith

**Interest-free, fee-free loans, funded by gifts. goodfaith.fi**

*Status: early version running on a test network. The code has been through an internal security review and automated testing; an independent audit is still ahead. Nothing here is financial or legal advice.*

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

The fund holds digital dollars (a "stablecoin", a crypto token designed to always be worth one US dollar). It sits in a public program on a blockchain (a shared record anyone can inspect and nobody can quietly edit). Rules are enforced by code, not by a staff member's discretion.

### Borrowing

- **Repay exactly what you borrow.** Borrow $300, repay $300. No interest, no fees, no penalties.
- **Per-loan cap.** Each loan has a maximum size, so the fund is spread across many people.
- **One loan at a time.** A borrower can have only one open loan.
- **Set term and grace period.** Each loan has a repayment deadline (up to a maximum number of days), followed by a grace period before it counts as a default.

### The co-signer

Every loan needs a **co-signer**: someone who vouches for you and puts up part of the loan amount as a safety deposit. By default that is **25% of the loan** (the fund can change this setting). The deposit is locked in "escrow", a separate holding account that neither of you can touch until the loan ends.

- If you repay in full, the co-signer gets the full deposit back.
- If you do not repay, the deposit is used to cover what is missing (see below).
- A co-signer can back only a limited number of loans at once.
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
          Borrower AND co-signer can no longer use Good Faith.
```

### What a default means

If a loan is still unpaid after the term and the grace period, anyone can trigger the default step. Then:

1. The unpaid balance is taken from the co-signer's escrow and sent to the fund.
2. If the escrow is bigger than the unpaid balance, the extra goes back to the co-signer.
3. If the escrow is smaller, the fund absorbs the loss. That is why the escrow amount and the loan cap matter.
4. Both the borrower and the co-signer become **ineligible** for future loans or co-signing.

There are no collection agencies, no late fees and no added charges. The consequence is losing access, and the co-signer losing their deposit. Until someone triggers the default step, the loan can still be repaid in full and closes normally.

### Your money stays yours

Good Faith includes a free "checking" feature. It is simply **your own digital wallet**: an app that holds your money under a private key only you control. Good Faith does not hold your money, and nobody else can freeze or move it. If our website disappeared tomorrow, your wallet would still work.

One detail of how Solana works: sending digital dollars to a wallet that has never held them creates a small account on the blockchain, which costs the sender about 0.002 SOL (a few cents). The fee sponsor described below covers Good Faith's own transactions, not accounts created for other people.

## 3. Why Solana

Good Faith runs on Solana, a public blockchain. We chose it for two practical reasons.

- **Tiny fees.** A transaction costs a fraction of a cent.
- **Speed.** Transactions confirm in about a second.

On most blockchains you must hold a separate coin just to pay network fees. That is a real barrier for a new user. Good Faith avoids it with a **fee sponsor** (software called Kora): when the sponsor is running, joining, borrowing, co-signing, repaying and donating cost you nothing, including the small refundable deposits ("rent") Solana requires for new accounts. The app shows you whether fees are covered at any moment. If the sponsor cannot be reached, your wallet pays the network fee and rent itself, and the app tells you so before you act. The sponsor never quietly charges you, and it only pays for Good Faith's own transactions.

**Honest tradeoffs.** Solana has had outages in the past, some lasting hours, and it is a younger network than some alternatives. If the network is down, you cannot borrow or repay until it returns. Your funds are not lost during an outage, but access is paused. Late repayments caused by an outage are a known concern, and the grace period exists partly to soften this.

## 4. Who can use it

**Texas residents only**, for now. Everyone who borrows or co-signs must pass a government-ID and Texas-residency check with an identity provider (currently **Civic Pass**), which then issues a digital pass tied to the wallet. Good Faith only checks that the pass is valid. Your ID details stay with the provider and are never put on the blockchain.

### The legal approach

*This is the project's own reading of the law. It is not legal advice, and it has not been confirmed by a regulator or a court.*

- **0% loans.** The Texas Finance Code chapter 342, which regulates consumer loans, does not apply to loans at 10% a year or less (Texas Finance Code [§342.004](https://law.justia.com/codes/texas/finance-code/title-4/subtitle-b/chapter-342/subchapter-a/section-342-004/)). Good Faith loans charge 0%.
- **Donations, not deposits.** The fund is built from gifts. Nobody is promised their money back, so Good Faith is not taking deposits.
- **Non-custodial.** Good Faith never holds anyone's personal money. Your wallet is yours. The only pooled money is the donated fund, and the only temporary holds are co-signer escrows governed by public code.

We plan to seek qualified Texas legal review before any public launch.

## 5. How the fund is run

The fund has one **administrator** key. It can change the fund's settings: the loan cap, the longest term, the grace period, the co-signer deposit rate, how many loans one co-signer may back, and which identity network is accepted. It cannot move money. Donations can only leave the fund as loans, repayments only flow back into it, and an escrow can only go to the co-signer or to the fund. No setting adds a fee or interest; the code has no field for one.

- **Open loans are never changed.** A settings change applies to future loans only. Each loan keeps the grace period it was opened with, so the administrator cannot shorten a deadline after the fact.
- **Handing over the role takes two steps.** The current administrator names the next key, and that key has to accept. A mistyped key cannot lock the fund. The plan is to hand the role to a multi-signature wallet (two of three devices must agree) before real money is involved.
- **Freezing the rules.** The administrator can permanently give up the role. After that nobody, including us, can change the settings, and any pending handover is cancelled with it. The rules will be frozen before the fund accepts real funds.
- **Everything is announced.** Every action, from a loan opening to a settings change or a handover, is recorded as a public event on the blockchain.

## 6. Security

- **Public and verifiable on chain.** The deployed program and every loan, repayment and donation are recorded on the blockchain for anyone to check. The source code is proprietary and is shared with independent auditors.
- **Checked math.** Every calculation uses overflow-safe arithmetic. If a number would go out of range, the transaction fails instead of producing a wrong result. The code contains no fee or interest fields at all.
- **Security review.** An internal review of the program is published in [`docs/audit.md`](./audit.md). Its findings, such as binding a co-signer to the exact terms they approved and fixing each loan's grace period at opening, were corrected and are now covered by tests that would catch them coming back. An independent audit is planned before mainnet.
- **Frozen upgrades.** Before real money is involved (mainnet), the program's upgrade key is permanently removed. After that, nobody, including us, can change the code. The fund's rules can be frozen the same way (see section 5). The tradeoff: if a bug is found later, fixing it means launching a new version and moving over deliberately.

## 7. How we tested it

Tests reduce risk; they do not remove it. See the risks in section 9. What runs today:

- **The program.** 48 automated tests, including property tests that play thousands of random sequences of donations, loans, repayments, defaults and settings changes and check after every step that the fund's books balance: the money in the fund equals gifts plus repayments plus recovered escrow minus loans out.
- **The app.** The web app's own transaction code runs against the compiled program in a local simulator, in 15 scenarios from joining to a loan being marked as defaulted at the exact end of its grace period.
- **End to end.** The full loan cycle, including cancellation, settings changes, the administrator handover and freezing, runs on a local copy of Solana's test network, and the fee-sponsor flows run against a real sponsor, checking that users paid nothing and the sponsor paid exactly what it should.
- **On every change.** All of the above runs automatically whenever the code changes.

## 8. Roadmap

1. **Test network version (now).** Working program, web app, fee sponsor and automated testing, using play money on Solana's test network ("devnet").
2. **Audit.** Independent security audit and fixes.
3. **Hand over and freeze.** Move the administrator role to a multi-signature wallet, settle the rules, freeze them.
4. **Mainnet in Texas.** Launch with real dollars, a conservative loan cap and Texas-only access.
5. **Bank partner for dollar accounts.** A regulated bank partner so users can hold ordinary US dollar accounts alongside their wallet.
6. **More states.** Expand state by state, after reviewing each state's law.

## 9. Risks

Please read these before donating, borrowing or co-signing.

- **Smart contract bugs.** Code can have mistakes even after review and testing. A bug could cause losses or lock funds.
- **Defaults draining the fund.** Escrow covers only part of each loan (25% by default). If many borrowers default, the fund shrinks and there is less to lend. Donations are gifts, and there is no guarantee the fund is replenished.
- **Regulatory change.** Laws and regulator views can change. Our reading of Texas law could be wrong or could be overtaken by new rules, which might force changes or a shutdown.
- **Stablecoin risk.** The digital dollars could lose their $1 value, or the company behind them could be frozen or fail. Funds in the loan fund and your wallet are exposed to this.
- **Network, identity and sponsor risk.** Solana, the identity provider or the fee sponsor could go down or change terms, pausing borrowing and repayment. If only the sponsor is down, you can still act by paying the small network fee yourself.
- **Fee-sponsor funding.** The sponsor is a wallet we keep topped up. If it runs dry, users pay their own network fees until it is refilled.
- **No deposit insurance.** Wallets and the loan fund are not covered by FDIC insurance.

Good Faith is a small, early experiment. Only donate what you can afford to give away, and only co-sign for someone you trust.
