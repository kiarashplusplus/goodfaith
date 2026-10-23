# Economics of the fund

Good Faith has no revenue. Every dollar that leaves the fund and does not come back is a gift that was spent, and every
cost of running the fund is paid from gifts too. This note puts numbers on that so donors and the operator know what
they are signing up for. The arithmetic lives in `app/src/lib/economics.ts` (unit-tested); `scripts: npm run model`
prints the tables below. The assumptions are estimates to be replaced with measured values after launch.

## The model

For a fund of size *F* with a share *u* out on loan at any time, average loan *L*, a cycle of *T* days (term plus the
time to re-lend repaid money), a default rate *d* per loan, co-signer escrow *e* (share of the loan) and an average
share *r* of the principal repaid before a default:

- loans per year = (*F·u / L*) × (365 / *T*)
- loss per defaulted loan = max(0, *L·(1−r) − L·e*): the unpaid part minus what the escrow covers
- loss per cycle = loans per cycle × *d* × loss per defaulted loan; loss per year = loss per cycle × cycles per year
- operating costs per year = identity checks for new members + sponsor rent and fees per loan + hosting + audit
- donations needed per year = loss per year + operating costs: what keeps the fund the same size
- collusion payoff = *L − L·e*: what a borrower and co-signer who never intended to repay walk away with on one loan

The reviewer's example checks out: a $100,000 fund fully lent at a 10% default rate with 25% escrow and nothing repaid
before default loses $7,500 per cycle (100,000 × 0.10 × 0.75).

## Scenarios

Base assumptions: fund $100,000, 80% lent, average loan $300, 120-day cycle, 20% of principal repaid before a default,
25% escrow, 5% default rate. Operating costs: $2.50 per identity check for 600 new members a year, $0.60 of
unrecoverable sponsor cost per loan (the Loan account's rent plus fees), $1,800 a year of hosting, a $10,000
independent audit amortised over a year.

| scenario                                                      | loans/yr | loss/cycle | loss/yr | loss % fund | operating/yr | donations needed/yr | years to depletion | collusion payoff |
|---------------------------------------------------------------|----------|------------|---------|-------------|--------------|---------------------|--------------------|------------------|
| base: 5% default, 25% escrow                                  | 811      | $2,200     | $6,692  | 6.7%        | $13,787      | $20,478             | 14.9               | $225             |
| reviewer: 10% default, 25% escrow, nothing repaid, fully lent | 1014     | $7,500     | $22,813 | 22.8%       | $13,908      | $36,721             | 4.4                | $225             |
| good year: 2% default                                         | 811      | $880       | $2,677  | 2.7%        | $13,787      | $16,463             | 37.4               | $225             |
| bad year: 15% default                                         | 811      | $6,600     | $20,075 | 20.1%       | $13,787      | $33,862             | 5.0                | $225             |
| higher escrow: 50%                                            | 811      | $1,200     | $3,650  | 3.7%        | $13,787      | $17,437             | 27.4               | $150             |
| escrow 100% (co-signer fully covers)                          | 811      | $0         | $0      | 0.0%        | $13,787      | $13,787             | never              | $0               |
| shorter loans: 60-day cycle                                   | 1622     | $2,200     | $13,383 | 13.4%       | $14,273      | $27,657             | 7.5                | $225             |
| small fund: $25k, 60% lent                                    | 152      | $413       | $1,255  | 5.0%        | $12,266      | $13,521             | 19.9               | $225             |
| larger loans: $500 average                                    | 487      | $2,200     | $6,692  | 6.7%        | $13,592      | $20,284             | 14.9               | $375             |

## What the numbers say

- **Defaults are the fund's only way to shrink, and the escrow rate is the lever.** At 25% escrow the fund carries
  three quarters of every unpaid dollar. Doubling the escrow halves the loss; at 100% the fund never loses capital
  and a default costs only the co-signer. The price of a higher escrow is a smaller pool of people who can co-sign.
- **Operating costs are mostly fixed.** At the base assumptions they are about twice the capital loss, and the audit
  is the largest single item. A small fund pays nearly the same to run as a large one, so running costs dominate
  until the fund is well above $100,000.
- **Donations needed are modest next to the capital.** Keeping a $100,000 fund whole at a 5% default rate takes
  about $20,000 of gifts a year, of which $6,700 replaces lost capital. At 15% defaults it is $34,000.
- **Velocity multiplies both the good and the bad.** Shorter loans help twice as many people a year and lose twice as
  much to the same default rate.
- **Collusion pays $225 per $300 loan** (the loan minus the escrow) and costs both people their membership for good,
  and the co-signer their escrow. The fund limits each person to one open loan and each co-signer to two guarantees,
  caps loans, and keeps one membership per verified person, so a colluding pair can do it once. Whether $225 is worth
  a permanent ban and an ID on record is the deterrent; raising the escrow lowers the payoff further.

## What to measure after launch

Default rate by cohort, share of principal repaid before default, the real cycle length, the identity check's
approval rate and cost, and the sponsor's spend per loan. Each replaces an assumption above; the tables are
regenerated with `npm run model` and the white paper's section is updated from them.
