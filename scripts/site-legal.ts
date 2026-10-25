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

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const dir = path.join(site, 'legal');
  const names = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  let stale = 0;
  for (const name of names) {
    const html = page(name, parse(fs.readFileSync(path.join(dir, `${name}.md`), 'utf8')));
    const target = path.join(site, `${name}.html`);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (check) {
      if (current !== html) { console.error(`  site/${name}.html is out of date with site/legal/${name}.md or launch.json`); stale++; }
    } else if (current !== html) {
      fs.writeFileSync(target, html);
      console.log(`wrote site/${name}.html`);
    }
  }
  if (check && stale) { console.error('Run: cd scripts && npm run site-legal'); console.error('SITE-LEGAL FAIL'); process.exit(1); }
  console.log(`${names.length} legal page(s) ${check ? 'up to date' : 'built'}`);
  console.log(check ? 'SITE-LEGAL PASS' : 'SITE-LEGAL DONE');
}
