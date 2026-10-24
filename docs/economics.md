# Economics of the fund

Good Faith has no revenue. Every dollar that leaves the fund and does not come back is a gift that was spent, and every
cost of running the fund is paid from gifts too. This note puts numbers on that so donors and the operator know what
they are signing up for. The arithmetic lives in `app/src/lib/economics.ts` (unit-tested); `scripts: npm run model`
prints every table below. The assumptions are estimates to be replaced with measured values after launch. Where a
table says "scenario", read it as one: the inputs are listed and none of them is a guarantee.

## Definitions

- **Cycle**: the average loan term plus the time it takes to re-lend repaid money. 120 days at the base assumptions.
- **Default rate**: the share of loans *originated in a cycle* that end in default. It is a rate per loan, not a share
  of the fund. A 5% default rate on 270 loans a cycle means about 13 defaults a cycle.
- **Loss per defaulted loan**: the unpaid principal minus the escrow, never below zero: `max(0, L·(1−r) − L·e)` for a
  loan *L*, a share *r* repaid before the default and an escrow share *e*. Restitution (a borrower paying back after
  a settlement) reduces it; the model counts none, which is the conservative side.
- **Capital lost per year**: loans per cycle × default rate × loss per defaulted loan × cycles per year.
- **Gifts needed per year (amortised)**: capital lost plus operating costs, with the one-off items spread over three
  years. What keeps the fund the same size on average.
- **Cash needed**: the same without the smoothing. Year one pays the one-off items in full; each later year pays the
  capital loss and the recurring costs. A donor who funds year one needs the first figure, not the amortised one.
- **Completed loans** and **people**: a loan repaid in full is one completed loan; a person who borrows twice a year
  is one person. The model turns loans into people with `loansPerBorrowerPerYear` (2 at the base). Subsidy is given
  per completed loan and per person.
- **Half-life (capital only)**: how long the fund takes to halve with no new gifts when only the capital losses come
  out of it and someone else pays the running costs. **Runway (pays its own way)**: how long the fund lasts with no
  gifts when it pays both the losses and the running costs. The second is the honest one for a fund with no backer.

The reviewer's example checks out: a $100,000 fund fully lent at a 10% default rate with 25% escrow and nothing repaid
before default loses $7,500 per cycle (100,000 × 0.10 × 0.75).

## Scenarios

Base assumptions: fund $100,000, 80% lent, average loan $300, 120-day cycle, default rate 5% of loans per cycle, 25%
escrow, 20% of principal repaid before a default, two loans per borrower a year. **Every row below keeps the base
assumptions and changes one input**; the reviewer's row changes three and says so.

| scenario                                                         | loans/yr | completed/yr | people/yr | loss/cycle | loss/yr | loss % fund | gifts needed/yr | per completed loan | per person | half-life (capital only) | runway (pays its own way) | collusion payoff |
|------------------------------------------------------------------|----------|--------------|-----------|------------|---------|-------------|-----------------|--------------------|------------|--------------------------|---------------------------|------------------|
| base                                                             | 811      | 771          | 385       | $2,200     | $6,692  | 6.7%        | $43,545         | $57                | $113       | 10.0                     | 1.8                       | $225             |
| default 2%                                                       | 811      | 795          | 397       | $880       | $2,677  | 2.7%        | $39,530         | $50                | $99        | 25.5                     | 2.1                       | $225             |
| default 10%                                                      | 811      | 730          | 365       | $4,400     | $13,383 | 13.4%       | $50,237         | $69                | $138       | 4.8                      | 1.4                       | $225             |
| default 15%                                                      | 811      | 689          | 345       | $6,600     | $20,075 | 20.1%       | $56,928         | $83                | $165       | 3.1                      | 1.0                       | $225             |
| nothing repaid before default                                    | 811      | 771          | 385       | $3,000     | $9,125  | 9.1%        | $45,978         | $60                | $119       | 7.2                      | 1.7                       | $225             |
| escrow 50%                                                       | 811      | 771          | 385       | $1,200     | $3,650  | 3.7%        | $40,503         | $53                | $105       | 18.6                     | 2.1                       | $150             |
| escrow 100%                                                      | 811      | 771          | 385       | $0         | $0      | 0.0%        | $36,853         | $48                | $96        | 50+                      | 2.3                       | $0               |
| 60-day cycle                                                     | 1622     | 1541         | 771       | $2,200     | $13,383 | 13.4%       | $50,723         | $33                | $66        | 4.8                      | 1.4                       | $225             |
| fund $25k                                                        | 203      | 193          | 96        | $550       | $1,673  | 6.7%        | $38,161         | $198               | $396       | 10.0                     | 0.3                       | $225             |
| average loan $150 (first-loan cap)                               | 1622     | 1541         | 771       | $2,200     | $6,692  | 6.7%        | $44,032         | $29                | $57        | 10.0                     | 1.8                       | $113             |
| average loan $500                                                | 487      | 462          | 231       | $2,200     | $6,692  | 6.7%        | $43,350         | $94                | $188       | 10.0                     | 1.9                       | $375             |
| one loan per borrower a year                                     | 811      | 771          | 771       | $2,200     | $6,692  | 6.7%        | $43,545         | $57                | $57        | 10.0                     | 1.8                       | $225             |
| reviewer: 10% default, nothing repaid, fully lent (three inputs) | 1014     | 912          | 456       | $7,500     | $22,813 | 22.8%       | $59,788         | $66                | $131       | 2.7                      | 1.0                       | $225             |

## Costs

Running costs are split into what recurs every year and what is paid once. The amortised line spreads the one-off
items over three years; the cash lines are what the bank account has to hold in year one and afterwards.

| item                                          | kind                          | per year            |
|-----------------------------------------------|-------------------------------|---------------------|
| identity checks                               | recurring, per new member     | $2.5 x 600 = $1,500 |
| sponsor rent and fees                         | recurring, per loan           | $0.6 x 811 = $487   |
| hosting                                       | recurring                     | $1,800              |
| support                                       | recurring                     | $6,000              |
| disputes                                      | recurring                     | $1,500              |
| fraudResponse                                 | recurring                     | $1,500              |
| bookkeeping                                   | recurring                     | $2,400              |
| audit                                         | one-off, $30,000 over 3 years | $10,000             |
| legal                                         | one-off, $15,000 over 3 years | $5,000              |
| development                                   | one-off, $20,000 over 3 years | $6,667              |
| recurring total                               |                               | $15,187             |
| one-off total (amortised)                     |                               | $21,667             |
| operating total (amortised)                   |                               | $36,853             |
| capital lost                                  |                               | $6,692              |
| gifts needed (amortised)                      |                               | $43,545             |
| cash needed, year one (one-offs paid in full) |                               | $86,878             |
| cash needed, each later year                  |                               | $21,878             |

Support, disputes, fraud response and bookkeeping are people's time, priced as a part-time volunteer or contractor;
a fund run entirely by volunteers would show them as zero and the subsidy per completed loan would fall to about $29.

## Balance sheet

Where the money sits at a moment in time, at the base assumptions:

| line                                                         | amount  |
|--------------------------------------------------------------|---------|
| cash in the vault, available to lend                         | $20,000 |
| principal out on loan                                        | $80,000 |
| co-signers' escrow held against those loans (not the fund's) | $20,000 |
| expected loss on the open loans                              | $2,200  |

The escrow is the co-signers' money, held by the program until each loan closes. It is what covers a default first;
the fund's own exposure on the open loans is the expected loss, not the principal. The program also tracks three
entitlement totals that are nobody's free cash: escrow owed to co-signers of closed loans, escrow owed to the fund
by settled loans not yet collected, and reimbursements owed to co-signers out of the vault after a restitution.

## Ten years with no new gifts

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

Paying its own way (capital losses and operating costs out of the vault, no gifts): the base fund lasts about 1.8 years. That is the figure a fund with no backer should plan around; the ten-year table above is
what the capital alone does.

## Lending against giving

The comparison that matters puts the same money on both sides over the same time: the endowment and ten years of
the gifts the fund needs. As grants, all of it is handed out once. As loans, the gifts cover the losses and the
running costs, the endowment keeps turning over, and it is still there at the end.

|                                 | money in over ten years | people reached                                    | what is left           |
|---------------------------------|-------------------------|---------------------------------------------------|------------------------|
| grants of one average loan each | $535,450                | 1785 people, once                                 | $0                     |
| loans                           | $535,450                | 3853 people (7706 completed loans, 2 a year each) | $100,000 still lending |

Two caveats the numbers do not show. A grant has no co-signer, no deposit and no bar; a loan asks a friend to put up
25% and a borrower to pay it back, which some people cannot or will not do, so the two reach different people, not
only different numbers of them. And a loan's benefit is the use of the money for the term, a grant's is the money
itself; the model counts people reached, not value delivered.

## Stress scenarios

What the bad cases cost under stated assumptions. The caps bound each one; the assumption that decides the figure is
the containment time (how long from the first bad loan to the pause), which is the operator's, not the program's.

| scenario                                             | assumptions                                                                                                                                    | cost                                                                                                              |
|------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| one cycle at a 30% default rate (correlated trouble) | base, one cycle at 30% instead of 5%; escrow 25%                                                                                               | $13,200 that cycle; $17,692 that year (17.7% of the fund)                                                         |
| compromised issuer, contained in 3 days              | $5,000 per fixed one-day window (4 windows straddled), first-loan cap $150, 25% escrow forfeited, $25,000 outstanding ceiling with nothing out | up to $20,000 to 133 fake members, $15,000 lost                                                                   |
| compromised issuer, contained in 7 days              | as above, a week to notice and pause                                                                                                           | up to $25,000 (the ceiling binds), $18,750 lost                                                                   |
| compromised issuer, no window cap                    | 50 fake memberships a day, 3 days, the ceiling still binds                                                                                     | $22,500 lent, $16,875 lost                                                                                        |
| 1,000 abusive wallets for a day                      | per-wallet caps 40 tx/day and 12 token accounts; fund-wide budget 2,000 tx and 200 new wallets a day                                           | $722 of sponsor money (200 wallets get in; $3,640 with per-wallet caps alone)                                     |
| 24-hour outage across deadlines                      | base volume; each affected loan is settled and reviewed (half an hour at $40)                                                                  | about 2.2 loans settled late through no fault of theirs; $44 of review; the money is unchanged                    |
| a ring of three who never repay                      | each borrows the $150 first-loan cap once with the next as co-signer (no reciprocal pair), 25% escrow                                          | $338 taken ($113 each), $338 lost; $1,125 if all three had grown to the $500 cap (fits the $1,000 exposure limit) |

- **Correlated defaults** (a local employer closing, a storm) are the realistic worst case for a fund whose members
  live in one place. A cycle at 30% costs six times a normal cycle; the escrow rate and the loan cap are the only
  levers, and the emergency pause stops new lending while the operator looks.
- **A compromised issuer** can register fake people. Each fake loan is capped at the first-loan amount for the
  cooldown and forfeits its escrow; the pool disburses at most the window cap per fixed window (a boundary can be
  straddled, so three days can mean four windows); and the ceiling on principal out on loan caps the total whatever
  the timing. The loss grows with the containment time until the ceiling binds.
- **Sponsor abuse** is bounded per wallet by the proxy's caps and, for a crowd, by the fund-wide daily budget of
  transactions and first-time wallets; a thousand wallets a day cost hundreds of dollars, not thousands.
- **An outage** that spans deadlines costs no money: a late payer settles and pays back exactly as the cranker's
  settlement would. It costs review: each affected loan is settled and its borrower barred until the operator lifts
  the bar (`lift_bar`, public, with the reason), which is time, not capital.
- **Collusion is limited, not prevented.** Two people cannot guarantee each other, but three can form a ring with no
  reciprocal pair. Each person borrows once, the ring cannot repeat with the same people (each is barred and their
  ID is on record), and the exposure limit caps what one person can be in for; what it takes is the loan caps minus
  the escrow, per person.

## What the numbers say

- **Defaults are the fund's only way to shrink, and the escrow rate is the lever.** At 25% escrow the fund carries
  three quarters of every unpaid dollar. Doubling the escrow halves the loss; at 100% the fund never loses capital
  and a default costs only the co-signer. The price of a higher escrow is a smaller pool of people who can co-sign.
- **Operating costs dominate the capital loss.** At the base assumptions they are five times the capital loss, and
  the one-off items (audit, legal, development) are more than half of them for the first three years. A small fund
  pays nearly the same to run as a large one: at $25,000 each completed loan costs the donors about $200 and the
  fund paying its own way lasts months, not years.
- **A completed loan costs the donors about $57, a person about $113** at the base assumptions, against $300 lent.
  Over ten years the same money reaches about twice as many people as loans than as grants, and the fund is still
  there. That ratio, not the default rate alone, is the case for lending rather than giving, with the caveats above.
- **Velocity multiplies both the good and the bad.** Shorter loans help twice as many people a year, lose twice as
  much to the same default rate, and halve the subsidy per completed loan.
- **A ring pays $338 on the first-loan cap and $1,125 at the full cap**, once per set of people, and costs each of
  them their eligibility for the configured durations (two years for the borrower, one for a co-signer who left a
  loss, at the launch settings), an ID on record, and the exposure limits keep any one person from scaling it.

## What to measure after launch

Default rate by cohort, share of principal repaid before default and restituted after it, the real cycle length,
loans per borrower, the identity check's approval rate and cost, the sponsor's spend per loan, support hours per loan
and per settled loan reviewed, and how often the pause, a recovery veto or a bar lift is used. Each replaces an
assumption above; the tables are regenerated with `npm run model` and the white paper's section is updated from
them.
