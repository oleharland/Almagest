/**
 * derived-index.mjs — emit brain/.index/.
 *
 * Committed, not gitignored: same idiom as the generated harness shims, and
 * verified in CI by `tools/audit.mjs --check-index`. That only works if the
 * bytes are deterministic, so: sorted by slug, tab-separated, `\n` endings, no
 * timestamps, no locale-dependent collation.
 *
 * Two files, because they answer two different questions in one grep:
 *   pages.tsv    — what is in this brain, one row per page
 *   aliases.tsv  — does this brain already know this name, under any spelling
 */
import fs from 'node:fs';
import path from 'node:path';

export const PAGES_HEADER = [
  'slug', 'title', 'type', 'tier', 'status', 'origin', 'confidence',
  'aliases', 'tags', 'source_ids', 'backlinks', 'last_verified',
];

export const ALIASES_HEADER = ['alias', 'slug'];

/** Tabs and newlines would break the format; a pipe would fake a second value. */
function cell(value) {
  return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
}

function multi(values) {
  return values.map((v) => cell(v).replace(/\|/g, '/')).filter(Boolean).join('|');
}

/** Byte-comparison, not locale collation — `localeCompare` is not portable. */
function byCodePoint(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function renderPagesTsv(pages) {
  const rows = pages
    .map((page) => [
      cell(page.id),
      cell(page.title),
      cell(page.type),
      cell(page.tier),
      cell(page.status),
      cell(page.origin),
      cell(page.confidence),
      multi(page.aliases),
      multi(page.tags),
      multi(page.sources.map((s) => s.id)),
      multi(page.backlinks.map((b) => b.id)),
      cell(page.lastVerified),
    ].join('\t'))
    .sort(byCodePoint);

  return [PAGES_HEADER.join('\t'), ...rows].join('\n') + '\n';
}

export function renderAliasesTsv(pages) {
  const seen = new Set();
  for (const page of pages) {
    for (const name of [page.title, ...page.aliases]) {
      const alias = cell(name).toLowerCase();
      if (!alias) continue;
      seen.add(`${alias}\t${cell(page.id)}`);
    }
  }
  const rows = [...seen].sort(byCodePoint);
  return [ALIASES_HEADER.join('\t'), ...rows].join('\n') + '\n';
}

export function indexFiles(pages) {
  return {
    'pages.tsv': renderPagesTsv(pages),
    'aliases.tsv': renderAliasesTsv(pages),
  };
}

/** Write only what changed — write-if-changed is non-negotiable #6. */
export function writeIndex(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    if (before === content) continue;
    fs.writeFileSync(file, content, 'utf-8');
    written.push(name);
  }
  return written;
}

/** What `--check-index` compares: current bytes on disk vs freshly rendered. */
export function diffIndex(dir, files) {
  const drift = [];
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      drift.push({ name, reason: 'missing' });
      continue;
    }
    const before = fs.readFileSync(file, 'utf-8');
    if (before !== content) drift.push({ name, reason: 'stale', before, after: content });
  }
  return drift;
}
