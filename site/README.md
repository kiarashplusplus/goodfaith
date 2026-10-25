# site

The public website: one static page (`index.html`, `styles.css`, `assets/`), no build step and no JavaScript. It says
what Good Faith requires before anyone connects a wallet: Texas and 18+, the ID check, a wallet, a co-signer and the
deposit, the bars, and MoneyGram's own requirements for cash. Anything not yet confirmed carries a "To confirm" tag.

## Interactive, and still readable without JavaScript

Every word is in `index.html`; `app.js` (no dependencies) only adds behaviour: the requirements checklist's result,
the "I want to…" tabs and the loan explorer. Without JavaScript (some crawlers, old phones) all tab panels show
stacked, the checklist is a list and a static worked example stands in for the explorer. The explorer reads every
figure from the page's `data-launch` spans and uses the program's own deposit formula (`ceil(amount × bps / 10000)`).

For search and AI tools: the head carries a description, canonical URL, Open Graph tags and schema.org `WebSite` and
`Organization` data; `robots.txt` and `sitemap.xml` sit beside the page. Two parts are **generated** from the page by
`cd scripts && npm run site-legal` and checked in CI by its `--check`: the `FAQPage` structured data (between the
`faq-ld` markers in the head, rebuilt from the visible Questions so the two always match) and `llms.txt`, a plain-text
summary of the page's `data-llms` sections (blocks between `llms:skip` markers are left out). Edit the page, then run
it.

## Figures stay in step with the launch settings

Every loan figure on the page is a `<span data-launch="key">` naming a field of `scripts/launch.json`
(`data-unit="percent"` for basis points, `data-unit="years"` for days shown in years). `cd scripts && npm run
site-check` fails if one differs or a required one is missing, if the worked example's deposit or loss (`data-example`) does not follow the deposit formula, or if the requirements stop being the first section; CI runs it in the web-app job. Change `launch.json`
and the page together.

## Privacy notice and terms of use

`privacy.html` and `terms.html` are generated: the source is `legal/privacy.md` and `legal/terms.md`. To change one:

1. Edit the Markdown. Supported: front matter, `## ` / `### ` headings, paragraphs, `- ` lists, **bold**, *italic*,
   links, `[[TO CONFIRM: ...]]` (shown as a "To confirm" tag) and `{{launch:field}}` (`|percent`, `|years`), which
   takes the figure from `scripts/launch.json` so the terms never drift from the settings.
2. Bump `version` and `effective` in its front matter, and add a line under its "Changes" heading saying what changed.
3. `cd scripts && npm run site-legal` rewrites the HTML. CI runs `npm run site-legal -- --check`, which fails when a
   page is out of date with its Markdown or with `launch.json`.

Both are drafts for counsel's review: every `[[TO CONFIRM]]` must be resolved by counsel before real money moves.

## Deploy (Cloudflare Pages)

Create a Pages project from this repository with no build command and `site` as the output directory, then add the
custom domain (goodfaith.fi once registered; `.fi` is not sold by Cloudflare Registrar, so register it with a
Traficom-accredited registrar and point its nameservers at Cloudflare). Any static host works the same way.

## Branding

- **Texas flag**: `assets/texas-flag.svg`, drawn to the flag's proportions (2:3; a blue band one third wide, white over
  red, a white star). The footer says Good Faith is not affiliated with or endorsed by the State of Texas.
- **MoneyGram**: shown as the integrated cash partner ("powered by MoneyGram"). Use only MoneyGram's own logo file
  from the Partner Portal's brand kit, as its guidelines allow: save it as `assets/moneygram-logo.svg`, replace the
  `<span class="mg">MoneyGram</span>` wordmarks in the cash section with `<img src="assets/moneygram-logo.svg"
  alt="MoneyGram">`, and set `--mg` in `styles.css` to the kit's red. Until then the name is plain styled text. The
  footer carries MoneyGram's trademark notice.
