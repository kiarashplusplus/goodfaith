# Economics of the fund

Good Faith has no revenue. Every dollar that leaves the fund and does not come back is a gift that was spent, and every
cost of running the fund is paid from gifts too. This note puts numbers on that so donors and the operator know what
they are signing up for. The arithmetic lives in `app/src/lib/economics.ts` (unit-tested); `scripts: npm run model`
prints every table below. The assumptions are estimates to be replaced with measured values after launch.

## Definitions

- **Cycle**: the average loan term plus the time it takes to re-lend repaid money. 120 days at the base assumptions.
- **Default rate**: the share of loans *originated in a cycle* that end in default. It is a rate per loan, not a share
  of the fund. A 5% default rate on 270 loans a cycle means about 13 defaults a cycle.
- **Loss per defaulted loan**: the unpaid principal minus the escrow, never below zero: `max(0, L·(1−r) − L·e)` for a
  loan *L*, a share *r* repaid before the default and an escrow share *e*.
- **Capital lost per year**: loans per cycle × default rate × loss per defaulted loan × cycles per year.
- **Gifts needed per year**: capital lost plus operating costs. What keeps the fund the same size.
- **Subsidy per completed loan**: gifts needed per year divided by the loans repaid in full that year. What one
  working loan costs the donors.
- **Years to half**: how long the fund takes to halve with no new gifts, when each year the smaller fund lends less and
  loses proportionally less (the straight-line "years to depletion" overstates how fast a shrinking fund disappears).

The reviewer's example checks out: a $100,000 fund fully lent at a 10% default rate with 25% escrow and nothing repaid
before default loses $7,500 per cycle (100,000 × 0.10 × 0.75).

## Scenarios

Base assumptions: fund $100,000, 80% lent, average loan $300, 120-day cycle, default rate 5% of loans per cycle, 25%
escrow, 20% of principal repaid before a default. **Every row below keeps the base assumptions and changes one input**;
the reviewer's row changes three and says so.

| scenario                                                         | loans/yr | completed/yr | loss/cycle | loss/yr | loss % fund | gifts needed/yr | subsidy per completed loan | years to half | collusion payoff |
|------------------------------------------------------------------|----------|--------------|------------|---------|-------------|-----------------|----------------------------|---------------|------------------|
| base                                                             | 811      | 771          | $2,200     | $6,692  | 6.7%        | $43,545         | $57                        | 10.0          | $225             |
| default 2%                                                       | 811      | 795          | $880       | $2,677  | 2.7%        | $39,530         | $50                        | 25.5          | $225             |
| default 10%                                                      | 811      | 730          | $4,400     | $13,383 | 13.4%       | $50,237         | $69                        | 4.8           | $225             |
| default 15%                                                      | 811      | 689          | $6,600     | $20,075 | 20.1%       | $56,928         | $83                        | 3.1           | $225             |
| nothing repaid before default                                    | 811      | 771          | $3,000     | $9,125  | 9.1%        | $45,978         | $60                        | 7.2           | $225             |
| escrow 50%                                                       | 811      | 771          | $1,200     | $3,650  | 3.7%        | $40,503         | $53                        | 18.6          | $150             |
| escrow 100%                                                      | 811      | 771          | $0         | $0      | 0.0%        | $36,853         | $48                        | never         | $0               |
| 60-day cycle                                                     | 1622     | 1541         | $2,200     | $13,383 | 13.4%       | $50,723         | $33                        | 4.8           | $225             |
| fund $25k                                                        | 203      | 193          | $550       | $1,673  | 6.7%        | $38,161         | $198                       | 10.0          | $225             |
| average loan $150 (first-loan cap)                               | 1622     | 1541         | $2,200     | $6,692  | 6.7%        | $44,032         | $29                        | 10.0          | $113             |
| average loan $500                                                | 487      | 462          | $2,200     | $6,692  | 6.7%        | $43,350         | $94                        | 10.0          | $375             |
| reviewer: 10% default, nothing repaid, fully lent (three inputs) | 1014     | 912          | $7,500     | $22,813 | 22.8%       | $59,788         | $66                        | 2.7           | $225             |

## Costs

Running costs are split into what recurs every year and what is paid once and spread over three years. The one-off
items dominate at the start; the recurring ones are what the fund has to raise for ever.

| item                      | kind                          | per year            |
|---------------------------|-------------------------------|---------------------|
| identity checks           | recurring, per new member     | $2.5 x 600 = $1,500 |
| sponsor rent and fees     | recurring, per loan           | $0.6 x 811 = $487   |
| hosting                   | recurring                     | $1,800              |
| support                   | recurring                     | $6,000              |
| disputes                  | recurring                     | $1,500              |
| fraud response            | recurring                     | $1,500              |
| bookkeeping               | recurring                     | $2,400              |
| audit                     | one-off, $30,000 over 3 years | $10,000             |
| legal                     | one-off, $15,000 over 3 years | $5,000              |
| development               | one-off, $20,000 over 3 years | $6,667              |
| recurring total           |                               | $15,187             |
| one-off total (amortised) |                               | $21,667             |
| operating total           |                               | $36,853             |
| capital lost              |                               | $6,692              |
| gifts needed              |                               | $43,545             |

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
the fund's own exposure on the open loans is the expected loss, not the principal.

## Ten years with no new gifts

Capital only (operating costs paid from elsewhere). Each year the smaller fund lends less and loses less.

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

## Stress

What the bounded bad cases cost, and what bounds them.

| stress                                               | bounded by                                                             | cost                                                      |
|------------------------------------------------------|------------------------------------------------------------------------|-----------------------------------------------------------|
| one cycle at a 30% default rate (correlated trouble) | escrow rate, loan cap                                                  | $13,200 that cycle; $17,692 that year (17.7% of the fund) |
| compromised issuer, found after 3 days               | disbursement cap $5,000/day, first-loan cap $150, 25% escrow forfeited | at most $15,000 lent to 100 fake members, $11,250 lost    |
| same, with no disbursement cap                       | how fast fake people can be registered (50/day assumed)                | $22,500 lent, $16,875 lost                                |
| 1,000 abusive wallets for a day                      | proxy caps: 40 tx/day, 12 token accounts per wallet                    | $3,640 of sponsor money ($4 per wallet)                   |
| 24-hour outage across deadlines                      | grace period; money unaffected                                         | about 2.2 members marked late through no fault of theirs  |

- **Correlated defaults** (a local employer closing, a storm) are the realistic worst case for a fund whose members
  live in one place. A cycle at 30% costs six times a normal cycle; the escrow rate and the loan cap are the only
  levers, and the emergency pause stops new lending while the operator looks.
- **A compromised issuer** can register fake people. Each fake loan is capped at the first-loan amount for the
  cooldown, every fake loan forfeits its escrow, and the pool disburses at most the daily cap, so the loss until the
  pause is pulled is bounded and known in advance. Without the disbursement cap the bound is only how fast fake
  people can be made.
- **Sponsor abuse** is bounded per wallet by the proxy and costs cents per wallet; a thousand wallets a day is a
  nuisance, not a threat to the fund.
- **An outage** that spans deadlines costs no money: a late repayment and a default settle the same way in either
  order. It costs fairness, which is what the grace period and the operator's discretion over late bans are for.

## What the numbers say

- **Defaults are the fund's only way to shrink, and the escrow rate is the lever.** At 25% escrow the fund carries
  three quarters of every unpaid dollar. Doubling the escrow halves the loss; at 100% the fund never loses capital
  and a default costs only the co-signer. The price of a higher escrow is a smaller pool of people who can co-sign.
- **Operating costs dominate the capital loss.** At the base assumptions they are five times the capital loss, and
  the one-off items (audit, legal, development) are more than half of them for the first three years. A small fund
  pays nearly the same to run as a large one: at $25,000 each completed loan costs the donors about $200.
- **A completed loan costs the donors about $57** at the base assumptions, against $300 lent. The same $43,500 of
  yearly gifts handed out as $300 grants would reach 145 people; as loans it reaches 771 completed borrowers a year,
  because the money comes back. That ratio, not the default rate alone, is the case for lending rather than giving.
- **Velocity multiplies both the good and the bad.** Shorter loans help twice as many people a year, lose twice as
  much to the same default rate, and halve the subsidy per completed loan.
- **Collusion pays $225 per $300 loan** (the loan minus the escrow), and only $113 while a new member is on the
  $150 first-loan cap. It costs both people their eligibility for the configured durations (two years for the
  borrower, one for a co-signer who left a loss, at the launch settings), an ID on record, and the exposure limits
  keep any one pair from scaling it.

## What to measure after launch

Default rate by cohort, share of principal repaid before default, the real cycle length, the identity check's
approval rate and cost, the sponsor's spend per loan, support hours per loan, and how often the pause or a recovery
veto is used. Each replaces an assumption above; the tables are regenerated with `npm run model` and the white paper's
section is updated from them.
