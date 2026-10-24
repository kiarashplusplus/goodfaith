# Economics of the fund

Good Faith has no revenue. Every dollar that leaves the fund and does not come back is a gift that was spent, and every
cost of running the fund is paid from gifts too. This note puts numbers on that so donors and the operator know what
they are signing up for. The arithmetic lives in `app/src/lib/economics.ts` (unit-tested); `scripts: npm run model`
prints every table below. The assumptions are estimates to be replaced with measured values after launch. Where a
table says "scenario", read it as one: the inputs are listed and none of them is a guarantee.

The headline is the **v7 pilot**: a $10,000 fund with at most $9,000 out on loan, run by volunteers, with the
platform's one-off costs (audit, legal work, the development already done) paid by the founder rather than by donors.
The v6 launch plan (a $100,000 fund held to a $25,000 ceiling, paid staff, one-offs charged to donors) follows for
comparison, because it is where the case for lending failed: under it, grants reached more people than loans. The base
scale after that is what a larger fund does once its members have grown into their caps.

## Definitions

- **Cycle**: the average loan term plus the time it takes to re-lend repaid money. 120 days at the base assumptions.
- **Settlement rate** (earlier versions called it the "default rate"): the share of loans *originated in a cycle* that
  are not repaid by their cutoff and are settled. It is a rate per loan, not a share of the fund, and it is not the
  ultimate loss: after a settlement the escrow covers part and pay-backs may cover more.
- **What a settlement leaves**, per settled loan *L*, with a share *r* repaid before the cutoff, an escrow share *e* and
  a share *p* of what is left paid back later:
  - principal unpaid at settlement: `L·(1−r)`;
  - covered by the escrow: `min(L·e, L·(1−r))`;
  - paid back later to the fund (pay-backs reach the fund's claim first): `min(fund's claim, p·L·(1−r))`;
  - **ultimate loss**: the fund's claim less what was paid back to it.
  The base assumes *p* = 0, the conservative side; a row shows *p* = ½.
- **Deposit used per settlement**: the part of the co-signer's escrow a settlement consumes, `min(L·e, L·(1−r))`, less
  what pay-backs beyond the fund's claim return to them. It is the co-signer's money, not the fund's; the model
  reports it beside the fund's loss because the co-signer pays it.
- **Conversion**: a borrower who needs dollars in a bank account converts USDC in and out through a service with its
  own fees. The model charges a fixed $3 each way per loan; it is the borrower's cost, not the fund's.
- **Capital lost per year**: loans per cycle × settlement rate × ultimate loss per settled loan × cycles per year.
- **Gifts needed per year (amortised)**: capital lost plus operating costs, with the one-off items spread over three
  years. What keeps the fund the same size on average.
- **Cash needed**: the same without the smoothing. Year one pays the one-off items in full; each later year pays the
  capital loss and the recurring costs.
- **Completed loans**, **borrower-years** and **people**: a loan repaid in full is one completed loan; a person who
  borrows twice in a year is one borrower-year (`loansPerBorrowerPerYear`, 2 at the base). Over several years the
  same person comes back: `repeatRate` turns borrower-years into people.
- **Half-life (capital only)** and **runway (pays its own way)**: how long the fund takes to halve with no new gifts
  when someone else pays the running costs, and how long it lasts when it pays them itself. The second is the honest
  one for a fund with no backer.

## The pilot (the headline)

Pilot assumptions: fund $10,000, at most $9,000 out on loan, at most $1,000 lent a day, $15,000 lent in total before
the budget is reviewed (about six months of pilot lending), 120-day cycle, settlement rate 5% of loans per cycle, 25%
escrow, 20% of principal repaid before a settlement, nothing paid back after one, two loans per borrower a year, about
100 new members a year. Running costs are the members' identity checks and renewals, the sponsor, and $1,800 of
hosting; support, disputes, fraud response and bookkeeping are volunteer time.

| scenario                                            | loans/yr | completed/yr | borrower-years/yr | loss/cycle | loss/yr | loss % fund | gifts needed/yr | per completed loan | per borrower-year | half-life (capital only) | runway (pays its own way) | collusion payoff |
|-----------------------------------------------------|----------|--------------|-------------------|------------|---------|-------------|-----------------|--------------------|-------------------|--------------------------|---------------------------|------------------|
| pilot ($10,000 fund, $9,000 ceiling, volunteer-run) | 91       | 87           | 43                | $248       | $753    | 7.5%        | $2,859          | $33                | $66               | 8.9                      | 3.9                       | $225             |
| pilot, settlement 10%                               | 91       | 82           | 41                | $495       | $1,506  | 15.1%       | $3,611          | $44                | $88               | 4.2                      | 3.4                       | $225             |
| pilot, settlement 2%                                | 91       | 89           | 45                | $99        | $301    | 3.0%        | $2,407          | $27                | $54               | 22.7                     | 4.4                       | $225             |

What the founder pays, so that donors do not:

| item           | amount           | note                                                                                                          |
|----------------|------------------|---------------------------------------------------------------------------------------------------------------|
| audit          | $30,000          | before any real money moves                                                                                   |
| legal          | $15,000          | before any real money moves                                                                                   |
| development    | $20,000          | already spent: the program, app and services exist                                                            |
| total          | $65,000          | a cost of building the platform, not of running the pilot                                                     |
| volunteer time | 150 hours a year | support, disputes, fraud response, bookkeeping: unpaid, and the first thing to cost money if volunteers leave |

Lending against giving, the same money on both sides (the endowment and the gifts the pilot needs):

|                                 | money in over ten years | people reached                                                                                    | what is left          | costs the fund does not pay                                          |
|---------------------------------|-------------------------|---------------------------------------------------------------------------------------------------|-----------------------|----------------------------------------------------------------------|
| grants of one average loan each | $38,586                 | 129 people, once                                                                                  | $0                    | -                                                                    |
| loans                           | $38,586                 | 238 people (433 borrower-years, 867 completed loans; 50.0% of a year's borrowers borrowed before) | $10,000 still lending | co-signers lost $3,422 of deposits; borrowers paid $5,475 to convert |

Over three years: about $18,600 in; as grants 62 people once, as loans 87 people, with the $10,000 still lending.

The assumptions behind that comparison:

| assumption                                            | value          | note                                                                                                                |
|-------------------------------------------------------|----------------|---------------------------------------------------------------------------------------------------------------------|
| completed loans per year                              | 87             | loans in the year that were not settled (settlement rate 5.0%)                                                      |
| loans per borrower per year                           | 2              | turns completed loans into borrower-years                                                                           |
| unique borrowers in year one                          | 43             | every borrower in the first year is new                                                                             |
| share of a later year's borrowers who borrowed before | 50.0%          | retention: the rest are new people                                                                                  |
| new borrowers each later year                         | 22             |                                                                                                                     |
| terminal value of the fund                            | $10,000        | the endowment is still there after ten years (with the gifts the table counts); grants leave nothing                |
| benefit compared                                      | people reached | not equal: a loan is the use of the money for a few months; a grant is the money, with no co-signer, deposit or bar |

**Why the pilot passes where the v6 plan did not.** Three things. The fund is sized to the ceiling, so no endowment
sits idle while counted as money spent. The running costs that do not scale with loans (paid support, bookkeeping,
fraud response) are volunteer time, which takes about $11,000 a year off the donors' side. And the one-off costs are the
founder's, which takes $65,000 off it. Each of these is a choice, and the comparison rests on it: charged to donors, the
founder's costs alone would put grants ahead again (the model's test checks this), and paid volunteers would narrow
the margin. Donors should read the pilot's figure as "what your gift does", not "what the whole project costs".

## The v6 launch plan, for comparison

Fund $100,000, the $25,000 ceiling on principal out on loan binds (so 25% lent), 120-day cycle,
settlement rate 5% of loans per cycle, 25% escrow, 20% of principal repaid before a settlement, nothing paid back
after one, two loans per borrower a year. The first row uses the first year's average loan from the ramp below; the
others use the mature $300.

| scenario                               | loans/yr | completed/yr | borrower-years/yr | loss/cycle | loss/yr | loss % fund | gifts needed/yr | per completed loan | per borrower-year | half-life (capital only) | runway (pays its own way) | collusion payoff |
|----------------------------------------|----------|--------------|-------------------|------------|---------|-------------|-----------------|--------------------|-------------------|--------------------------|---------------------------|------------------|
| launch, first year (average loan $184) | 412      | 392          | 196               | $688       | $2,091  | 2.1%        | $38,715         | $99                | $198              | 32.8                     | 2.2                       | $138             |
| launch ($25,000 ceiling)               | 253      | 241          | 120               | $688       | $2,091  | 2.1%        | $38,620         | $160               | $321              | 32.8                     | 2.2                       | $225             |
| launch, settlement 10%                 | 253      | 228          | 114               | $1,375     | $4,182  | 4.2%        | $40,711         | $178               | $357              | 16.2                     | 2.0                       | $225             |
| launch, settlement 2%                  | 253      | 248          | 124               | $275       | $836    | 0.8%        | $37,365         | $150               | $301              | 50+                      | 2.3                       | $225             |

### The ramp

A new member borrows at most $150. Each loan repaid on time, held at least 30 days, adds $100 (at most one step per
30 days), up to the $500 maximum; a settlement puts the member back on $150. The model assumes members join at a
steady rate, borrow back to back on 120-day cycles, and borrow the smaller of their cap and what they need ($300, the
mature average). The table is the average size of the loans opened in each month after launch:

| month        | 1    | 3    | 6    | 9    | 12   | 18   | 24   |
|--------------|------|------|------|------|------|------|------|
| average loan | $150 | $150 | $182 | $208 | $228 | $249 | $259 |

A member reaches the $300 need on their third loan, about eight months in, and the stream of new members keeps the
average below that for the first two years: about $184 over the first year. A smaller loan means more loans for the
same ceiling, so the first year completes more loans at a lower cost each, but each one is worth less to the person.

### What a settlement leaves

The settlement rate is not the loss. Per year at launch scale:

|                                 | principal unpaid at settlement | covered by escrow | paid back later (to the fund) | ultimate loss |
|---------------------------------|--------------------------------|-------------------|-------------------------------|---------------|
| launch, nothing paid back later | $3,042                         | $951              | $0                            | $2,091        |
| launch, half paid back later    | $3,042                         | $951              | $1,521                        | $570          |

How much is paid back after a settlement is the number we know least about and most need to measure. Nothing forces
it; the late bar is the incentive.

### Lending against giving

Ten years, the same money on both sides (the endowment and ten years of the gifts the fund needs; the one-off items
are charged once):

|                                 | money in over ten years | people reached                                                                                      | what is left           | costs the fund does not pay                                           |
|---------------------------------|-------------------------|-----------------------------------------------------------------------------------------------------|------------------------|-----------------------------------------------------------------------|
| grants of one average loan each | $334,532                | 1115 people, once                                                                                   | $0                     | -                                                                     |
| loans                           | $334,532                | 662 people (1204 borrower-years, 2408 completed loans; 50.0% of a year's borrowers borrowed before) | $100,000 still lending | co-signers lost $9,505 of deposits; borrowers paid $15,208 to convert |

The assumptions behind that comparison:

| assumption                                            | value          | note                                                                                                                |
|-------------------------------------------------------|----------------|---------------------------------------------------------------------------------------------------------------------|
| completed loans per year                              | 241            | loans in the year that were not settled (settlement rate 5.0%)                                                      |
| loans per borrower per year                           | 2              | turns completed loans into borrower-years                                                                           |
| unique borrowers in year one                          | 120            | every borrower in the first year is new                                                                             |
| share of a later year's borrowers who borrowed before | 50.0%          | retention: the rest are new people                                                                                  |
| new borrowers each later year                         | 60             |                                                                                                                     |
| terminal value of the fund                            | $100,000       | the endowment is still there after ten years (with the gifts the table counts); grants leave nothing                |
| benefit compared                                      | people reached | not equal: a loan is the use of the money for a few months; a grant is the money, with no co-signer, deposit or bar |

At launch scale the fixed costs of running the fund are spread over about 241 completed loans a year, so each costs
the donors about $160 against $300 lent, and the same money as grants would reach more people. **Loan volume against
fixed costs decides the result, not the settlement rate**: the launch rows at 2% and 10% differ by $28 per completed
loan, while raising the ceiling so that 80% of the fund is out (the base scale below) cuts the figure to $57. The
ceiling is there to bound a compromised identity service, not to make the economics look good; until it is raised,
grants reach more people than loans. And "people reached" is not equal benefit on the two sides: a loan is the use of
the money for a few months, with a co-signer, a deposit and a bar; a grant is the money.

## Scenarios at the base scale

Base assumptions: fund $100,000, 80% lent, average loan $300, 120-day cycle, settlement rate 5% of loans per cycle, 25%
escrow, 20% of principal repaid before a settlement, nothing paid back after one, two loans per borrower a year.
**Every row below keeps the base assumptions and changes one input**; the reviewer's row changes three and says so.

| scenario                                                         | loans/yr | completed/yr | borrower-years/yr | loss/cycle | loss/yr | loss % fund | gifts needed/yr | per completed loan | per borrower-year | half-life (capital only) | runway (pays its own way) | collusion payoff |
|------------------------------------------------------------------|----------|--------------|-------------------|------------|---------|-------------|-----------------|--------------------|-------------------|--------------------------|---------------------------|------------------|
| base                                                             | 811      | 771          | 385               | $2,200     | $6,692  | 6.7%        | $43,555         | $57                | $113              | 10.0                     | 1.8                       | $225             |
| settlement 2%                                                    | 811      | 795          | 397               | $880       | $2,677  | 2.7%        | $39,540         | $50                | $99               | 25.5                     | 2.1                       | $225             |
| settlement 10%                                                   | 811      | 730          | 365               | $4,400     | $13,383 | 13.4%       | $50,247         | $69                | $138              | 4.8                      | 1.4                       | $225             |
| settlement 15%                                                   | 811      | 689          | 345               | $6,600     | $20,075 | 20.1%       | $56,938         | $83                | $165              | 3.1                      | 1.0                       | $225             |
| nothing repaid before settlement                                 | 811      | 771          | 385               | $3,000     | $9,125  | 9.1%        | $45,988         | $60                | $119              | 7.2                      | 1.7                       | $225             |
| half of what settlements leave is paid back later                | 811      | 771          | 385               | $600       | $1,825  | 1.8%        | $38,688         | $50                | $100              | 37.6                     | 2.2                       | $225             |
| escrow 50%                                                       | 811      | 771          | 385               | $1,200     | $3,650  | 3.7%        | $40,513         | $53                | $105              | 18.6                     | 2.1                       | $150             |
| escrow 100%                                                      | 811      | 771          | 385               | $0         | $0      | 0.0%        | $36,863         | $48                | $96               | 50+                      | 2.3                       | $0               |
| 60-day cycle                                                     | 1622     | 1541         | 771               | $2,200     | $13,383 | 13.4%       | $50,733         | $33                | $66               | 4.8                      | 1.4                       | $225             |
| fund $25k                                                        | 203      | 193          | 96                | $550       | $1,673  | 6.7%        | $38,171         | $198               | $396              | 10.0                     | 0.3                       | $225             |
| average loan $150 (first-loan cap)                               | 1622     | 1541         | 771               | $2,200     | $6,692  | 6.7%        | $44,042         | $29                | $57               | 10.0                     | 1.8                       | $113             |
| average loan $500                                                | 487      | 462          | 231               | $2,200     | $6,692  | 6.7%        | $43,360         | $94                | $188              | 10.0                     | 1.9                       | $375             |
| one loan per borrower a year                                     | 811      | 771          | 771               | $2,200     | $6,692  | 6.7%        | $43,555         | $57                | $57               | 10.0                     | 1.8                       | $225             |
| reviewer: 10% settled, nothing repaid, fully lent (three inputs) | 1014     | 912          | 456               | $7,500     | $22,813 | 22.8%       | $59,798         | $66                | $131              | 2.7                      | 1.0                       | $225             |

## Costs (base)

Running costs are split into what recurs every year and what is paid once. The amortised line spreads the one-off
items over three years; the cash lines are what the bank account has to hold in year one and afterwards. The last two
lines are not the fund's costs at all: they are what co-signers and borrowers pay, listed so the whole price of a loan
is in one place.

| item                                                                   | kind                                                                  | per year            |
|------------------------------------------------------------------------|-----------------------------------------------------------------------|---------------------|
| identity checks                                                        | recurring, per new member                                             | $2.5 x 600 = $1,500 |
| pass renewals                                                          | recurring, per member a year (a signed message and a transaction fee) | $0.01 x 1000 = $10  |
| sponsor rent and fees                                                  | recurring, per loan                                                   | $0.6 x 811 = $487   |
| hosting                                                                | recurring                                                             | $1,800              |
| support                                                                | recurring                                                             | $6,000              |
| disputes                                                               | recurring                                                             | $1,500              |
| fraudResponse                                                          | recurring                                                             | $1,500              |
| bookkeeping                                                            | recurring                                                             | $2,400              |
| audit                                                                  | one-off, $30,000 over 3 years                                         | $10,000             |
| legal                                                                  | one-off, $15,000 over 3 years                                         | $5,000              |
| development                                                            | one-off, $20,000 over 3 years                                         | $6,667              |
| recurring total                                                        |                                                                       | $15,197             |
| one-off total (amortised)                                              |                                                                       | $21,667             |
| operating total (amortised)                                            |                                                                       | $36,863             |
| capital lost                                                           |                                                                       | $6,692              |
| gifts needed (amortised)                                               |                                                                       | $43,555             |
| cash needed, year one (one-offs paid in full)                          |                                                                       | $86,888             |
| cash needed, each later year                                           |                                                                       | $21,888             |
| co-signers' deposits used by settlements (their money, not the fund's) | per year                                                              | $3,042              |
| borrowers' conversion fees (their money, not the fund's)               | per year, $3 each way per loan                                        | $4,867              |

Support, disputes, fraud response and bookkeeping are people's time, priced as a part-time volunteer or contractor;
a fund run entirely by volunteers would show them as zero and the subsidy per completed loan would fall to about $29.
The co-signers' line is what the design asks of friends: each settlement uses up to $75 of a deposit, and that money
comes back only if the borrower pays back (or never, if the co-signer waives it). The conversion line is what
"fee-free" leaves out.

## Balance sheet (base)

Where the money sits at a moment in time:

| line                                                         | amount  |
|--------------------------------------------------------------|---------|
| cash in the vault, available to lend                         | $20,000 |
| principal out on loan                                        | $80,000 |
| co-signers' escrow held against those loans (not the fund's) | $20,000 |
| expected loss on the open loans                              | $2,200  |

The escrow is the co-signers' money, held by the program until each loan closes. It covers a settlement first; the
fund's own exposure on the open loans is the expected loss, not the principal. The program also tracks three
entitlement totals that are nobody's free cash (escrow owed to co-signers, escrow owed to the fund, reimbursements owed
to co-signers out of the vault), the recognised loss (`total_lost`) and how much of it was forgiven (`total_forgiven`).
`docs/spec.md` ("Accounting, worked through") follows one loan through every path.

## Ten years with no new gifts (base)

Capital only, operating costs paid from elsewhere. Each year the smaller fund lends less and loses less.

| year | fund at year end | loans that year | capital lost that year |
|------|------------------|-----------------|------------------------|
| 1    | $93,308          | 811             | $6,692                 |
| 2    | $87,064          | 757             | $6,244                 |
| 3    | $81,238          | 706             | $5,826                 |
| 4    | $75,802          | 659             | $5,436                 |
| 5    | $70,730          | 615             | $5,072                 |
| 6    | $65,997          | 574             | $4,733                 |
| 7    | $61,580          | 535             | $4,416                 |
| 8    | $57,460          | 499             | $4,121                 |
| 9    | $53,615          | 466             | $3,845                 |
| 10   | $50,027          | 435             | $3,588                 |

Paying its own way (capital losses and operating costs out of the vault, no gifts): the base fund lasts about 1.8
years. That is the figure a fund with no backer should plan around.

## Lending against giving (base)

|                                 | money in over ten years | people reached                                                                                       | what is left           | costs the fund does not pay                                            |
|---------------------------------|-------------------------|------------------------------------------------------------------------------------------------------|------------------------|------------------------------------------------------------------------|
| grants of one average loan each | $383,883                | 1280 people, once                                                                                    | $0                     | -                                                                      |
| loans                           | $383,883                | 2119 people (3853 borrower-years, 7706 completed loans; 50.0% of a year's borrowers borrowed before) | $100,000 still lending | co-signers lost $30,417 of deposits; borrowers paid $48,667 to convert |

Over ten years at the base scale co-signers lose about $30,000 of deposits and borrowers pay about $49,000 to convert,
neither of which a grant programme would ask of anyone.

## Stress scenarios

What the bad cases cost under stated assumptions. These are scenarios, not bounds. Two assumptions decide most of
them. The first is the containment time (from the first bad loan to the pause), which is the operator's, not the
program's. The second, for the attack rows, is that **no attack loan settles and no existing loan frees ceiling room
before containment**: a settlement takes a loan off the open book, so after one the ceiling would let lending start
again. The lifetime lending budget (`max_total_lent`, $15,000 for the pilot's first phase) is what bounds the total
whatever the timing, and below it the cash the fund holds: fake loans never come back, so the pilot cannot lend more than
its $10,000. The recognised loss (`total_lost`) is tracked apart from open exposure for the same reason. The rows use the
pilot's settings: a $9,000 ceiling, $1,000 a day, a $15,000 budget.

| scenario                                                                                      | assumptions                                                                                                                                                                                           | cost                                                                                                                                                                                                                  |
|-----------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| one cycle at a 30% settlement rate (correlated trouble)                                       | pilot, one cycle at 30% instead of 5%; escrow 25%; nothing paid back                                                                                                                                  | $1,485 that cycle; $1,990 that year (19.9% of the fund)                                                                                                                                                               |
| compromised identity service (issuer and gatekeeper), contained in 3 days, fund in normal use | no loan settles or is repaid before containment; $1,000 per fixed one-day window (4 windows straddled), first-loan cap $150, 25% escrow forfeited, $9,000 outstanding ceiling with $7,200 already out | up to $1,800 to 12 fake members, $1,350 lost (the ceiling's headroom binds)                                                                                                                                           |
| compromised identity service, contained in 3 days, nothing out                                | as above with the whole ceiling free                                                                                                                                                                  | up to $4,000 to 26 fake members, $3,000 lost                                                                                                                                                                          |
| compromised identity service, contained in 7 days, nothing out                                | as above, a week to notice and pause                                                                                                                                                                  | up to $8,000 (the ceiling binds), $6,000 lost                                                                                                                                                                         |
| compromised identity service, no window cap, nothing out                                      | 50 fake memberships a day, 3 days, the ceiling still binds                                                                                                                                            | $9,000 lent, $6,750 lost                                                                                                                                                                                              |
| compromised identity service, unnoticed for a month                                           | settlements free the ceiling as fast as the attacker lends; the $15,000 lifetime budget binds, and below it the $10,000 the fund holds                                                                | $10,000 lent, $7,500 lost: the whole fund less the forfeited deposits, and the worst case of the pilot                                                                                                                |
| 1,000 strangers' wallets for a day                                                            | onboarding lane: 60 sponsored transactions and 20 new wallets a day; no token accounts for non-members                                                                                                | $0.06 of sponsor money (20 wallets get in); the protected and member lanes are untouched                                                                                                                              |
| strangers every day for a year                                                                | the same lane, 365 days                                                                                                                                                                               | $22 a year (v5's single 2,000-transaction budget allowed $263,530)                                                                                                                                                    |
| every verified member at their caps for a year                                                | 100 members, 40 tx a day and 12 token accounts each, member lane 300 tx a day                                                                                                                         | $470 a year at most; each of them passed an identity check                                                                                                                                                            |
| 24-hour outage across deadlines                                                               | pilot volume; each affected loan is settled and reviewed (half an hour of volunteer time, priced at $40 an hour)                                                                                      | about 0.3 loans settled late through no fault of theirs; $5 of review; the fund's money is unchanged, but each co-signer's deposit is used until the borrower pays back and each borrower loses the loan's cap credit |
| a ring of three who never repay                                                               | each borrows the $150 first-loan cap once with the next as co-signer (no reciprocal pair), 25% escrow                                                                                                 | $338 taken ($113 each), $338 lost; $1,125 if all three had grown to the $500 cap (fits the $1,000 exposure limit)                                                                                                     |

- **Correlated settlements** (a local employer closing, a storm) are the realistic worst case for a fund whose members
  live in one place. A cycle at 30% costs six times a normal cycle; the escrow rate and the loan cap are the only
  levers, and the pause stops new lending while the operator looks.
- **A compromised identity service.** Joining needs both the issuer's signature and a valid pass from the gatekeeper,
  and so does every loan request and co-sign. Neither key alone can register anyone; the attack rows assume both, which
  the web service holds together. Each fake loan is
  capped at the first-loan amount and forfeits its escrow; the pool lends at most the window cap per fixed window (a
  boundary can be straddled); the ceiling caps what is out at once; and the lifetime budget caps the total.
- **Sponsor abuse.** The sponsor's daily budget is split into lanes: protected operations (settling, repaying, paying
  back, releasing, collecting, waiving, vetoing, finalising), onboarding (a wallet's first sponsored transaction, and
  joining) and members. Strangers can only spend the onboarding lane, and the sponsor pays rent only for members'
  token accounts and never for a close, so a stranger costs a transaction fee and cannot collect rent back. Version 5
  had one budget for everyone, worth about $264,000 a year to a determined attacker; the lanes bring the strangers' row
  to about $22 a year, and the members' row is bounded by the number of verified people.
- **An outage** that spans deadlines costs the fund no money: a late payer settles and pays back exactly as the
  cranker's settlement would. It costs the people in the loan: the co-signer's deposit is used until the loan is paid
  back, the borrower loses the loan's cap credit, and both are barred until the loan is paid back, the bars expire, or
  the administrator lifts them. The row counts the review.
- **Collusion is limited, not prevented.** Two people cannot guarantee each other, but three can form a ring with no
  reciprocal pair. Each borrows once; the ring cannot repeat with the same people. A colluding co-signer can no longer
  end the borrower's debt to the fund: they can waive only their own claim.

## What the numbers say

- **The pilot reaches more people as loans than as grants**: about 240 people against 130 over ten years, 87 against 62
  over three, for about $2,900 a year beyond the $10,000 endowment. That rests on the founder paying the platform's
  one-off costs and on volunteers doing the work; the paper says so.
- **The worst case is the fund.** A compromised identity service unnoticed for a month can take at most what the
  fund holds, losing $7,500 after the forfeited deposits; contained in three days it takes $1,800 to $4,000.
- **Under the v6 plan, grants reached more people.** With $25,000 out on loan from a $100,000 fund, paid staff and the
  one-offs charged to donors, each completed loan cost the donors about $160.
- **Loan volume against fixed costs decides the result, not the settlement rate.** Operating costs are about $37,000 a
  year at any scale; the capital loss is about $2,000 at launch scale and $6,700 at the base scale.
- **The first year is smaller loans.** New members start at $150 and most reach $300 in about eight months; the first
  year averages about $184 a loan.
- **The escrow rate is the lever on losses, and pay-backs are the unknown.** At 25% escrow the fund carries three
  quarters of every unpaid dollar until it is paid back. Half of what settlements leave being paid back later would
  cut the loss by more than two thirds.
- **The co-signer pays too.** Each settlement uses up to $75 of a deposit that comes back only when the loan is paid
  back. A design that leaned harder on the deposit would move the loss from the fund to the people least able to
  carry it.

## What to measure after launch

Settlement rate by cohort; share of principal repaid before a settlement and paid back after one; how often a
co-signer waives and the administrator forgives; how fast members grow into their caps; the real cycle length; loans
per borrower and the repeat rate; the identity check's approval rate and cost; pass renewals; the sponsor's spend per
lane per day; support hours per loan and per settled loan reviewed; how often the pause, a recovery veto or a bar lift
is used; and, before the pilot, how prospective borrowers and co-signers (including those who decline) weigh the
deposit, the bar and the social pressure of a guarantee. Each replaces an assumption above; the tables are regenerated
with `npm run model` and the white paper's section is updated from them.
