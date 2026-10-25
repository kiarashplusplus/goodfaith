# site

The public website: one static page (`index.html`, `styles.css`, `assets/`), no build step and no JavaScript. It says
what Good Faith requires before anyone connects a wallet: Texas and 18+, the ID check, a wallet, a co-signer and the
deposit, the bars, and MoneyGram's own requirements for cash. Anything not yet confirmed carries a "To confirm" tag.

## Figures stay in step with the launch settings

Every loan figure on the page is a `<span data-launch="key">` naming a field of `scripts/launch.json`
(`data-unit="percent"` for basis points, `data-unit="years"` for days shown in years). `cd scripts && npm run
site-check` fails if one differs or a required one is missing; CI runs it in the web-app job. Change `launch.json`
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
