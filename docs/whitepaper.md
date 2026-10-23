# Good Faith

**Interest-free, fee-free loans, funded by gifts. goodfaith.fi**

*Status: early version running on a test network. Nothing here is financial or legal advice.*

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

There are no collection agencies, no late fees and no added charges. The consequence is losing access, and the co-signer losing their deposit.

### Your money stays yours

Good Faith includes a free "checking" feature. It is simply **your own digital wallet**: an app that holds your money under a private key only you control. Good Faith does not hold your money, and nobody else can freeze or move it. If our website disappeared tomorrow, your wallet would still work.

## 3. Why Solana

Good Faith runs on Solana, a public blockchain. We chose it for two practical reasons.

- **Tiny fees.** A transaction costs a fraction of a cent.
- **Speed.** Transactions confirm in about a second.

On most blockchains you must hold a separate coin just to pay network fees. That is a real barrier for a new user. Good Faith avoids it with a **fee sponsor** (software called Kora): the fund pays the network fee for you. **You pay $0.**

**Honest tradeoffs.** Solana has had outages in the past, some lasting hours, and it is a younger network than some alternatives. If the network is down, you cannot borrow or repay until it returns. Your funds are not lost during an outage, but access is paused. Late repayments caused by an outage are a known concern, and the grace period exists partly to soften this.

## 4. Who can use it

**Texas residents only**, for now. Everyone who borrows, co-signs or uses Good Faith features that involve loans must pass an identity check through **Civic Pass**, a service that verifies a government ID and your location and then issues a digital pass tied to your wallet. Good Faith only checks that your pass is valid. Your ID details stay with Civic and are never put on the blockchain.

### The legal approach

*This is the project's own reading of the law. It is not legal advice, and it has not been confirmed by a regulator or a court.*

- **0% loans.** The Texas Finance Code chapter 342, which regulates consumer loans, does not apply to loans at 10% a year or less (Texas Finance Code [§342.004](https://law.justia.com/codes/texas/finance-code/title-4/subtitle-b/chapter-342/subchapter-a/section-342-004/)). Good Faith loans charge 0%.
- **Donations, not deposits.** The fund is built from gifts. Nobody is promised their money back, so Good Faith is not taking deposits.
- **Non-custodial.** Good Faith never holds anyone's personal money. Your wallet is yours. The only pooled money is the donated fund, and the only temporary holds are co-signer escrows governed by public code.

We plan to seek qualified Texas legal review before any public launch.

## 5. Security

- **Public and verifiable on chain.** The deployed program and every loan, repayment and donation are recorded on the blockchain for anyone to check. The source code is proprietary and is shared with independent auditors.
- **Checked math.** Every calculation uses overflow-safe arithmetic. If a number would go out of range, the transaction fails instead of producing a wrong result. The code contains no fee or interest fields at all.
- **Independent review.** Findings from our security review are published in [`docs/audit.md`](./audit.md).
- **Frozen upgrades.** Before real money is involved (mainnet), the program's upgrade key is permanently removed. After that, nobody, including us, can change the rules. The tradeoff: if a bug is found later, fixing it means launching a new version and moving over deliberately.

## 6. Roadmap

1. **Test network MVP (now).** Working program and web app using play money on Solana's test network ("devnet").
2. **Audit.** Independent security audit and fixes.
3. **Mainnet in Texas.** Launch with real dollars, a conservative loan cap and Texas-only access.
4. **Bank partner for dollar accounts.** A regulated bank partner so users can hold ordinary US dollar accounts alongside their wallet.
5. **More states.** Expand state by state, after reviewing each state's law.

## 7. Risks

Please read these before donating, borrowing or co-signing.

- **Smart contract bugs.** Code can have mistakes even after review. A bug could cause losses or lock funds.
- **Defaults draining the fund.** Escrow covers only part of each loan (25% by default). If many borrowers default, the fund shrinks and there is less to lend. Donations are gifts, and there is no guarantee the fund is replenished.
- **Regulatory change.** Laws and regulator views can change. Our reading of Texas law could be wrong or could be overtaken by new rules, which might force changes or a shutdown.
- **Stablecoin risk.** The digital dollars could lose their $1 value, or the company behind them could be frozen or fail. Funds in the loan fund and your wallet are exposed to this.
- **Network and identity-service risk.** Solana or Civic could go down or change terms, pausing borrowing and repayment.
- **No deposit insurance.** Wallets and the loan fund are not covered by FDIC insurance.

Good Faith is a small, early experiment. Only donate what you can afford to give away, and only co-sign for someone you trust.
