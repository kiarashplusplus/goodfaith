# Good Faith

**Interest-free, fee-free loans, funded by gifts. goodfaith.fi**

*Status: version 5 of the design, running on a test network with play money. The source is published. The program has been through an internal security review and automated testing; an independent audit is still ahead. Nothing here is financial or legal advice.*

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

The fund holds digital dollars (USDC, a "stablecoin" designed to always be worth one US dollar; see section 3 for what that does and does not mean). It sits in a public program on a blockchain (a shared record anyone can inspect and nobody can quietly edit). The rules in this paper are the program's rules; the people who run the fund can change the settings, with notice, and nothing else (section 5 says exactly what, and names the two roles this paper uses: the **administrator**, a multisig that holds the settings, and the **operator**, the organisation that runs the services day to day).

### Borrowing

- **Repay exactly what you borrow.** Borrow $300, repay $300. No interest, no fees, no penalties.
- **Caps that grow with you, slowly.** A new member can borrow up to the first-loan cap ($150 at launch) for the first month. A loan repaid by its deadline raises your personal cap by $100, up to the fund's maximum ($500), but only if the loan ran for at least 30 days, and at most once every 30 days. Borrowing and repaying the same hour does not count. A loan settled after its deadline never counts, even once it is paid back, and a settlement puts you back on the first-loan cap for a month, as if you had just joined.
- **One loan at a time, per person.** A person can have only one open loan, whichever wallet they use, and the total of what they borrow and what they guarantee for others is capped ($1,000 at launch). That cap counts the whole amount you guarantee, not only the deposit you put up: it limits how concentrated the fund's risk is in one person, while the deposit is what covers a loss.
- **The fund has a ceiling too.** No more than a set amount of principal is out on loan at once ($25,000 at launch), and no more than a set amount goes out per day ($5,000 at launch). Money the fund already owes to co-signers (section "What a default means") is never lent out.
- **Set term and grace period.** Each loan has a repayment deadline (up to a maximum number of days), followed by a grace period. The last second of the grace period is the cutoff. The term, the grace period, the deposit rate, the three bar durations and the cap rules are written into the loan when it opens; a later settings change never touches them.

### The co-signer

Every loan needs a **co-signer**: a different person who vouches for you and puts up part of the loan amount as a safety deposit. By default that is **25% of the loan** (the fund can change this setting, with notice). The deposit is locked in "escrow", a separate holding account that neither of you can touch until the loan ends.

Co-signing is a real financial commitment, and we state it plainly:

- If the borrower repays in full by the cutoff, the deposit is owed back to the co-signer in full, and they (or anyone on their behalf) release it to their wallet.
- If the borrower does not, the deposit is used to cover what is missing, up to the whole deposit. **It comes back only if the borrower pays back**, which nothing forces them to do. The co-signer can also **forgive** the rest of the debt, which ends the borrower's obligation and gives up the used deposit for good.
- If the deposit did not cover what was missing, so the fund lost money, the co-signer is **barred** from borrowing and co-signing (one year at launch) **until the fund's loss on every loan they guaranteed is covered**, by whoever pays it. If the deposit covered everything, the co-signer keeps their standing.
- A co-signer can back only a limited number of loans at once (two, at launch), two people cannot guarantee each other at the same time, and a co-signer's guarantees count against their own exposure cap.
- The co-signer agrees to the exact terms they see: the amount, the term, the grace period, the deposit and the bar they would face. If the request or the fund's settings change after that, their approval no longer applies and they have to look again. A request that nobody co-signs expires after a week.
- Money sent to an escrow after the cutoff is owed back to the co-signer and never counts towards what the borrower owed; topping up a deposit cannot turn a loss into a recovery.

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
    |   +------ repay $300 (any amount, by anyone, until the cutoff) ---+
    |
    +-- Repaid by the cutoff:  the $75 is owed back to the co-signer,
    |                          who releases it to their wallet. Done.
    |
    +-- Not repaid by the cutoff: repayment closes. The loan is SETTLED
          (by anyone, the borrower included): what is owed is set aside
          from the escrow, up to the deposit; anything above the deposit
          is owed back to the co-signer. The borrower is barred for a
          long time and goes back to the first-loan cap; the co-signer
          is barred for a shorter time, only if the fund lost money.
            |
            +-- The borrower PAYS BACK what was owed, in one go or over
            |   time, from any wallet: first the fund's loss, then the
            |   co-signer's deposit. The co-signer's bar ends once the
            |   fund is whole. The borrower's bar shrinks to the late
            |   bar, counted from the day the borrower themselves pays
            |   the last of it; a friend's payment does not shorten it.
            |
            +-- Or the co-signer FORGIVES the rest: the debt ends, no
                money moves, the bars stay as they are.
```

### What a default means

The cutoff is the end of the grace period, to the second. Before it, a loan is **open** and any repayment is accepted. After it, no repayment is accepted at all; the loan is **settled**, and what happens next is the same whoever moves first, because there is only one path:

| state | how a loan gets there | the money | the borrower | the co-signer |
|---|---|---|---|---|
| **repaid** | paid in full by the cutoff | the fund is whole; the escrow is owed back to the co-signer, who releases it | the loan counts towards a higher cap if it ran 30 days | keeps their standing |
| **settled** | anyone settles it after the cutoff: the fund's scheduled job within minutes, or the borrower themselves as the first half of "settle and pay back" | no money moves at settlement. What is owed is set aside from the escrow, up to the deposit (for the fund to collect); anything above the deposit is owed back to the co-signer; if the deposit is smaller than what is owed, the difference is the fund's loss | barred for 2 years (launch setting); back on the first-loan cap for a month, with the cap steps lost | barred for 1 year, **only if the fund lost money**; the used deposit is gone until the borrower pays back |
| **paid back** | the borrower, or anyone for them, pays back what the settlement left unpaid, in any instalments | the fund's loss is made good first; the rest reimburses the co-signer's used deposit, which they collect | when the borrower **themselves** pays the last of it, the bar shrinks to 90 days **from that day** (launch setting); a friend's payment helps the fund and the co-signer but leaves the borrower's bar as it is; the loan still does not raise the cap | the bar ends once the fund's loss on every loan they guaranteed is covered, whoever paid it |
| **forgiven** | the co-signer forgives whatever is still unpaid | nothing moves; the fund's loss stays a loss and the used deposit stays used | the debt ends; the bar is unchanged | unchanged; the bar, if any, stays until the fund's loss is covered |

Worked example, a $300 loan with a $75 deposit and nothing repaid by the cutoff. Settlement: $75 of the deposit is set aside for the fund, the fund's loss is $225, the borrower is barred two years and the co-signer one year. If the borrower pays back $300 on day 40: $225 goes to the fund and $75 to the co-signer, the co-signer's bar ends, and the borrower's bar becomes 90 days counted from day 40. If instead a friend pays the $300 on day 40, the fund and the co-signer are made whole the same way and the co-signer's bar ends, but the borrower stays barred for the two years: the late bar is a reward for paying your own debt back. A borrower who tries to pay a second after the cutoff is shown exactly this: "settle and pay back", one transaction, the same outcome as if the scheduled job had settled first and they had paid back the moment after. There is no quicker or kinder route, so there is nothing to race for.

There are no collection agencies, no late fees and no added charges. What a settled loan still owes is recorded on chain and can be paid back at any time; nothing forces it, and the co-signer can forgive it.

All bars are for a set time, set by the fund with notice and fixed into each loan when it opens; they can be made permanent but are not at launch. A bar is never shortened by a later, lighter one, and a person's two roles are kept apart: paying back a loan you borrowed does not touch a bar you carry as a co-signer, and the other way round. The fund's administrator can lift a bar early (section 5), in public, with a written reason.

**If the network or our servers are down across a cutoff**, nobody can repay or settle until they are back; afterwards the loans whose cutoff fell inside the outage are settled like any other. The money works out the same for the fund, but not for the people in the loan: the borrower is barred and loses their cap credit, and the co-signer's deposit is used until the borrower pays back. The fairness does not work out, which is why the administrator can lift those bars and section 6 says how.

### Your money, and ours

The app includes a plain **wallet** view: your own digital wallet, holding USDC under a private key only you control. Good Faith cannot move it. If our website disappeared tomorrow, your wallet and your USDC would still be there, and every action in this paper can be done without our website (section 6).

Two kinds of money are held by the program, not by you: the donated fund, and co-signer escrows while a loan is open or until they are released. Both are governed by the program's rules, which the administrator can change only as section 5 describes. And one privileged action exists over your membership: a wallet recovery (section 4), which needs two of our keys held in different places, waits three days, and which you can cancel.

Two things that are true of every USDC wallet, including this one:

- **The stablecoin issuer can freeze USDC.** USDC is issued by Circle, and the token on Solana has a "freeze authority": Circle can freeze any USDC account, which it does under legal orders. That applies to your wallet, to the loan fund and to escrows alike. Good Faith has no such power and cannot undo a freeze. The program is built so that a freeze delays money without changing who it belongs to: settlement moves nothing and only records what each side is owed; the fund collects its share and the co-signer collects theirs when the account can be moved; a frozen escrow blocks exactly that escrow's two collections and nothing else, and nothing is written off because an account could not be touched. If a borrower pays back while the escrow is frozen, the co-signer's share is released from the frozen escrow rather than paid out of the fund, so the fund never owes money it has not received. A frozen loan fund stops everything until it thaws. On the test network the play-money USDC has the same property.
- **Creating an account costs a little.** Sending USDC to a wallet that has never held it creates a small account on the blockchain, which costs the sender about 0.002 SOL (a few cents). The fee sponsor (section 3) covers Good Faith's own transactions, not accounts created for other people.

### What to expect as a borrower

This is what the journey looks like today. These are the current options, not promises.

1. **Verify once.** A one-time identity check (section 4) from a phone or computer, a few minutes. Your pass lasts a year and renews from the app without a new check.
2. **Ask a friend.** You enter the amount, the term and your co-signer's wallet address; they get a link, review the exact terms and approve within a week. The moment they do, the USDC is in your wallet.
3. **Spend it.** USDC in a wallet is not yet dollars in a bank account. Today you can send it to anyone with a Solana wallet, spend it where USDC is accepted, or convert it through a crypto exchange or an "off-ramp" service that pays out to a bank account. Those services set their own fees, which vary by service, amount and payout method and often include a fixed minimum that matters on a $150 loan; they take minutes to a few days, and they have their own identity checks. We do not quote a rate because we do not control one; section 3 gives a worked example. We are working on a bank partner so that this step disappears (section 8).
4. **Repay.** Any amount, from any wallet, including a friend's, until the cutoff. The app shows the due date, the grace days left and exactly what is still owed.

## 3. Why Solana, and what the fee sponsor does

Good Faith runs on Solana, a public blockchain, for two practical reasons: a transaction costs a fraction of a cent and confirms in about a second.

On most blockchains you must hold a separate coin just to pay network fees. That is a real barrier for a new user. Good Faith avoids it with a **fee sponsor** (software called Kora): when the sponsor is running, joining, borrowing, co-signing, repaying, releasing an escrow and donating cost you nothing, including the small deposits ("rent") Solana requires for new accounts. The rent of a loan request and of an escrow comes back when they close; the rent of your person, membership and loan records does not, because those records stay, and the sponsor carries it (a few cents each at today's prices). "Fee-free" therefore means: Good Faith charges nothing, and while the sponsor runs the network charges you nothing either. The app shows you whether fees are covered at any moment. If the sponsor cannot be reached, your wallet pays the network fee and rent itself, and the app tells you so before you act. The sponsor only pays for Good Faith's own transactions: it reads every transaction before paying, refuses anything else, pays rent only for accounts of the fund's own currency and only for members unless the transaction is a Good Faith one, and each wallet has a daily allowance within a daily budget for the whole fund.

**What "fee-free" leaves out.** If you need the money as dollars in a bank account, the conversion is not free and we do not control it. A worked example: a $150 loan converted to bank dollars through a service charging a $3 fixed fee, and $150 bought back the same way to repay, costs about $6 in all, 4% of the loan, paid to the conversion services, not to Good Faith. A borrower who can spend USDC directly pays nothing. The economics note counts this cost on the borrower's side.

**Honest tradeoffs.** Solana has had outages in the past, some lasting hours. If the network is down, you cannot borrow or repay until it returns. Your funds are not lost during an outage, but access is paused. See "What a default means" for what an outage across a cutoff does.

## 4. Who can use it, and how we know

**Texas residents, 18 or older**, for now. Everyone who borrows or co-signs verifies once with Good Faith's own identity service.

### One verified person, one membership

A wallet is not a person. Someone barred for a default could otherwise come back with a new wallet, and someone with two wallets could borrow twice. So the fund keeps track of people.

- **The check.** Our verification partner (Persona) checks your government ID and your age in a hosted flow on your phone or computer, and that the ID was issued in Texas. A Texas ID is what we check; it is a proxy for residency, not proof of it, and someone who has moved away or holds another state's ID is not caught or wrongly caught by it. Good Faith's server learns the outcome and a few fields of the ID, never your selfie or your documents. Persona keeps the documents and the selfie under its own retention policy, which is theirs, not ours, and we will publish what it is before launch.
- **The fingerprint, kept off chain.** From the ID number, the issuing state and the birth date, the server computes a keyed fingerprint: the same every time the same document is verified, and not reversible into the document. It is stored on our server, keyed with a secret we can rotate, and it never goes on the blockchain. Stated carefully: whoever holds the key *and* knows a person's ID number, state and birth date can compute their fingerprint and learn whether that person is a member. The key is what protects the table, so a leak of the key is treated as a breach (section 6 says what happens then).
- **The person id, on chain.** What goes on chain is a random identifier the server draws for you the first time. The program keeps one **person** record per id and one wallet per person. Eligibility, the open loan, the guarantees and your personal cap live on the person, not the wallet. The id itself says nothing about your ID document. The public chain still shows what the id did: which wallets it used, which loans it took and guaranteed and with whom, when, and whether it was barred. Anyone who learns which wallet is yours (you told them, or an exchange knows) can read that history, and our server can always link the id to your record. "Private" here means the document and the fingerprint stay off chain, not that the chain is anonymous.
- **The pass.** The server issues a pass to your wallet on the fund's own gatekeeper network. The program checks the pass on every request and co-sign. A pass lasts a year; the app offers a renewal in the last month, which is a signed message from your wallet, not a new check, and is refused only while you are barred.
- **The membership.** Joining is a transaction signed by you *and* by the fund's identity issuer, which vouches on chain that your wallet belongs to your person id.

A renewed or second document can be added to your membership by verifying again from your wallet. We say this plainly: the fingerprint catches people who come back with the same document; it does not prove that two different documents are two different people. The caps in section 2 bound what that is worth.

You may leave an email when you verify. It is used for one thing: to tell you when something happens to your membership that you might not see in the app, such as a request to move it to another wallet, a bar being set or lifted, your pass being renewed, or the contact itself being changed. The contact can be changed only from the wallet that currently holds your membership, and the old contact is told. We never show it or pass it on; the relay we use to send the notices (a mail or messaging service the operator chooses) necessarily sees it, and we will name that service before launch.

### Lost keys: recovery you can stop

If you lose your wallet, you verify again from a new one. The server recognises you and, when you ask it to with a message signed by the new wallet, records a **request** to move your membership there. From there:

1. **Your contact is told first.** The notice goes to the contact you gave *before* the request was made, so a stranger who verifies as you cannot redirect it, and to the new wallet's contact if it differs. Whether it was delivered is recorded, and a failed notice is sent again.
2. **A person decides, with a key the website does not have.** The request waits at least a day, so the notice has time to reach you. Then the fund's operator checks it (the notice went out, your old wallet has not objected, the story adds up) and proposes the move with the **recovery key**, which lives on the operator's own machine, not in the web service. The proposal also carries the identity issuer's signature, which the web service adds. The operator's tool decodes what the web service hands it and signs only if it is exactly one instruction, the move of your person to the wallet the operator named; it will not sign anything else the service might have prepared. Neither key can move a membership alone, and they are held in different places by different people.
3. **Nothing moves for three days.** During the delay your old wallet keeps working, the app shows it that a move is pending, and nothing you are owed as a co-signer is paid out, so a lost wallet is never paid.
4. **Your old wallet can say no.** If you still have it, one click cancels the move. The fund's administrator can cancel it too.

After the delay, anyone (you, or the fund's scheduled job) finalises the move: the old wallet is retired for good, the new wallet takes over your membership, open loans and guarantees, and anything you are owed is released to the new wallet when claimed. A recovered membership sits on the first-loan cap for a month, like a new one. A barred person can recover a wallet too: the bar follows the person, and the new wallet is how they reach what they are owed and pay back what they owe.

One more floor, in the program itself: after the fund changes its identity issuer, its recovery key or its gatekeeper network (a settings change, with notice), no membership can be moved for seven days. A new set of keys cannot be used against members the week it arrives.

A bar sticks because it is on the person, on chain: a barred person who verifies again from a new wallet is recognised, and the program refuses their loans and guarantees whichever wallet they use. A person barred for good has the passes on all their wallets frozen and is refused by the identity service before anything reaches the chain; the freeze is reversed, on the wallets they had, when the bar is lifted or the debt is paid back, so a permanent bar is a strong measure but not an irreversible one.

### Borrower and co-signer are different people

The program checks that the two people behind a loan are different person records, not merely different wallets, and that they do not guarantee each other at the same time.

### What we trust, and how much

Four keys touch membership, and they do not live in one place:

| key | lives | can | cannot |
|---|---|---|---|
| **issuer** | the web service | vouch for a new membership; co-sign a recovery proposal | move money; move a membership alone; skip the delay or the veto |
| **gatekeeper** | the web service | issue, renew, freeze and thaw passes | register anyone (that needs the issuer too) |
| **recovery** | the operator's own machine (a command-line tool), never the web service | co-sign a recovery proposal the service prepared, after checking it is the one it was told to expect | anything alone |
| **administrator** | a multisig of independent people | section 5 | move money to anyone but an announced successor, which a second key must agree to |

What a compromise of each can do, stated separately, because they differ:

- **The issuer key alone.** Register fake people and lend to them (the money is bounded: each fake membership starts on the first-loan cap, every fake loan forfeits a 25% escrow, each person's exposure is capped, the fund lends at most $5,000 a day and holds at most $25,000 out at once at launch, so with the fund in normal use the attacker gets the ceiling's headroom), and co-sign recovery proposals that still need the recovery key. It cannot move a membership.
- **The recovery key alone.** Nothing: every proposal needs the issuer's signature too, and a proposal the operator did not ask for is visible to the member and to anyone watching the chain for three days before it lands.
- **The whole web service** (issuer and gatekeeper keys, the store). Everything the issuer key can do, plus issuing passes to anyone and reading the identity store. It still cannot propose a move of a membership without the recovery key, which is why that key is kept elsewhere. It can prepare a proposal and wait for the operator to sign it; the operator's tool checks that what it signs is the one move it expects, and the notice went to the contact on file from before the request, so the service cannot swap the wallet or hide the request from the member. The operator's check (section 6) is the control.
- **The gatekeeper key alone.** Issue passes to wallets that were never checked. A pass is only useful with a membership, which needs the issuer, or to a member who already has one.

The administrator can pause all new lending instantly and suspend the issuer instantly. Section 9 puts dollar figures on the issuer scenario under stated containment times. The security review (section 7) lists the residual risks.

### The legal approach

*This is the project's own reading of the law. It is not legal advice, and it has not been confirmed by a regulator or a court.*

- **0% loans.** The Texas Finance Code chapter 342, which regulates consumer loans, does not apply to loans at 10% a year or less (Texas Finance Code [§342.004](https://law.justia.com/codes/texas/finance-code/title-4/subtitle-b/chapter-342/subchapter-a/section-342-004/)). Good Faith loans charge 0%.
- **Donations, not deposits.** The fund is built from gifts. Nobody is promised their money back, so Good Faith is not taking deposits.
- **Custody, stated precisely.** Your wallet is yours; Good Faith has no key to it. The donated fund and the escrows are held by the program under rules the administrator can change only with notice. The one privileged power over a member is the recovery described above, which two keys must sign and the member can veto.

**Open questions for counsel.** Before any launch with real money we will put these to a Texas attorney, and we do not claim to know the answers: which named legal entity runs the fund, holds the keys and answers for it; who the lender is in law when a program lends donated money (the operator, the donors, nobody); who owns the donated assets and what duties come with holding them; what the loan agreement and the co-signer agreement must say, and whether a co-signer is a guarantor or a surety under Texas law; whether the federal Equal Credit Opportunity Act and Regulation B apply to a 0% loan with eligibility rules, and what notices a refused or barred person is owed under them; whether the Federal Trade Commission's co-signer notice rule applies to the deposit; what sanctions screening (OFAC) a lender of this kind owes; whether escrow, entitlements and donations left unclaimed fall under Texas unclaimed-property law; whether the identity check's selfie match is a biometric identifier under the Texas biometric statute (CUBI) and what consent and retention that requires; whether facilitating loans between people, or issuing identity passes, brings licensing obligations; whether the fee sponsor or the wallet feature touch money-transmission rules; which consumer-protection and disclosure rules apply to a 0% loan with time-limited bars; what the privacy law says about the identity check and the stored fingerprint; whether a program upgrade authority changes any of the above; and how donations are treated for tax purposes on both sides, since the fund is not a registered charity. Answers will be published before launch; until then the real-money launch is not scheduled.

## 5. How the fund is run

Two roles appear throughout this paper and are different things. The **administrator** is the multisig of independent people that holds the fund's settings key: it can change settings with notice, pull the brakes, lift a bar and announce a wind-down, and the program limits it as this section describes. The **operator** is the organisation that runs the services (the identity service, the sponsor, the scheduled job) and holds the recovery key; it has no settings power and the program gives it none. One person may sit on both; the keys are separate.

Several keys run the fund, each with a job, and the program limits each one. The full table is in the specification; in short:

| who | may | how fast |
|---|---|---|
| **administrator** (a multisig of independent people) | change the settings; hand over the role; suspend the issuer; pause and resume new lending; cancel a recovery; lift a bar, in public, with a reason; announce a wind-down (with the successor key); give up the role for good | settings and wind-down after the notice period (7 days at launch, never below 2); the rest at once |
| **successor key** (the program upgrade multisig at launch) | agree to a wind-down and its destination | with the administrator, after the notice period |
| **pause key** (held separately) | pause new lending | at once |
| **identity issuer and recovery key** | section 4 | a recovery waits 3 days (never below 1) and can be vetoed; none for 7 days after the identity keys change |
| **program upgrade key** (a separate multisig, with its own delay) | replace the program's code during the pilot | see "Upgrades" |
| **anyone** | apply an announced change once its time has passed; finalise a due recovery; close an expired request; repay; settle a loan past its cutoff; collect what the fund is owed; pay back a settled loan; release what a co-signer is owed; move the balance to the successor after a wind-down | by the rules above |
| **the co-signer of a settled loan** | forgive what is still unpaid | at once |

**Upgrades come first**, because during the pilot they override everything below. The program's code can be replaced by a separate multisig of independent people, through a delay of its own, so that a code change is visible before it lands and no one person can make one. Until that key is removed, "the rules are the program's rules" means the program as it stands and as that multisig may change it, within the delay. Concretely: the upgrade key is held by a multisig distinct from the administrator's, with a published membership and threshold; every upgrade is queued on chain for the delay (we intend seven days, matching the notice period) where anyone can see the new program hash, and can be cancelled by the same multisig before it lands; the deployed hash is published with each release so anyone can check what is running. The key is removed when the exit criteria are met: an independent audit published with its findings closed, two full loan cycles of the pilot without a program change forced by a bug, and the open legal questions answered. Until then the guarantees in this section hold "unless the upgrade multisig changes the code, with seven days' notice", and we would rather say so than claim immutability we do not yet have.

The settings are: the loan cap, the first-loan cap and how it grows (the step, the 30-day seasoning, the 30-day interval between steps), the cooldown, the longest term, the grace period, the co-signer deposit rate, how many loans one co-signer may back, the exposure cap, the daily lending cap and the ceiling on money out on loan, the request lifetime, the recovery delay, the three bar durations (the late bar can never be longer than the default bar), which gatekeeper network, issuer, recovery key, pause key and successor key are accepted, and the length of the notice period itself. No setting adds a fee or interest; the code has no field for one. The administrator cannot move money, except in the announced wind-down case below. Donations can only leave the fund as loans, repayments and pay-backs only flow back into it, and an escrow can only go to the co-signer or to the fund.

- **Every change has a notice period.** A settings change is announced first and takes effect only after the fund's notice period, measured with the notice period in force when it was announced, so shortening the notice period itself waits the old delay, and once a fund runs with two days or more of notice, no change can ever take it below two days. Anyone can apply the change once the time has passed; the administrator can withdraw it before then. Nothing applies silently.
- **Open loans are never changed.** A settings change applies to future loans only. Each loan keeps the term, the grace period, the deposit rate, the three bar durations and the cap rules it was opened with.
- **Bars can be lifted, not set.** The administrator can end a person's bar early, by a public action that carries the hash of a written reason, which the operator publishes. That is the remedy for a settlement an outage caused and for an appeal upheld. A lift clears the bars, not the record: a co-signer whose lifted loss is still unpaid is barred again by the next loss until every loss is paid back. No key can bar anyone: only a settlement does that, and paying back shortens it.
- **Handing over the role takes two steps.** The current administrator names the next key, and that key has to accept.
- **Two instant brakes.** Pausing new lending (new requests and co-signs stop; repayments, defaults, releases and recoveries continue) and suspending the issuer (no new memberships or recovery proposals until a new issuer is announced and applied). Neither touches money or existing members.
- **Winding down, with a successor, needs two keys.** The administrator and the successor key together announce that the fund is closing and name a successor: a token account of the same currency that is not controlled by the fund itself. After the notice period, the fund stops taking new loans and donations; open loans run their course, repayments still come in, loans past their cutoff still settle, members can still recover a wallet. Once no loan is open, anyone can move the balance to the successor, less what co-signers are owed from it, which stays until they collect it; what settled loans owe the fund and what co-signers are owed from escrows sit in the escrow accounts and are collected whenever they can be, before or after the move. A wind-down never writes anyone's entitlement off. The announcement can be withdrawn before it takes effect, not after.
- **Giving up the role is possible, not planned.** The administrator can permanently give up the role, which also discards any announced change. We expect to keep a live, multi-signature administrator for as long as the fund runs, because a fund with no administrator cannot pause, cannot resume, and cannot be wound down unless that was announced first.
- **Everything is announced.** Every action, from a loan opening to a settings change, a recovery proposal, a pause or a wind-down, is recorded as a public event on the blockchain.

### The administrator's reach, honestly

The settings include which identity issuer, recovery key and gatekeeper network the fund accepts. An administrator that turned against its members could, with notice, install its own. The program puts three floors under that which no setting can remove: the recovery delay can never be scheduled below one day; for seven days after any of the identity keys changes, no membership can be moved at all; and a wind-down's destination needs the successor key's agreement as well as the administrator's. What remains is this: **with seven days' notice, the administrator can replace the keys that decide who is a member, and you will see it on chain for the notice period, then the seven-day quarantine, then the recovery delay, before any membership could be moved**. That is at least seventeen days at the launch settings in which the old wallet can veto, the pause key can stop lending, and members can collect what they are owed and leave. We think that is the right balance between a fund that can replace a lost key and a fund that cannot be taken over quietly, and we say what it does not prevent.

### Upgrades

See the top of this section: the upgrade multisig, its delay, what is observable, how an upgrade is cancelled, and the criteria for removing the key. Once it is removed the program is permanent, and fixing a bug means launching a new version and winding this one down into it.

## 6. Operations

Five pieces of software run beside the program, all published and all replaceable:

- **The identity service** (section 4): opens checks, receives the partner's results, issues, renews, freezes and thaws passes, co-signs memberships, records recovery requests for the operator and prepares the proposals the recovery key signs, mirrors the chain's bars (with their end dates, reconciled on every pass of the scheduled job) so a barred person is handled the same on every wallet, and sends the notices. It stores the fingerprints (keyed, versioned), the person ids, the wallets, the contacts people chose to give, the inquiry ids and statuses, and the recovery requests with their history. [`docs/identity.md`](./identity.md) describes it, including what happens when a key is rotated, lost or leaked.
- **The recovery tool** (`scripts/recovery.ts`): the operator's command line that holds the recovery key, lists the requests beside what the chain shows, approves one by naming the wallet the operator checked (it decodes the proposal the service prepared, refuses anything but the one expected instruction, signs and sends it) or rejects it. It is deliberately not part of the website.
- **The fee sponsor** (section 3): a Kora server behind the app's own proxy, which holds the credentials, forwards only three operations, reads every transaction against the sponsorship policy, and limits each client, each wallet and the fund as a whole.
- **The cranker**: a scheduled job that does, on time, what anyone is allowed to do: it settles loans past the cutoff, collects what settled loans owe the fund from their escrows, releases what co-signers are owed (from escrows and from the fund, creating their token account at the fund's expense when needed; a frozen escrow or a pending recovery is reported as waiting, not as a failure), closes expired requests, finalises recoveries whose delay has passed, applies settings changes whose notice period has passed, moves the balance to the successor once a wind-down is complete, and tells the identity service who is barred and until when, every pass. If the cranker stops, nothing is lost: every step can be done by anyone.
- **The member command line** (`scripts/member.ts`): everything a member can do in the app (see their standing, request, co-sign, repay, settle and pay back, forgive, collect, release what a co-signer is owed, close an expired request, veto or finalise a recovery, donate), from a terminal, against the blockchain alone, paying the small network fee themselves. It is the supported path when our website or the sponsor is down. Joining, renewing a pass and recovering still need the identity service, because they need its signatures.

**Outages across a cutoff.** When our servers or the network were down across a loan's cutoff, the fund's money is unaffected: a borrower who pays back right after the outage lands exactly where a borrower who paid before it would have. The people in the loan are affected: the borrower is barred, loses the loan's cap credit and goes back to the first-loan cap; the co-signer's deposit is used until the borrower pays back, and they are barred if the deposit did not cover everything. The remedy list, in order: the operator publishes which cutoffs the outage covered; the administrator lifts the bars of both people where the outage was the cause, in public, with that reason; the operator helps the borrower pay back promptly so the co-signer is made whole. The cap steps are not restored. The cost of an outage is that review and the co-signers' money tied up meanwhile; section 9 counts the review.

**Appeals.** A member who thinks a bar is wrong writes to the operator. The administrator's decision is one of: do nothing, lift the bar (public, with the reason), or, where a pattern shows the durations are wrong, schedule different ones for future loans. The operator keeps a written log; the hashes on chain point into it. While barred, a member keeps every right that is not a new loan or guarantee: they can repay, pay back, collect what they are owed, recover a lost wallet, renew nothing (a renewal waits for the bar to end) and donate.

**A leaked fingerprint key.** Whoever holds it and knows a person's ID fields can tell whether that person is a member. We rotate the key (people re-link to the new one on their next check), tell members, and treat it as a breach notification; nothing on chain changes, because fingerprints never reach it.

## 7. Security and testing

- **Public source, verifiable on chain.** The program, the app, the identity service, the sponsor policy and every script are published under the Apache License 2.0 in the project repository, and the deployed program can be checked against a tagged build (appendix). Every loan, repayment, release and donation is recorded on the blockchain for anyone to check.
- **Checked math.** Every calculation uses overflow-safe arithmetic. If a number would go out of range, the transaction fails instead of producing a wrong result. The code contains no fee or interest fields at all.
- **Security review.** An internal review of the program is published in [`docs/audit.md`](./audit.md), findings GF-01 to GF-36. The version 5 findings are the ones this paper is built around: a loan could be funded with money the fund already owed to co-signers (closed: owed money is never lent); a deposit topped up after the deadline erased a loss and a co-signer's bar (closed: only the deposit counts); a single token unit sent to a closed escrow locked what was owed from it for good (closed: extras are released or donated and the account always closes); one bar for two roles, so paying back a loan could wipe a bar earned as a co-signer, the co-signer's lift depended on the order of pay-backs and a friend's pay-back relaxed the borrower's bar (closed: bars per role, the late bar from the borrower's own pay-back, the co-signer's lift when the fund is whole); a pay-back could reimburse a co-signer from the fund while the fund's own recovery sat frozen (closed: released from the escrow instead); a claim during a pending recovery paid the lost wallet (closed: it waits); a defaulter returned at the full cap and co-signers were not bound to the grace period and bar they saw (closed); the administrator could, with one notice period, install its own identity keys, set the recovery delay to zero and name itself successor (mitigated: the floors in section 5, with the residual stated there); and in the services, an unsigned recovery request, a contact that a second wallet could overwrite, a recovery tool that signed whatever it was handed, a permanent bar that could never be undone, passes that expired with no renewal and a sponsor that paid rent for strangers (closed). An independent audit is planned before any real-money launch.
- **What the tests check**, rather than how many there are: that the money in the fund always equals gifts plus repayments plus collected escrow plus pay-backs minus loans out minus anything moved to the successor minus reimbursements paid; that the fund always holds at least what co-signers are owed from it, and never lends it; that every token ever handed out is in the fund, an escrow, a wallet or the successor; that while a loan is open its escrow holds at least the deposit, and once settled it holds at least what the fund and the co-signer are owed from it until each collects (extras go back to the co-signer or, on the final close, to the fund as a gift); that the three entitlement totals always equal the sums over the loans; that the principal out on loan equals the sum over open loans and never exceeds the ceiling; that eligibility, caps, exposure and guarantees always sit with the right person and never exceed their limits; that a person's bar is the larger of a borrower bar and a co-signer bar, each set only by the role that earned it, and that the co-signer bar stands exactly while they have a guaranteed loss the fund has not been paid back for; that no two open loans guarantee each other; that nothing is lent while paused; that no loan is repaid after its cutoff and every settled loan was settled after it; that a loan is "paid back" exactly when its whole shortfall is, or the co-signer forgave the rest; that every loan carries the terms the pool had when it opened; that settings change only through an announced and applied change and never below the minimum notice or the minimum recovery delay; and that a wind-down, once in effect, never reverses. These are checked after every step of random sequences of up to forty operations, with clock jumps across deadlines, escrow top-ups, freezes and thaws, lifts and forgiveness, in the program's property test: 24 random sequences on every developer's run and 200 in continuous integration, which is tens and hundreds, not thousands. They are also checked in the scenario tests of the program (including a frozen escrow, the settle-and-pay-back table against the scheduled job, partial pay-backs and the order in which they reach the fund and the co-signer, the per-role bar rules, a top-up and a stray deposit, seasoning, the ceiling, the lift, the quarantine, the two-key wind-down and forgiveness), the web app's own transaction code, the identity service and the sponsorship policy. On a local copy of Solana's test network the whole system runs end to end on every change: a fund is created, passes are issued by the real gateway program, the loan cycle runs with a cancellation, a refused late repayment, a settlement, a collection, a pay-back in two instalments with the bars relaxing by rule, a lifted bar, a forgiveness, a recovery proposed by the operator's tool (which refuses a tampered proposal) with a veto and a finalisation, an expired request, a pause, a settings change across a time jump with the quarantine it causes, a wind-down signed by both keys with a sweep; the sponsored flows run against a real sponsor, directly and through the policy, checking that users paid nothing, the sponsor paid exactly what it should, and that the policy refused what it should (a stranger's token account, a close paid to a third party); the identity flow runs from the wallet's signed proof to a sponsored join, a renewal, a linked document, a signed recovery request through the operator's tool, a declined and an out-of-state check, a permanent bar that freezes the passes and a lift that thaws them; and the cranker does its rounds, including reconciling a loan it did not settle.

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

Good Faith has no revenue. Capital lost to defaults and the cost of running the fund are both paid from gifts. [`docs/economics.md`](./economics.md) has the model, the definitions, and every table. The headline is the fund at its **launch settings**: a $100,000 fund of which at most $25,000 is out on loan (the ceiling in section 2), $300 average loan, a 120-day cycle, a fifth of the principal repaid before a default, 25% escrow, two loans a year per borrower, where the "default rate" is the share of loans made in a cycle that end in default:

| default rate (launch scale) | completed loans per year | capital lost per year | gifts needed per year, all costs in | cost to donors per completed loan | per borrower-year | years the fund lasts paying its own way |
|---|---|---|---|---|---|---|
| 2% | 248 | $800 | $37,400 | $150 | $301 | 2.3 |
| 5% (base) | 241 | $2,100 | $38,600 | $160 | $321 | 2.2 |
| 10% | 228 | $4,200 | $40,700 | $178 | $357 | 2.0 |

At launch scale the result is decided by **loan volume against fixed costs, not by the default rate**: running the fund costs about $37,000 a year whatever the default rate (identity checks, pass renewals, the sponsor's unrecoverable rent, hosting, support, disputes, fraud response and bookkeeping recur at about $15,200; the audit, legal work and development are paid once, $65,000, spread over three years in the table), and 240 completed loans a year cannot carry it. Over ten years the endowment plus the gifts the fund needs come to about $335,000; as $300 grants that reaches about 1,100 people once; as loans it reaches about 660 people (1,200 borrower-years, 2,400 completed loans) and the fund is still there. **Until the ceiling is raised, grants reach more people than loans.** The ceiling is a safety setting against a compromised issuer, and we would rather state its price than hide it.

Raised to 80% of the fund out on loan (the model's base scale, where the earlier versions of this paper started), the same fund completes about 770 loans a year, a completed loan costs the donors about $57 and a borrower-year about $113, and the same money over ten years ($384,000) reaches about 2,100 people as loans against 1,300 as grants, with the $100,000 still lending. In cash, the first year needs about $87,000 at the base scale and $82,000 at launch scale (the one-off items paid in full), and each later year about $22,000 and $17,000. "Years the fund lasts paying its own way" has the fund pay its own running costs from the endowment with no gifts, and that is the honest figure for a fund with no backer: about two years at either scale.

Two costs the fund never pays but the model now counts, because people do: at the base scale co-signers lose about $3,000 a year of deposits to defaults (about $30,000 over ten years), which comes back only if the borrowers pay back; and borrowers who need bank dollars pay about $6 a loan to convert in and out, about $4,900 a year. Caveats that stay: a grant needs no co-signer, no deposit and no bar, so loans and grants reach different people, not only different numbers; and a loan's benefit is the use of the money for a few months, a grant's is the money itself.

**Stress scenarios**, from the same model, with their assumptions, because they are scenarios and not bounds: one cycle at a 30% default rate (a local shock) costs about $13,200 at the base scale; a compromised issuer contained within three days with the fund in normal use (about $20,000 already out) can lend at most the ceiling's headroom, $5,000, and lose $3,750; with an empty book it can lend up to $20,000 and lose up to $15,000 under the launch caps (the daily cap is a fixed window, so three days can span four of them; a week to notice it reaches the $25,000 ceiling, $18,750 lost; $22,500 and $16,875 with no daily cap at all), and the figure that decides it is how fast the pause is pulled, which is the operator's, not the program's; a thousand abusive wallets in a day cost the sponsor about $720, because the fund-wide daily budget lets 200 new wallets in (about $3,600 with the per-wallet caps alone), and an attacker who comes back every day can spend the whole daily budget every day, about $264,000 a year at these settings, which is why the sponsor's spend is watched and the budget is lowered when strangers are spending it; an outage across cutoffs costs the fund nothing and the two or so affected loans their co-signers' deposits until the borrowers pay back and their borrowers the cap credit, plus the review of the lifts.

**Collusion is limited, not prevented.** Two people cannot guarantee each other, but three can form a ring with no reciprocal pair: each borrows once with the next as co-signer. On the first-loan cap that takes $338 ($113 each); if all three had grown to the $500 cap, $1,125. Each person's one loan and one guarantee fit the $1,000 exposure limit. It costs each of them their eligibility for years, a verified ID on record, and the ring cannot repeat with the same people. The default rate, the share repaid before a settlement, the share paid back after one (and by whom), how often a co-signer forgives, and the real loan volume are the numbers we most need to measure after launch.

## 10. Risks

Please read these before donating, borrowing or co-signing.

- **Smart contract bugs.** Code can have mistakes even after review and testing. A bug could cause losses or lock funds. During the pilot the program can be upgraded to fix one, by a multisig after a delay; that is also a power that could be misused.
- **Co-signer risk.** If you co-sign, your deposit covers what the borrower does not repay, and it comes back only if the borrower pays back, which nothing forces. If the deposit did not cover everything, you are barred from borrowing and co-signing until the fund's loss is covered (a year at launch, counted from the settlement) or the administrator lifts the bar. You can forgive the rest of the debt, which ends the borrower's obligation and gives up your used deposit. Only co-sign for someone you trust, with money you could lose.
- **Defaults draining the fund.** Escrow covers only part of each loan (25% by default). If many borrowers default at once, the fund shrinks and there is less to lend. Donations are gifts, and there is no guarantee the fund is replenished. Section 9 puts numbers on this.
- **Scale risk.** At the launch ceiling the fund costs more per loan than giving the money away would; the case for lending holds only if the ceiling is later raised and the volume comes. Donors should read section 9 before giving.
- **Regulatory change.** Laws and regulator views can change. Our reading of Texas law could be wrong or could be overtaken by new rules, which might force changes or a shutdown. The wind-down path exists so that a shutdown is orderly.
- **Stablecoin risk.** USDC could lose its $1 value, and its issuer can freeze any USDC account, including yours, the fund's and an escrow, under legal orders. A frozen escrow no longer blocks a loan from closing, but the money in it stays frozen.
- **Identity risk.** The identity partner could decline people wrongly, change terms or go away; our keys could be compromised (section 4 says what each can and cannot do, and section 9 what it could cost). A stored fingerprint, though keyed and off chain, is still data about you that could be lost in a breach of our server, and whoever holds the key and your ID fields can tell that you are a member. Duplicate detection is not proof of uniqueness.
- **Recovery risk.** A recovery proposal you do not notice within the delay cannot be vetoed. The app shows pending recoveries, the operator reviews every request before signing, a request waits at least a day before it can be proposed, and a notice goes to the contact you gave before the request; but the protection depends on someone looking, and a member who gave no contact and never opens the app has only the operator's check.
- **Administrator risk.** The administrator can change the settings with notice, including which identity keys the fund trusts. The floors in section 5 (a day's minimum recovery delay, a seven-day quarantine after a key change, a second key for the wind-down's destination) make a takeover slow and visible, not impossible: a rogue administrator could replace the identity keys and, after at least seventeen days in public, move memberships whose old wallets did not object. The multisig's independent membership is the real protection, and it is a social one.
- **Network, operator and sponsor risk.** Solana, Good Faith's servers (identity service, cranker, proxy) or the fee sponsor could go down, pausing joining, borrowing or sponsorship. Repayment, settlement, pay-back, releases, forgiveness and vetoes never depend on our servers: they can always be done directly on chain with the member command line, and if only the sponsor is down you can act by paying the small network fee yourself. An outage across your cutoff means your loan is settled, you are barred until you pay back or the administrator lifts the bar, your cap credit is lost, and your co-signer's deposit is used until you pay back.
- **Upgrade risk.** During the pilot the upgrade multisig can change the program, with seven days' notice. Every guarantee in this paper is subject to that until the key is removed (section 5).
- **Fee-sponsor funding.** The sponsor is a wallet we keep topped up. If it runs dry, users pay their own network fees until it is refilled.
- **No deposit insurance.** Wallets and the loan fund are not covered by FDIC insurance.

Good Faith is a small, early experiment. Only donate what you can afford to give away, and only co-sign for someone you trust.

## Appendix: verifying what is deployed

Everything below is meant to be checked, not believed. Items marked *to be filled at deploy* are empty until the deployment they describe exists.

- **Source:** the project repository, Apache License 2.0; the paper, the specification ([`docs/spec.md`](./spec.md)), the review ([`docs/audit.md`](./audit.md)), the identity note ([`docs/identity.md`](./identity.md)), the operations note ([`docs/operations.md`](./operations.md)) and the economics ([`docs/economics.md`](./economics.md)) live beside the code and change with it.
- **Deployment status:** no public deployment yet. The program runs on a local fork of the test network in automated tests. *Devnet program id, pool account and keys: to be filled at deploy.* The id declared in the source is `BM71D4Kdnq3Mtc2cqDuMBLyYguFihDqsjk9btdTWtoRd`; the devnet deployment will use a fresh keypair and the id will be published here.
- **Release tag and build hash:** *to be filled at deploy.* The program is built with `anchor build --arch v2` from a tagged commit; the SHA-256 of `target/deploy/goodfaith.so` is published with the tag, and `solana program dump` of the deployed account must hash to the same value.
- **Upgrade authority:** *to be filled at deploy*: the upgrade multisig and its delay during the pilot; "none" once the program is made permanent (`solana program show` prints "Upgrade authority: none").
- **Pool account, mint, administrator, successor key, pause key, issuer, recovery key, every setting:** read from the pool account on chain (`Pool` layout in the specification), including when the identity keys last changed; the app pins the pool address, the mint, the gatekeeper network and the administrator in its configuration and refuses anything else. The member command line reads the same account. Every loan carries its own term, grace period, deposit rate, bar durations and cap rules, so what applies to a loan is read from the loan, not from today's settings.
- **Bar lifts:** every `BarLifted` event carries the hash of the administrator's written reason and the bars it cleared; the operator publishes the reasons so the hashes can be checked.
- **Gatekeeper network and keys:** the network's public key and the issuer, recovery, pause and successor keys are published with the deployment; passes can be looked up on chain for any wallet, with their expiry and whether they are frozen.
- **Audit scope and status:** internal review published in [`docs/audit.md`](./audit.md) (findings GF-01 to GF-36); *independent audit: to be filled when complete.*
- **Upgrade multisig:** *to be filled at deploy*: its members, threshold and delay, where queued upgrades can be seen, and the published exit criteria (section 5).
- **Tests:** the program's scenario and property tests (`cargo test -p goodfaith`; `PROPTEST_CASES=200` in continuous integration), the app's unit tests and simulator scenarios (`npm test`, `npm run test:svm` in `app/`), and the end-to-end scripts in `scripts/`, all run by the repository's continuous integration on every change; what they check is listed in section 7.
