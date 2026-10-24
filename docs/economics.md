# Economics of the fund

Good Faith has no revenue. Every dollar that leaves the fund and does not come back is a gift that was spent, and every
cost of running the fund is paid from gifts too. This note puts numbers on that so donors and the operator know what
they are signing up for. The arithmetic lives in `app/src/lib/economics.ts` (unit-tested); `scripts: npm run model`
prints every table below. The assumptions are estimates to be replaced with measured values after launch. Where a
table says "scenario", read it as one: the inputs are listed and none of them is a guarantee.

The headline comes first and it is the launch scale, because that is the fund the launch settings allow. The base
scale that follows is what the same fund does once the ceiling on money out on loan is raised.

## Definitions

- **Cycle**: the average loan term plus the time it takes to re-lend repaid money. 120 days at the base assumptions.
- **Default rate**: the share of loans *originated in a cycle* that end in default. It is a rate per loan, not a share
  of the fund. A 5% default rate on 270 loans a cycle means about 13 defaults a cycle.
- **Loss per defaulted loan**: the unpaid principal minus the escrow, never below zero: `max(0, L·(1−r) − L·e)` for a
  loan *L*, a share *r* repaid before the default and an escrow share *e*. Restitution (a borrower paying back after
  a settlement) reduces it; the model counts none, which is the conservative side.
- **Deposit used per default**: the part of the co-signer's escrow a default consumes, `min(L·e, L·(1−r))`. It is the
  co-signer's money, not the fund's; the model reports it beside the fund's loss because the co-signer pays it.
- **Conversion**: a borrower who needs dollars in a bank account converts USDC in and out through a service with its
  own fees. The model charges a fixed $3 each way per loan; it is the borrower's cost, not the fund's, and the paper
  says so where it says "fee-free".
- **Capital lost per year**: loans per cycle × default rate × loss per defaulted loan × cycles per year.
- **Gifts needed per year (amortised)**: capital lost plus operating costs, with the one-off items spread over three
  years. What keeps the fund the same size on average.
- **Cash needed**: the same without the smoothing. Year one pays the one-off items in full; each later year pays the
  capital loss and the recurring costs. A donor who funds year one needs the first figure, not the amortised one.
- **Completed loans**, **borrower-years** and **people**: a loan repaid in full is one completed loan; a person who
  borrows twice in a year is one borrower-year (`loansPerBorrowerPerYear`, 2 at the base). Over several years the
  same person comes back: `repeatRate` (half of a year's borrowers borrowed in an earlier year) turns borrower-years
  into people. Subsidy is given per completed loan and per borrower-year.
- **Half-life (capital only)**: how long the fund takes to halve with no new gifts when only the capital losses come
  out of it and someone else pays the running costs. **Runway (pays its own way)**: how long the fund lasts with no
  gifts when it pays both the losses and the running costs. The second is the honest one for a fund with no backer.

The reviewer's example checks out: a $100,000 fund fully lent at a 10% default rate with 25% escrow and nothing repaid
before default loses $7,500 per cycle (100,000 × 0.10 × 0.75).

## At launch scale (the headline)

Launch assumptions: fund $100,000, the $25,000 ceiling on principal out on loan binds (so 25% lent), average loan $300,
120-day cycle, default rate 5% of loans per cycle, 25% escrow, 20% of principal repaid before a default, two loans per
borrower a year.

| scenario                 | loans/yr | completed/yr | borrower-years/yr | loss/cycle | loss/yr | loss % fund | gifts needed/yr | per completed loan | per borrower-year | half-life (capital only) | runway (pays its own way) | collusion payoff |
|--------------------------|----------|--------------|-------------------|------------|---------|-------------|-----------------|--------------------|-------------------|--------------------------|---------------------------|------------------|
| launch ($25,000 ceiling) | 253      | 241          | 120               | $688       | $2,091  | 2.1%        | $38,620         | $160               | $321              | 32.8                     | 2.2                       | $225             |
| launch, default 10%      | 253      | 228          | 114               | $1,375     | $4,182  | 4.2%        | $40,711         | $178               | $357              | 16.2                     | 2.0                       | $225             |
| launch, default 2%       | 253      | 248          | 124               | $275       | $836    | 0.8%        | $37,365         | $150               | $301              | 50+                      | 2.3                       | $225             |

Lending against giving at launch scale, ten years, the same money on both sides (the endowment and ten years of the
gifts the fund needs; the one-off items are charged once, not once per amortisation period):

|                                 | money in over ten years | people reached                                                                                      | what is left           | costs the fund does not pay                                           |
|---------------------------------|-------------------------|-----------------------------------------------------------------------------------------------------|------------------------|-----------------------------------------------------------------------|
| grants of one average loan each | $334,532                | 1115 people, once                                                                                   | $0                     | -                                                                     |
| loans                           | $334,532                | 662 people (1204 borrower-years, 2408 completed loans; 50.0% of a year's borrowers borrowed before) | $100,000 still lending | co-signers lost $9,505 of deposits; borrowers paid $15,208 to convert |

At launch scale the fixed costs of running the fund are spread over about 241 completed loans a year, so each costs
the donors about $160 against $300 lent, and the same money as grants would reach more people. **Loan volume against
fixed costs decides the result, not the default rate**: the launch rows at 2% and 10% defaults differ by $28 per
completed loan, while raising the ceiling so that 80% of the fund is out (the base scale below) cuts the figure to
$57. The design pays off only once the ceiling is raised, and the ceiling is there to bound a compromised issuer, not
to make the economics look good; until it is raised, grants reach more people than loans.

## Scenarios at the base scale

Base assumptions: fund $100,000, 80% lent, average loan $300, 120-day cycle, default rate 5% of loans per cycle, 25%
escrow, 20% of principal repaid before a default, two loans per borrower a year. **Every row below keeps the base
assumptions and changes one input**; the reviewer's row changes three and says so.

| scenario                                                         | loans/yr | completed/yr | borrower-years/yr | loss/cycle | loss/yr | loss % fund | gifts needed/yr | per completed loan | per borrower-year | half-life (capital only) | runway (pays its own way) | collusion payoff |
|------------------------------------------------------------------|----------|--------------|-------------------|------------|---------|-------------|-----------------|--------------------|-------------------|--------------------------|---------------------------|------------------|
| base                                                             | 811      | 771          | 385               | $2,200     | $6,692  | 6.7%        | $43,555         | $57                | $113              | 10.0                     | 1.8                       | $225             |
| default 2%                                                       | 811      | 795          | 397               | $880       | $2,677  | 2.7%        | $39,540         | $50                | $99               | 25.5                     | 2.1                       | $225             |
| default 10%                                                      | 811      | 730          | 365               | $4,400     | $13,383 | 13.4%       | $50,247         | $69                | $138              | 4.8                      | 1.4                       | $225             |
| default 15%                                                      | 811      | 689          | 345               | $6,600     | $20,075 | 20.1%       | $56,938         | $83                | $165              | 3.1                      | 1.0                       | $225             |
| nothing repaid before default                                    | 811      | 771          | 385               | $3,000     | $9,125  | 9.1%        | $45,988         | $60                | $119              | 7.2                      | 1.7                       | $225             |
| escrow 50%                                                       | 811      | 771          | 385               | $1,200     | $3,650  | 3.7%        | $40,513         | $53                | $105              | 18.6                     | 2.1                       | $150             |
| escrow 100%                                                      | 811      | 771          | 385               | $0         | $0      | 0.0%        | $36,863         | $48                | $96               | 50+                      | 2.3                       | $0               |
| 60-day cycle                                                     | 1622     | 1541         | 771               | $2,200     | $13,383 | 13.4%       | $50,733         | $33                | $66               | 4.8                      | 1.4                       | $225             |
| fund $25k                                                        | 203      | 193          | 96                | $550       | $1,673  | 6.7%        | $38,171         | $198               | $396              | 10.0                     | 0.3                       | $225             |
| average loan $150 (first-loan cap)                               | 1622     | 1541         | 771               | $2,200     | $6,692  | 6.7%        | $44,042         | $29                | $57               | 10.0                     | 1.8                       | $113             |
| average loan $500                                                | 487      | 462          | 231               | $2,200     | $6,692  | 6.7%        | $43,360         | $94                | $188              | 10.0                     | 1.9                       | $375             |
| one loan per borrower a year                                     | 811      | 771          | 771               | $2,200     | $6,692  | 6.7%        | $43,555         | $57                | $57               | 10.0                     | 1.8                       | $225             |
| reviewer: 10% default, nothing repaid, fully lent (three inputs) | 1014     | 912          | 456               | $7,500     | $22,813 | 22.8%       | $59,798         | $66                | $131              | 2.7                      | 1.0                       | $225             |

## Costs (base)

Running costs are split into what recurs every year and what is paid once. The amortised line spreads the one-off
items over three years; the cash lines are what the bank account has to hold in year one and afterwards. The last two
lines are not the fund's costs at all: they are what co-signers and borrowers pay, listed so the whole price of a loan
is in one place.

| item                                                                | kind                                                                  | per year            |
|---------------------------------------------------------------------|-----------------------------------------------------------------------|---------------------|
| identity checks                                                     | recurring, per new member                                             | $2.5 x 600 = $1,500 |
| pass renewals                                                       | recurring, per member a year (a signed message and a transaction fee) | $0.01 x 1000 = $10  |
| sponsor rent and fees                                               | recurring, per loan                                                   | $0.6 x 811 = $487   |
| hosting                                                             | recurring                                                             | $1,800              |
| support                                                             | recurring                                                             | $6,000              |
| disputes                                                            | recurring                                                             | $1,500              |
| fraudResponse                                                       | recurring                                                             | $1,500              |
| bookkeeping                                                         | recurring                                                             | $2,400              |
| audit                                                               | one-off, $30,000 over 3 years                                         | $10,000             |
| legal                                                               | one-off, $15,000 over 3 years                                         | $5,000              |
| development                                                         | one-off, $20,000 over 3 years                                         | $6,667              |
| recurring total                                                     |                                                                       | $15,197             |
| one-off total (amortised)                                           |                                                                       | $21,667             |
| operating total (amortised)                                         |                                                                       | $36,863             |
| capital lost                                                        |                                                                       | $6,692              |
| gifts needed (amortised)                                            |                                                                       | $43,555             |
| cash needed, year one (one-offs paid in full)                       |                                                                       | $86,888             |
| cash needed, each later year                                        |                                                                       | $21,888             |
| co-signers' deposits used by defaults (their money, not the fund's) | per year                                                              | $3,042              |
| borrowers' conversion fees (their money, not the fund's)            | per year, $3 each way per loan                                        | $4,867              |

Support, disputes, fraud response and bookkeeping are people's time, priced as a part-time volunteer or contractor;
a fund run entirely by volunteers would show them as zero and the subsidy per completed loan would fall to about $29.
The co-signers' line is what the design asks of friends: at a 5% default rate with a fifth repaid before the default,
each default uses $75 of a deposit, and that money comes back only if the borrower pays back (or never, if the
co-signer forgives the rest). The conversion line is what "fee-free" leaves out: a borrower who turns a $150 loan into
bank dollars and back pays about $6, 4% of the loan, to services the fund does not control.

## Balance sheet (base)

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
by settled loans not yet collected, and reimbursements owed to co-signers out of the vault after a restitution. A
deposit sent to an escrow after the deadline is owed back to the co-signer and never counts as recovery, and a stray
deposit to a closed loan's escrow is swept into the fund as a donation when the escrow is finally emptied.

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
years. That is the figure a fund with no backer should plan around; the ten-year table above is what the capital alone
does.

## Lending against giving (base)

The comparison that matters puts the same money on both sides over the same time: the endowment and ten years of
the gifts the fund needs. As grants, all of it is handed out once. As loans, the gifts cover the losses and the
running costs, the endowment keeps turning over, and it is still there at the end. The one-off items are counted once
on both sides (an earlier version of this table charged them ten times over, once per amortised year, which
overstated the money in by about $150,000), and borrower-years are turned into people with the repeat rate.

|                                 | money in over ten years | people reached                                                                                       | what is left           | costs the fund does not pay                                            |
|---------------------------------|-------------------------|------------------------------------------------------------------------------------------------------|------------------------|------------------------------------------------------------------------|
| grants of one average loan each | $383,883                | 1280 people, once                                                                                    | $0                     | -                                                                      |
| loans                           | $383,883                | 2119 people (3853 borrower-years, 7706 completed loans; 50.0% of a year's borrowers borrowed before) | $100,000 still lending | co-signers lost $30,417 of deposits; borrowers paid $48,667 to convert |

Three caveats the numbers do not show. A grant has no co-signer, no deposit and no bar; a loan asks a friend to put up
25% and a borrower to pay it back, which some people cannot or will not do, so the two reach different people, not
only different numbers of them. A loan's benefit is the use of the money for the term, a grant's is the money itself;
the model counts people reached, not value delivered. And the last column is real money that leaves real pockets: over
ten years at the base scale co-signers lose about $30,000 of deposits to defaults and borrowers pay about $49,000 to
convert, neither of which a grant programme would ask of anyone.

## Stress scenarios

What the bad cases cost under stated assumptions. The caps bound each one; the assumption that decides the figure is
the containment time (how long from the first bad loan to the pause), which is the operator's, not the program's.
These are scenarios, not bounds.

| scenario                                                    | assumptions                                                                                                                                            | cost                                                                                                                                                                                                                   |
|-------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| one cycle at a 30% default rate (correlated trouble)        | base, one cycle at 30% instead of 5%; escrow 25%                                                                                                       | $13,200 that cycle; $17,692 that year (17.7% of the fund)                                                                                                                                                              |
| compromised issuer, contained in 3 days, fund in normal use | $5,000 per fixed one-day window (4 windows straddled), first-loan cap $150, 25% escrow forfeited, $25,000 outstanding ceiling with $20,000 already out | up to $5,000 to 33 fake members, $3,750 lost (the ceiling's headroom binds)                                                                                                                                            |
| compromised issuer, contained in 3 days, nothing out        | as above with the whole ceiling free                                                                                                                   | up to $20,000 to 133 fake members, $15,000 lost                                                                                                                                                                        |
| compromised issuer, contained in 7 days, nothing out        | as above, a week to notice and pause                                                                                                                   | up to $25,000 (the ceiling binds), $18,750 lost                                                                                                                                                                        |
| compromised issuer, no window cap, nothing out              | 50 fake memberships a day, 3 days, the ceiling still binds                                                                                             | $22,500 lent, $16,875 lost                                                                                                                                                                                             |
| 1,000 abusive wallets for a day                             | per-wallet caps 40 tx/day and 12 token accounts; fund-wide budget 2,000 tx and 200 new wallets a day                                                   | $722 of sponsor money (200 wallets get in; $3,640 with per-wallet caps alone)                                                                                                                                          |
| abusive wallets every day for a year                        | the same budget, 365 days                                                                                                                              | $263,530 of sponsor money a year at most (73,000 wallets, 730,000 transactions)                                                                                                                                        |
| 24-hour outage across deadlines                             | base volume; each affected loan is settled and reviewed (half an hour at $40)                                                                          | about 2.2 loans settled late through no fault of theirs; $44 of review; the fund's money is unchanged, but each co-signer's deposit is used until the borrower pays back and each borrower loses the loan's cap credit |
| a ring of three who never repay                             | each borrows the $150 first-loan cap once with the next as co-signer (no reciprocal pair), 25% escrow                                                  | $338 taken ($113 each), $338 lost; $1,125 if all three had grown to the $500 cap (fits the $1,000 exposure limit)                                                                                                      |

- **Correlated defaults** (a local employer closing, a storm) are the realistic worst case for a fund whose members
  live in one place. A cycle at 30% costs six times a normal cycle; the escrow rate and the loan cap are the only
  levers, and the emergency pause stops new lending while the operator looks.
- **A compromised issuer** can register fake people. Each fake loan is capped at the first-loan amount for the
  cooldown and forfeits its escrow; the pool disburses at most the window cap per fixed window (a boundary can be
  straddled, so three days can mean four windows); and the ceiling on principal out on loan caps the total whatever
  the timing. With the fund in normal use the ceiling's headroom is what the attacker gets, $5,000 at the base
  utilisation; the larger figures assume an empty book. The loss grows with the containment time until the ceiling
  binds.
- **Sponsor abuse** is bounded per wallet by the proxy's caps and, for a crowd, by the fund-wide daily budget of
  transactions and first-time wallets; a thousand wallets a day cost hundreds of dollars, not thousands. The daily
  budget is not a yearly one: an attacker who returns every day can cost the sponsor its whole daily budget every
  day, about $264,000 a year at these settings, which is why the sponsor's spend is watched and the budget is a
  setting the operator lowers when it is being spent by strangers. The sponsor also pays rent only for token accounts
  of the pool's mint, and only for members unless the transaction carries a Good Faith instruction.
- **An outage** that spans deadlines costs the fund no money: a late payer settles and pays back exactly as the
  cranker's settlement would. It costs the people in the loan: the co-signer's deposit is used until the borrower pays
  back, the borrower loses the loan's cap credit and goes back to the first-loan cap, and both are barred until the
  borrower pays back or the administrator lifts the bars. The remedy is the administrator's lift (`lift_bar`, public,
  with the reason) for both people, the operator's published list of affected cutoffs, and help for the borrower to
  pay back so the co-signer is made whole; the cap steps are not restored. The row counts the review.
- **Collusion is limited, not prevented.** Two people cannot guarantee each other, but three can form a ring with no
  reciprocal pair. Each person borrows once, the ring cannot repeat with the same people (each is barred and their
  ID is on record), and the exposure limit caps what one person can be in for; what it takes is the loan caps minus
  the escrow, per person.

## What the numbers say

- **At launch scale, grants reach more people.** With $25,000 out on loan at most, the fund completes about 240 loans
  a year and each costs the donors about $160; the same money over ten years reaches about 1,100 people as grants and
  about 660 as loans. The ceiling is a safety setting, and the price of it is that the fund does not pay off until it
  is raised.
- **Loan volume against fixed costs decides the result, not the default rate.** Operating costs are about $37,000 a
  year at any scale; the capital loss is $2,000 at launch scale and $6,700 at the base scale. At the base scale a
  completed loan costs the donors about $57 and a borrower-year about $113 against $300 lent, and the same money
  reaches about 2,100 people as loans against 1,300 as grants, with the fund still there.
- **Defaults are the fund's only way to shrink, and the escrow rate is the lever.** At 25% escrow the fund carries
  three quarters of every unpaid dollar. Doubling the escrow halves the loss; at 100% the fund never loses capital
  and a default costs only the co-signer. The price of a higher escrow is a smaller pool of people who can co-sign,
  and more of a friend's money at risk.
- **The co-signer pays too.** Each default uses $75 of a deposit that comes back only when the borrower pays back.
  At the base scale that is about $3,000 a year of friends' money; a design that leaned harder on the deposit would
  move the loss from the fund to the people least able to carry it.
- **Velocity multiplies both the good and the bad.** Shorter loans help twice as many people a year, lose twice as
  much to the same default rate, and halve the subsidy per completed loan.
- **A ring pays $338 on the first-loan cap and $1,125 at the full cap**, once per set of people, and costs each of
  them their eligibility for the configured durations (two years for the borrower, one for a co-signer who left a
  loss, at the launch settings), an ID on record, and the exposure limits keep any one person from scaling it.

## What to measure after launch

Default rate by cohort, share of principal repaid before default and paid back after it (by the borrower and by
others), how often a co-signer forgives, the real cycle length, loans per borrower and the repeat rate, the identity
check's approval rate and cost, pass renewals, the sponsor's spend per loan and per day, support hours per loan and
per settled loan reviewed, and how often the pause, a recovery veto or a bar lift is used. Each replaces an assumption
above; the tables are regenerated with `npm run model` and the white paper's section is updated from them.
