// Builds the site's legal pages from Markdown: site/legal/<name>.md -> site/<name>.html. The Markdown is the source;
// edit it, bump `version` and `effective` in its front matter, add a line under its "Changes" heading, and run
// `npm run site-legal`. `--check` (CI) fails when a page is out of date with its Markdown or with launch.json.
//
// The Markdown is a small subset: front matter (title, version, effective, status), `## ` / `### ` headings,
// paragraphs, `- ` lists (one level), **bold**, *italic*, [text](url), `{{launch:field}}` / `{{launch:field|percent}}` /
// `{{launch:field|years}}` (values from scripts/launch.json) and `[[TO CONFIRM: ...]]` (shown as a "To confirm" tag).
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const site = path.join(here, '..', 'site');
const launch = JSON.parse(fs.readFileSync(path.join(here, 'launch.json'), 'utf8')) as Record<string, unknown>;
const check = process.argv.includes('--check');

type Doc = { meta: Record<string, string>; body: string };

export function parse(md: string): Doc {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error('missing front matter');
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const k of ['title', 'version', 'effective', 'status']) if (!meta[k]) throw new Error(`front matter needs ${k}`);
  return { meta, body: m[2] };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function launchValue(field: string, unit: string | undefined): string {
  const v = launch[field];
  if (typeof v !== 'number') throw new Error(`{{launch:${field}}}: not a number in launch.json`);
  if (unit === 'percent') return String(v / 100);
  if (unit === 'years') return String(v / 365);
  if (unit) throw new Error(`{{launch:${field}|${unit}}}: unknown unit`);
  return String(v);
}

export function inline(text: string): string {
  let s = esc(text);
  s = s.replace(/\{\{launch:(\w+)(?:\|(\w+))?\}\}/g, (_, f: string, u?: string) =>
    `<span data-launch="${f}"${u ? ` data-unit="${u}"` : ''}>${launchValue(f, u)}</span>`);
  s = s.replace(/\[\[TO CONFIRM:\s*([^\]]+?)\s*\]\]/g, (_, t: string) => `<span class="tbc">To confirm: ${t}</span>`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, t: string, href: string) => {
    const h = href.replace(/&amp;/g, '&');
    if (!/^(https:\/\/|mailto:|#|[\w./-]+\.html(#[\w-]+)?$)/.test(h)) throw new Error(`link not allowed: ${href}`);
    return `<a href="${esc(h)}">${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  if (/\{\{|\[\[/.test(s)) throw new Error(`unrecognised token in: ${text}`);
  return s;
}

const slug = (t: string) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function render(body: string): { html: string; toc: { id: string; text: string }[] } {
  const out: string[] = [];
  const toc: { id: string; text: string }[] = [];
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    if (list.length) out.push(`<ul>\n${list.map((i) => `  <li>${inline(i)}</li>`).join('\n')}\n</ul>`);
    para = [];
    list = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trimEnd();
    const h = line.match(/^(##|###) (.+)$/);
    if (h) {
      flush();
      const text = inline(h[2]);
      const id = slug(h[2]);
      if (h[1] === '##') toc.push({ id, text });
      out.push(h[1] === '##' ? `<h2 id="${id}">${text}</h2>` : `<h3 id="${id}">${text}</h3>`);
    } else if (line.startsWith('- ')) {
      if (para.length) flush();
      list.push(line.slice(2).trim());
    } else if (line.trim() === '') {
      flush();
    } else if (/^(#|\d+\.\s|\||<|```|\s*[*+]\s)/.test(line)) {
      throw new Error(`unsupported Markdown: ${line}`);
    } else if (list.length) {
      list[list.length - 1] += ' ' + line.trim(); // a wrapped list item
    } else {
      para.push(line.trim());
    }
  }
  flush();
  return { html: out.join('\n'), toc };
}

export function page(name: string, doc: Doc): string {
  const { html, toc } = render(doc.body);
  const t = esc(doc.meta.title);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${t} — Good Faith</title>
  <link rel="icon" href="assets/texas-flag.svg" type="image/svg+xml">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <!-- Generated from site/legal/${name}.md by scripts/site-legal.ts: edit the Markdown, then run npm run site-legal. -->
  <p class="banner" role="note"><strong>Test network only.</strong> Good Faith runs on Solana devnet with test money. Nothing here moves real dollars yet.</p>
  <header class="hero">
    <div class="wrap">
      <p class="eyebrow"><a href="index.html">Good Faith</a></p>
      <h1>${t}</h1>
      <p class="meta">Version ${esc(doc.meta.version)} · effective ${esc(doc.meta.effective)}</p>
      <p class="status">${inline(doc.meta.status)}</p>
      <nav class="jump" aria-label="Sections">
${toc.map((s) => `        <a href="#${s.id}">${s.text}</a>`).join('\n')}
      </nav>
    </div>
  </header>
  <main class="wrap doc">
${html}
  </main>
  <footer class="wrap foot">
    <p><a href="index.html">Home</a> · <a href="privacy.html">Privacy notice</a> · <a href="terms.html">Terms of use</a></p>
    <p>Copyright © 2026 Kiarash Adl. All rights reserved.</p>
  </footer>
</body>
</html>
`;
}

// ---------- the home page's derived parts: FAQ structured data and llms.txt ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
/** Visible text of an HTML fragment: tags dropped, entities decoded, whitespace collapsed. */
export const text = (html: string) =>
  html.replace(/<[^>]+>/g, '').replace(/&(\w+|#\d+);/g, (m, e: string) => ENTITIES[e] ?? m).replace(/\s+/g, ' ').trim();

/** The Questions section's visible questions and answers, in order. */
export function faqOf(indexHtml: string): { q: string; a: string }[] {
  const sec = indexHtml.match(/<section id="faq"[\s\S]*?<\/section>/);
  if (!sec) throw new Error('index.html has no Questions section (#faq)');
  return [...sec[0].matchAll(/<details>\s*<summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)].map((m) => ({ q: text(m[1]), a: text(m[2]) }));
}

const FAQ_START = '<!-- faq-ld:start (generated from the Questions section by scripts/site-legal.ts; do not edit by hand) -->';
const FAQ_END = '<!-- faq-ld:end -->';

/** index.html with its FAQPage JSON-LD rebuilt from the visible questions, so the two always say the same thing. */
export function withFaqLd(indexHtml: string): string {
  const i = indexHtml.indexOf(FAQ_START), j = indexHtml.indexOf(FAQ_END);
  if (i < 0 || j < i) throw new Error('index.html is missing the faq-ld markers');
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqOf(indexHtml).map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
  const block = `${FAQ_START}\n  <script type="application/ld+json">\n  ${JSON.stringify(ld).replace(/</g, '\\u003c')}\n  </script>\n  `;
  return indexHtml.slice(0, i) + block + indexHtml.slice(j);
}

/** A plain-text summary of the home page for AI tools: the data-llms sections, in page order, without the widgets. */
export function llmsTxt(indexHtml: string): string {
  const desc = indexHtml.match(/<meta name="description" content="([^"]*)">/)?.[1] ?? '';
  const body = indexHtml.replace(/<!-- llms:skip -->[\s\S]*?<!-- \/llms:skip -->/g, '');
  const out = [
    '# Good Faith',
    '',
    `> ${text(desc)}`,
    '',
    'Status: test network only. Good Faith runs on Solana devnet with test money; nothing moves real dollars yet.',
    '',
  ];
  for (const m of body.matchAll(/<section[^>]*data-llms="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)) {
    out.push(`## ${m[1]}`, '');
    const inner = m[2]
      .replace(/<h2[^>]*>[\s\S]*?<\/h2>/g, '')
      .replace(/^\s*<h3[^>]*>[\s\S]*?<\/h3>/, '') // a tab panel's own heading repeats the section's
      .replace(/<\/label>\s*<p>/g, ' ') // a checklist row: its label and its explanation on one bullet
      .replace(/<summary>([\s\S]*?)<\/summary>/g, '\n### $1\n')
      .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/g, '\n### $1\n')
      .replace(/<li[^>]*>\s*/g, '\n- ')
      .replace(/<\/(p|li|ul|ol|div|details)>/g, '\n');
    for (const line of inner.split('\n').map((l) => (l.trim().startsWith('- ') || l.trim().startsWith('### ') ? l.trim().slice(0, 2) + text(l.trim().slice(2)) : text(l))))
      if (line && line !== '-') out.push(line.startsWith('##') ? `\n${line}` : line);
    out.push('');
  }
  out.push(
    '## Links',
    '',
    '- Home: https://goodfaith.fi/',
    '- Privacy notice: https://goodfaith.fi/privacy.html',
    '- Terms of use: https://goodfaith.fi/terms.html',
    '- White paper: https://github.com/kiarashplusplus/goodfaith/blob/main/docs/whitepaper.md',
    '- Source code: https://github.com/kiarashplusplus/goodfaith',
    '',
  );
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const dir = path.join(site, 'legal');
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  let stale = 0;
  const outputs: [string, string, string][] = names.map((name) => [
    `${name}.html`,
    page(name, parse(fs.readFileSync(path.join(dir, `${name}.md`), 'utf8'))),
    `site/legal/${name}.md or launch.json`,
  ]);
  const index = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  outputs.push(['index.html', withFaqLd(index), 'its Questions section (the FAQ structured data)']);
  outputs.push(['llms.txt', llmsTxt(withFaqLd(index)), 'index.html']);
  for (const [file, content, source] of outputs) {
    const target = path.join(site, file);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (check) {
      if (current !== content) { console.error(`  site/${file} is out of date with ${source}`); stale++; }
    } else if (current !== content) {
      fs.writeFileSync(target, content);
      console.log(`wrote site/${file}`);
    }
  }
  if (check && stale) { console.error('Run: cd scripts && npm run site-legal'); console.error('SITE-LEGAL FAIL'); process.exit(1); }
  console.log(`${names.length} legal page(s), the FAQ structured data and llms.txt ${check ? 'up to date' : 'built'}`);
  console.log(check ? 'SITE-LEGAL PASS' : 'SITE-LEGAL DONE');
}
