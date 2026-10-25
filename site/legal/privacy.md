---
title: Privacy notice
version: 0.4
effective: 2026-10-25
status: Draft for counsel's review. Good Faith runs on a test network with test money only.
---

## Who we are

Good Faith is an interest-free community loan fund for Texas residents aged 18 or older, run by a public program on the Solana blockchain. The **operator** runs the website, the app and the identity service. This notice explains what the operator collects and who else sees it.

The operator is [[TO CONFIRM: legal entity and contact address]].

On today's test network the identity check may be a stand-in that asks for no ID. This notice describes the service as built for real checks.

## The short version

- Our verification partner, Persona, sees your ID document and selfie. We do not.
- Our wallet provider, Turnkey, holds your sign-in (your email and your passkey's public key) and your wallet's key. We cannot use your key, but we can read the account details Turnkey keeps for you.
- Our server keeps a keyed fingerprint of your ID, a random person id, your wallet addresses and, if you give one, an email.
- Your wallet, your person id, your loans and any bar are public on Solana. They cannot be deleted.
- Our app and website have no advertising and no analytics.

## What we collect and why

### Your identity check

Everyone who borrows or co-signs verifies once, in Persona's own flow. Persona sees your ID document and selfie and keeps them under its own policy. We give Persona your wallet address to match the check to it.

When the check ends, our server learns the outcome. For an approved check it reads a few fields from your ID: the ID number, the state, your birth date and the document type. It uses them to confirm Texas and age 18 or older, and to make a fingerprint. It does not store those fields. It never receives your name, address, photo or selfie.

### The fingerprint and your person id

The fingerprint is a keyed code made from your ID number, state and birth date, so the same ID is recognised on a later check and one person holds one membership. Without our secret key, it cannot be linked back to an ID. It never goes on the blockchain.

Your **person id** is a random number drawn when you are first approved. It carries nothing from your ID, and it is the only identity value that goes on the blockchain.

### What our database holds

- For each wallet that starts a check: the wallet address, the Persona inquiry id, the status (such as approved or declined) with a short reason, your pass address, your person id, and any email you gave.
- For each person: the person id, the first wallet, any bar copied from the blockchain with its end date, and your email if you gave one.
- For each fingerprint: the person it belongs to, when and how it was added, and which key version made it.
- For a wallet recovery request: the new wallet, when you asked, whether the notice to you went out, the operator's proposal and how the request ended.
- For the fee sponsor: per-wallet counts of sponsored transactions, and fund-wide daily totals.

### Your email (optional)

You may give an email for notices about your membership: a recovery request, a bar set or lifted, a pass renewed, or a contact change. We use it for those notices only. It can be changed or removed only from the wallet linked to your membership, and your previous email is told about the change.

### IP addresses and logs

Our server uses your IP address to limit how often one device can call it. The address is held only in the server's memory. It is not written to our database, and it is lost when the server restarts.

Our hosting provider may keep standard request logs, with your IP address and the address requested, which can contain your wallet address. Our own server log records notices by a shortened person id, not by email. [[TO CONFIRM: hosting provider and how long request logs are kept]]

### Cookies and browser storage

Our app sets no cookies and has no analytics or advertising tools. The website is a plain page with no scripts. When you sign in, Turnkey's sign-in keeps a short-lived session key in your browser's storage (IndexedDB), so you are not asked again for each signature. A session lasts 15 minutes and the app renews it while it is open. Signing out removes it, and so does clearing your browser's site data.

## What is public on the blockchain

Solana is a public ledger. Anyone can read it, and nobody, including us, can change or delete what is written there. This includes:

- your wallet address, your person id, and the link between them;
- your membership and your pass, with its expiry and whether it is frozen;
- every loan you borrow or co-sign: amounts, terms, deposits, repayments, settlements and pay-backs;
- any bar, any lift of a bar, and any forgiveness, with the hash of a written reason;
- a wallet recovery, which links your old wallet to your new one;
- your other transfers, including a MoneyGram cash-out, which carries a note with MoneyGram's ID for matching the deposit. That ID is a random code; the reference number you collect cash with is never put on the blockchain.

Your person id is not anonymous. Anyone who learns your wallet can read this history, and our database can link the id back to your record. The operator publishes the written reasons behind bar lifts and forgiveness. [[TO CONFIRM: how published reasons avoid identifying members]]

Our app's status check answers for any wallet address, but only with what the blockchain shows anyway: whether the wallet is a member, its pass and any bar. The reason a check was declined, which can say your age or state, and the link to an open check are shown only after your wallet signs a message.

## Who we share with

- **Persona** runs the ID check and holds your ID document and selfie. Its own policy covers them. [[TO CONFIRM: Persona's retention policy, published before launch]]
- **Turnkey** makes and keeps your wallet. When you sign up it receives your email (if you sign in by email) and your passkey's public key, never your fingerprint or face, which stay on your device. It keeps the wallet's private key encrypted in its secure hardware and signs only when you sign in. It sends the emailed sign-in codes. Your account is a separate Turnkey sub-organisation that only your passkey or emailed code can act in; Good Faith's Turnkey organisation can **read** it (your email, your passkey's name and public key, your wallet addresses and the record of what was signed) but cannot sign, change or delete anything in it. We look at it only to support you or to investigate abuse. Turnkey's own privacy policy and its Trust Center (trust.turnkey.com, which lists its subprocessors) cover the rest. [[TO CONFIRM: Turnkey's data retention, from its Trust Center or its data processing agreement]]
- **MoneyGram** runs cash-out and cash-in in its own widget, with its own ID check. For cash-in it asks for your Social Security number and a second ID. Good Faith does not receive those. Our server only opens a session with MoneyGram and sends it nothing about you. The app gives the widget your wallet address and sees the transfer you sign. The widget loads its own tools, such as analytics and maps. MoneyGram's own privacy policy covers all of this.
- **The notice relay** sends notices for us. For each notice it receives your person id, the wallet concerned, your email and a short message. When you change your email, the notice to your old email includes the new one. [[TO CONFIRM: name of the notice relay service]]
- **The blockchain access provider (RPC)** carries the app's requests to Solana. It sees your IP address and the wallets and transactions the app looks up. On the test network this is Solana's public devnet service. [[TO CONFIRM: RPC provider for production]]
- **The fee sponsor (Kora)** pays network fees for Good Faith transactions. It receives the transaction you signed, which becomes public anyway, but not your IP address. In production its signing key is meant to be held by a key-custody service. [[TO CONFIRM: Kora hosting and signer provider]]
- **Hosting providers** run our servers, database and website. [[TO CONFIRM: hosting providers]]
- **When the law requires it**, we may disclose information. [[TO CONFIRM: policy for legal requests, reviewed by counsel]]

We do not sell your information or use it for advertising.

## How long we keep it

The code deletes nothing on a schedule. Wallet, person, fingerprint and sponsor records stay while the fund runs, including declined checks. Your latest recovery request stays as history until a new one replaces it. Database backups are kept with the keys.

Your email is also held outside our database: in the notice relay's records, and in an export of contact history the operator keeps off the web service, so it can check recovery requests. [[TO CONFIRM: retention periods for each record, backups, the relay and the operator's export]]

Records on the blockchain are permanent.

## How we protect it

- Your ID fields are not stored. The fingerprint is keyed with a secret on the server, so it cannot be worked out from the database alone.
- Separate keys do separate jobs. The key that approves a wallet recovery lives on the operator's own machine, never on the web server.
- Anyone with the fingerprint key and someone's ID fields could tell whether that person is a member, so a leaked key is treated as a breach: we replace it and tell members. Nothing public changes, because fingerprints never reach the blockchain.
- [[TO CONFIRM: breach notification steps and timelines under applicable law]]

No system is perfectly safe: a stored fingerprint and your email could leak.

## Your choices and rights

- You can choose not to give an email. Without notices, a recovery request you did not make is harder to spot.
- You can change or remove your email from your linked wallet at any time. That also replaces the copies kept on the records of your older wallets. An email you gave when verifying another wallet stays on that wallet's record; ask us to remove it.
- You can ask what we hold about you, and ask us to correct or delete it. We may need to keep some records, such as the fingerprint that stops one person holding two memberships. Nobody can delete anything from the blockchain.
- Ask Persona, Turnkey and MoneyGram directly about the data they hold.

[[TO CONFIRM: rights under applicable law, reviewed by counsel]]

[[TO CONFIRM: whether Texas law on biometric identifiers applies to the selfie check, and what consent it needs]]

## Children

Good Faith is only for people 18 or older. The check refuses anyone younger, using the birth date on their ID. We keep the record that the check was refused, not the birth date.

## Contact

For questions or requests about your information, write to [[TO CONFIRM: legal entity and contact address]].

## Changes to this notice

When this notice changes, we update its version and date and list the change below. [[TO CONFIRM: how members are told about material changes]]

- 0.4 (2026-10-25): wallets are Turnkey sign-in wallets; what Turnkey holds, what Good Faith can read there, and the browser session it keeps.
- 0.3 (2026-10-25): what a cash-out's note contains, and that the pickup reference number is not on the blockchain.
- 0.2 (2026-10-25): a check's reason and link need your wallet's signature; changing or removing your email also updates older wallets' copies.
- 0.1 (2026-10-25): first draft.
