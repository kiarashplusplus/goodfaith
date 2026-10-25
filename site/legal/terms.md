---
title: Terms of use
version: 0.3
effective: 2026-10-25
status: Draft for counsel's review. Good Faith runs on a test network with test money only.
---

## About these terms

These terms explain how Good Faith works and what you agree to when you join, borrow, co-sign or donate. They describe the rules the Good Faith program runs. If these terms and the program ever differ, the program is what happens on chain, and we will correct these terms. This draft has not yet been reviewed by a lawyer.

## Who we are

Good Faith is a community loan fund run by two roles. The **administrator** is a multisig of independent people that holds the fund's settings. The **operator** is the organisation that runs the website, the identity service and the other services. "We" means the operator. "You" means you, the person using Good Faith.

[[TO CONFIRM: legal entity, address and governing law]]

[[TO CONFIRM: who the lender is in law, who holds the keys, and who owns the donated assets]]

## Status: test network only

Good Faith runs on a Solana test network with test money. Test USDC has no value. There is no real-money service yet.

The test fund may run with different settings from the launch settings in these terms, such as a shorter notice period and recovery delay. The settings that apply are the ones stored in the fund's account on chain. These terms will be revised before any real-money launch.

## Who can use Good Faith

To join, borrow or co-sign, you must be a **Texas resident, 18 or older**, and pass a one-time identity check with our verification partner, Persona. Persona checks a government ID, your age, and that the state on the ID is Texas. We use that as a sign of where you live; it is not proof. [[TO CONFIRM: whether the check should use the state that issued the ID rather than the address state on it]] Do not join if you do not live in Texas.

**One verified person, one membership.** We keep a keyed fingerprint of your ID so the same ID is recognised if it is used again. Each membership has one wallet at a time. Do not hold more than one membership or join for someone else.

Your identity pass lasts about a year and renews from the app. Anyone may donate without a membership.

## What Good Faith is, and is not

Good Faith makes interest-free loans from a fund made of gifts. You repay exactly what you borrowed. There is no interest, no fee and no penalty, and no setting in the program can add one.

Good Faith is **not a bank** and takes no deposits. Money in your wallet, the fund or an escrow is **not FDIC-insured**.

Loans are made in **USDC**, a stablecoin designed to be worth one US dollar. USDC is not dollars in a bank, and it could lose its value. Its issuer, Circle, can freeze any USDC account, including yours, the fund's and an escrow. A freeze delays money but does not change who it belongs to.

Nothing we publish is financial, legal or tax advice.

## Donations are gifts

A donation is a **gift**. You will not get it back, and it earns no interest or return. Donations leave the fund only as loans.

[[TO CONFIRM: tax treatment of donations]]

## Borrowing

**How much.** Your first loan can be up to {{launch:firstLoanCap}} USDC. Each loan repaid in full by its cutoff raises your limit by {{launch:loanCapStep}} USDC, up to {{launch:maxLoan}} USDC. A repaid loan counts only if it ran at least {{launch:seasoningDays}} days, and your limit rises at most once every {{launch:capStepIntervalDays}} days. For {{launch:cooldownDays}} days after you join, recover a wallet or have a loan settled, your limit is {{launch:firstLoanCap}} USDC.

You can have one open loan at a time, whichever wallet you use. What you borrow plus what you guarantee for others cannot exceed {{launch:maxExposurePerPerson}} USDC.

**The fund's limits.** The fund caps how much it lends each day, how much is out at once, and how much it lends in total during the pilot. When a limit is reached, new loans wait.

**Asking.** You choose the amount and a term of up to {{launch:maxTermDays}} days, and name your co-signer's wallet. A request nobody co-signs expires after {{launch:requestTtlDays}} days. When your co-signer approves, the USDC arrives in your wallet.

**Term, grace and cutoff.** Each loan has a due date, then {{launch:graceDays}} days of grace. The last second of the grace period is the **cutoff**. The term, grace period, deposit rate, bar lengths and limit rules are written into your loan when it opens. Later settings changes never touch it.

**Repaying.** Repay any amount, from any wallet, at any time until the cutoff. Repaying during the grace period costs nothing extra. The app shows the due date, the grace days left and what you still owe.

## After the cutoff

After the cutoff, no repayment is accepted and the loan is **settled**, usually by the fund's scheduled job within minutes. Settling moves no money. It records two separate claims:

- **the fund's claim**: what the co-signer's deposit did not cover;
- **the co-signer's claim**: the part of their deposit that was used.

Anyone can **pay back** a settled loan, in any amounts, from any wallet, at any time. Payments go to the fund's claim first, then to the co-signer's. "Settle and pay back" in the app does both in one step, with the same result.

A settled loan bars you (see "Bars"), resets your limit, and never raises it, even once paid back.

There are no late fees, no collection agencies and no credit reporting. Nothing forces you to pay back a settled loan; what it owes stays recorded on chain.

[[TO CONFIRM: whether the no-collections, no-credit-reporting and no-legal-action policy is a binding commitment, and its wording]]

## Co-signing

Every loan needs a **co-signer**: a different verified member who puts up {{launch:cosignerEscrowBps|percent}}% of the loan as a deposit, held in escrow by the program until the loan ends. You approve the exact terms the app shows you: amount, term, grace period, deposit and bar. If they change, you must look again.

- **If the loan is repaid by the cutoff**, your deposit is yours again, in full.
- **If not**, your deposit covers what is missing, up to all of it. You get the used part back only if the loan is later paid back.
- **You can waive** what you are owed on a settled loan. That gives up your claim only; you cannot end the borrower's debt to the fund.
- If your deposit did not cover everything, so the fund lost money, you are barred (see "Bars").

You can back at most {{launch:maxGuaranteesPerMember}} loans at once, and two people cannot guarantee each other at the same time.

**Only co-sign for someone you trust, with money you could lose.**

[[TO CONFIRM: what the loan and co-signer agreements must say, whether a co-signer is a guarantor or a surety, and whether the FTC co-signer notice is required]]

## Bars

While barred, you cannot take or co-sign a new loan. You keep every other right: repaying, paying back, collecting, waiving and recovering your wallet. Only a settlement sets a bar; no key can bar anyone.

- **Borrower bar.** A settled loan bars you for {{launch:defaultBanDays|years}} years from the settlement. When that loan is paid back (the fund's claim paid, the co-signer's paid or waived), the bar shortens to {{launch:lateBanDays}} days from the pay-back date, if that is sooner. It does not matter who pays. Paying back an earlier loan never shortens a bar set by a later one.
- **Co-signer bar.** Each settled loan you guaranteed that left the fund a loss bars you for at least {{launch:cosignerBanDays|years}} year from its settlement. The bar ends at the earlier of the latest such date and the moment the fund is paid back on **every** loss you guaranteed.
- **Separate roles.** Paying back a loan you borrowed never ends a bar you carry as a co-signer, and the other way round.

**Lifts.** The administrator can lift your bars early, in public, with a published reason. A lift clears the bars, not the record. Bar lengths for future loans can change with notice, and could be made permanent; they are not at launch.

**Appeals.** If you think a bar is wrong, write to us. The administrator may do nothing, lift the bar, forgive the fund's claim, or change bar lengths for future loans, each with a published reason.

[[TO CONFIRM: whether ECOA and Regulation B apply, what notice a refused or barred person must receive, and which disclosure rules apply to time-limited bars]]

## Forgiveness

Only the owner of a claim can give it up: the co-signer can waive theirs, and the administrator can forgive the fund's, in public, with a published reason. Forgiveness ends what is owed on that claim; it is not being paid back. After the fund's claim is forgiven, the borrower's and the co-signer's bars stay as they were, and the co-signer's claim stays payable.

## Your wallet and keys

Your wallet is made for you when you sign up, by our wallet provider, Turnkey. You sign in with a passkey (your device's Face ID, fingerprint or PIN) or a code sent to your email. Its key is kept encrypted by Turnkey and is only decrypted inside Turnkey's secure hardware when your own sign-in asks it to sign. Your account is yours alone: Good Faith's Turnkey organisation can read it but cannot sign, change or delete anything in it, and we do not add any other user or key to it. So we cannot see or use your key, and cannot move your money. While you are signed in, the app signs what you approve in it; use it only at its real address. The app's Checking page shows and moves the USDC in it. [[TO CONFIRM: counsel's view that this is not custody of members' funds]]

**Keeping your sign-in is your responsibility.** If you lose your passkey, sign in with a code sent to your email and add a new one. Keep that email account safe: anyone who controls it can sign in as you. Sessions end after a short time and you sign in again. You can export your wallet's key from the app's account menu, for the command-line tool that works without the website. Exporting copies the key: the wallet keeps working in the app too. Anyone with that key controls your wallet, so keep it secret. Solana transfers are final, so check before you sign.

Your membership's history is public on chain. Anyone who learns your wallet can read it. Your documents and fingerprint stay off chain.

## Lost wallet: recovery

If you lose your wallet (for example, both your passkey and your email account), you can move your membership to a new one. Your loans, guarantees and bars move with you.

- Verify again from the new wallet and ask to move, with a message it signs.
- Your contact on file is told first, and the new wallet's contact too.
- After at least a day, a person at the operator checks the request and proposes the move.
- Nothing moves for {{launch:recoveryDelayDays}} days. Your old wallet keeps working, and nothing you are owed as a co-signer is paid out meanwhile.
- **Your old wallet can cancel the move** with one click during that time. The administrator can cancel too.
- After the delay, anyone can finish the move.

For seven days after the fund changes its identity keys, no membership can be moved.

**A stolen wallet** can also cancel your recovery, because the program cannot tell an owner from a thief. Tell us at once: we freeze the stolen wallet's pass and your case goes to the administrator. What you owe can still be paid back from any wallet, but a thief may collect what you are owed as a co-signer. A recovery you do not notice in time cannot be cancelled, so leave a contact.

## The administrator and settings changes

The administrator can change the settings: limits, terms, the deposit rate, bar lengths, the request lifetime, the recovery delay, the keys and the notice period. **Every change is announced first** and takes effect after a notice period of {{launch:timelockDays}} days at launch, never less than two. Open loans are never changed.

At once, the administrator can pause and resume new lending, suspend the identity issuer, cancel a recovery, lift a bar or forgive a fund claim. A pause stops new loans only; repaying and paying back carry on.

The administrator cannot move money, except to an announced successor at a wind-down. It cannot change an open loan, set a bar or waive a co-signer's claim.

**Upgrades.** During the pilot, a separate multisig can replace the program's code after a delay, visibly on chain. Until that power is removed, every rule here holds unless the code is changed that way.

**Wind-down.** The administrator and a second key can announce a wind-down to a named successor. After the notice period, no new loans or donations are taken. Open loans run their course. The balance then moves to the successor, less what co-signers are owed, which is never moved.

[[TO CONFIRM: how unclaimed escrow and co-signer entitlements are treated]]

## Outages and network fees

Solana has had outages. During one, nobody can borrow or repay; money is not lost, but access pauses. **An outage across your cutoff still settles your loan.** We will publish the cutoffs it covered, the administrator can lift the borrower's and co-signer's bars in public, and we will help you pay back. The limit increase is not restored.

A **fee sponsor** (Kora) pays the network fees of Good Faith's transactions, so you need no SOL. If it is down, your wallet pays the network fee itself, and the app tells you first.

Repaying, settling, paying back, collecting, waiving and cancelling a recovery never depend on our website. A command-line tool does them against the blockchain alone.

## Third parties

These services are run by others, under their own terms and privacy policies:

- **Persona** checks your identity and keeps your selfie and documents under its own policy. [[TO CONFIRM: link to Persona's terms and data-retention policy]]
- **MoneyGram** offers cash-out and cash-in at its counters from the app's Checking page. It is the licensed party, runs its own identity check, and shows and charges its own fee and rate. **Good Faith adds no fee.** [[TO CONFIRM: link to MoneyGram's terms, production fees and Texas coverage]]
- **Turnkey** makes and keeps your wallet and runs sign-in (passkeys and emailed codes); its security and compliance details are at trust.turnkey.com. [[TO CONFIRM: link to Turnkey's terms]]
- **Circle** (USDC) and the **Solana** network.
- A relay sends notices to your contact. [[TO CONFIRM: name of the notice relay]]

[[TO CONFIRM: whether licensing, money-transmission or sanctions-screening rules apply, including to the MoneyGram service in the app]]

How we handle your data, including the fingerprint, is in the [privacy notice](privacy.html). [[TO CONFIRM: whether the selfie match is a biometric identifier under Texas law]]

## The software

The source is published so anyone can read and check it, under a **proprietary licence**: all rights are reserved, and publication grants no right to use, copy or change it. See the [source code](https://github.com/kiarashplusplus/goodfaith) and the [white paper](https://github.com/kiarashplusplus/goodfaith/blob/main/docs/whitepaper.md), including its risks.

The software and the service are offered **as is**, without warranty of any kind. Code can have mistakes even after review and testing.

## Liability and disputes

[[TO CONFIRM: limitation of liability and any cap]]

[[TO CONFIRM: dispute resolution, arbitration and class-action waiver, and courts]]

[[TO CONFIRM: consumer-credit disclosures required for a 0% loan]]

## Contact

[[TO CONFIRM: contact address for questions, appeals, stolen wallets and legal notices]]

You may leave an email for notices about your membership. It can be changed only from your current wallet, and the old contact is told.

## Changes to these terms

These terms are versioned, and every change is listed below with its date. We post a new version here before it takes effect and tell members who left a contact. [[TO CONFIRM: notice period for changes to these terms]] A change to these terms never changes an open loan.

- 0.3 (2026-10-25): wallets are Turnkey sign-in wallets (passkey or emailed code), with key export for the command-line tool.
- 0.2 (2026-10-25): the Texas check is the state on your ID, as the identity service reads it.
- 0.1 (2026-10-25): first draft.
