/**
 * wiki-core.mjs — the one implementation of the Almagest wiki loader.
 *
 * Plain ESM JavaScript on purpose. Two callers need it and they cannot share a
 * `.ts` file: the Astro site imports it through Vite, and `tools/audit.mjs`
 * imports it from bare Node 22, which will not load TypeScript. A second copy
 * of this parser would drift the first time either side was edited — the same
 * failure `tools/agent-shims.sh` exists to prevent — so the site's
 * `src/lib/wiki.ts` is a typed wrapper around this file and nothing more.
 *
 * Runs at build time only. Nothing here ships to the browser.
 *
 * Schema v2 lives here: `sources` is a list of {id, path, sha256, title}
 * objects, `origin` and `aliases` are base fields, and `relations` carries the
 * typed edges. The v1 string form of `sources` still parses — it is marked
 * `legacy` so the audit can flag it (CITE-002 / PROV-003) instead of crashing.
 *
 * It imports nothing but Node builtins, deliberately. `gray-matter` and
 * `marked` are injected by the caller (`matter` and `render` on loadWiki),
 * because this file sits above both package roots: a bare `import
 * 'gray-matter'` here resolves against the REPO root, so `cd site && npm
 * install && npm run build` would fail on a clone that had never run the root
 * install. Injection removes the ordering requirement entirely.
 */
import fs from 'node:fs';
import path from 'node:path';

// ── vocabulary ───────────────────────────────────────────────────────────────

/** Frontmatter keys defined by the base schema. Everything else is `extra`. */
export const BASE_KEYS = new Set([
  'title', 'type', 'tier', 'origin', 'status', 'confidence', 'tags', 'aliases',
  'owner', 'date_created', 'date_modified', 'last_verified', 'sources',
  'related', 'relations',
]);

/** Base fields that must be present and non-empty on every page (SCHEMA-001). */
export const REQUIRED_FIELDS = ['title', 'type', 'tier', 'origin', 'status', 'confidence'];

/** Closed enums the audit validates (SCHEMA-002). `type` comes from config. */
export const ENUMS = {
  tier: ['canonical', 'curated', 'evidence'],
  status: ['stub', 'draft', 'evergreen'],
  confidence: ['high', 'medium', 'low', 'unknown'],
  origin: ['source', 'self'],
};

/** The typed edges in `relations`. Order is the report order. */
export const RELATION_KEYS = ['supports', 'contradicts', 'supersedes', 'depends_on'];

/** Body sections exempt from the unsourced-claim check (CITE-003). */
export const EXEMPT_SECTIONS = new Set(['summary', 'open questions', 'basis']);

/**
 * Which brain directories to read.
 *
 * Single brain (the default):
 *   [{ name: 'brain', prefix: '', dir: 'brain/wiki' }]
 *
 * Multiple brains — give each one a `prefix` so `[[research:foo]]` resolves.
 * See docs/multi-brain.md.
 *   [
 *     { name: 'research', prefix: 'research', dir: 'research-brain/wiki' },
 *     { name: 'projects', prefix: 'projects', dir: 'projects-brain/wiki' },
 *   ]
 */
export const WIKI_DIRS = [
  { name: 'brain', prefix: '', dir: 'brain/wiki' },
];

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

// ── scalar coercion ──────────────────────────────────────────────────────────

export function asArray(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [String(v)].filter(Boolean);
}

export function asString(v) {
  return v == null ? '' : String(v);
}

/** `[[foo|bar]]` / `[[foo]]` / `foo` -> `foo`. Frontmatter targets only. */
export function stripBrackets(raw) {
  return String(raw).trim().replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].split('#')[0].trim();
}

// ── frontmatter normalisation ────────────────────────────────────────────────

/**
 * `sources` in either shape.
 *
 * v2: [{ id, path, sha256, title }]  — `legacy: false`
 * v1: ["raw/processed/foo.pdf"]      — `legacy: true`, no id, no digest
 */
export function normalizeSources(v) {
  if (v == null || v === '') return [];
  const list = Array.isArray(v) ? v : [v];
  const out = [];
  list.forEach((entry, index) => {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      out.push({
        index,
        id: asString(entry.id).trim(),
        path: asString(entry.path).trim(),
        sha256: asString(entry.sha256).trim().toLowerCase(),
        title: asString(entry.title).trim(),
        legacy: false,
      });
      return;
    }
    const raw = asString(entry).trim();
    if (!raw) return;
    out.push({ index, id: '', path: raw, sha256: '', title: '', legacy: true });
  });
  return out;
}

/** `relations` -> a full record of the four typed edges, plus any stray keys. */
export function normalizeRelations(v) {
  const relations = {};
  for (const key of RELATION_KEYS) relations[key] = [];
  let unknownKeys = [];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [key, value] of Object.entries(v)) {
      if (RELATION_KEYS.includes(key)) relations[key] = asArray(value).map(stripBrackets).filter(Boolean);
      else unknownKeys.push(key);
    }
  }
  return { relations, unknownKeys };
}

// ── body parsing ─────────────────────────────────────────────────────────────

/**
 * Split a page body into blocks, tagged with the `##` section they sit under.
 *
 * A block is a paragraph or a list item — the two shapes a claim takes. Tables,
 * blockquotes, headings, fenced code and horizontal rules are deliberately not
 * blocks: a table carries its citation in a Source column, and a blockquote is
 * a disputed-marker, not an assertion of the page's own.
 */
export function parseBody(body) {
  const lines = String(body).split('\n');
  const blocks = [];
  let section = '';
  let fence = '';
  let cur = null;

  const flush = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();

    const fenceMatch = text.match(/^(```|~~~)/);
    if (fenceMatch) {
      flush();
      if (!fence) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = '';
      continue;
    }
    if (fence) continue;

    if (text === '') { flush(); continue; }

    const heading = text.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      if (heading[1].length <= 2) section = heading[2].replace(/\s*#+\s*$/, '').trim();
      continue;
    }

    // Table rows, blockquotes and rules carry their provenance differently.
    if (text.startsWith('|') || text.startsWith('>')) { flush(); continue; }
    if (/^([-*_])\1{2,}$/.test(text.replace(/\s+/g, ''))) { flush(); continue; }

    const bullet = text.match(/^([-*+]|\d+[.)])\s+/);
    if (bullet) {
      flush();
      cur = { kind: 'list-item', section, text: text.slice(bullet[0].length), line: i + 1 };
      continue;
    }

    if (cur) { cur.text += '\n' + text; continue; }
    cur = { kind: 'paragraph', section, text, line: i + 1 };
  }
  flush();
  return blocks;
}

/** Every `##` heading on the page, in document order. */
export function sectionNames(body) {
  const out = [];
  let fence = '';
  for (const line of String(body).split('\n')) {
    const text = line.trim();
    const fenceMatch = text.match(/^(```|~~~)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = '';
      continue;
    }
    if (fence) continue;
    const heading = text.match(/^##\s+(.*)$/);
    if (heading) out.push(heading[1].replace(/\s*#+\s*$/, '').trim());
  }
  return out;
}

/** Lines belonging to a named `##` section, exclusive of the heading itself. */
export function sectionLines(body, name) {
  const want = name.trim().toLowerCase();
  const lines = String(body).split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    const heading = line.trim().match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      if (heading[1].length <= 2) {
        inside = heading[2].replace(/\s*#+\s*$/, '').trim().toLowerCase() === want;
        continue;
      }
      if (inside) { out.push(line); continue; }
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

// ── citations ────────────────────────────────────────────────────────────────

const CITATION_RE = /\[source:([^\]]*)\]/g;
const SOURCE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LOCATOR_RE = /^(?:§\S.*|p\.\d+|pp\.\d+-\d+|row \d+|slide \d+|t \d{1,2}:\d{2}:\d{2}|line \d+)$/;

/** The frozen grammar, applied to the text between `[source:` and `]`. */
export function parseCitation(inner) {
  const s = String(inner).trim();
  if (s === 'unknown') return { ok: true, id: 'unknown', locator: '', date: '' };
  if (s === '') return { ok: false, id: '', reason: 'empty citation' };

  const comma = s.indexOf(',');
  if (comma < 0) {
    return { ok: false, id: s, reason: 'expected `[source: <id>, <locator>]` — no locator found' };
  }
  const id = s.slice(0, comma).trim();
  let rest = s.slice(comma + 1).trim();
  let date = '';

  const dated = rest.match(/,\s*\((\d{4}-\d{2}-\d{2})\)$/);
  if (dated) {
    date = dated[1];
    rest = rest.slice(0, dated.index).trim();
  }

  if (!SOURCE_ID_RE.test(id)) {
    return { ok: false, id, reason: `\`${id}\` is not a kebab-case source id` };
  }
  if (!LOCATOR_RE.test(rest)) {
    return {
      ok: false,
      id,
      reason: `\`${rest}\` is not a locator (§section · p.N · pp.N-M · row N · slide N · t hh:mm:ss · line N)`,
    };
  }
  return { ok: true, id, locator: rest, date };
}

/** Every `[source: …]` on the page, parsed, with its 1-based line number. */
export function findCitations(body) {
  const text = String(body);
  const out = [];
  CITATION_RE.lastIndex = 0;
  let m;
  while ((m = CITATION_RE.exec(text)) !== null) {
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ raw: m[0], line, ...parseCitation(m[1]) });
  }
  return out;
}

// ── loading ──────────────────────────────────────────────────────────────────

function readRawPages({ repoRoot, wikiDirs, showExamplePages, onWarn, matter }) {
  const out = [];

  for (const brain of wikiDirs) {
    const dir = path.resolve(repoRoot, brain.dir);
    if (!fs.existsSync(dir)) {
      onWarn(`[wiki] brain directory not found, skipping: ${brain.dir}`);
      continue;
    }

    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.md')) continue;
      if (file.startsWith('.')) continue;

      const slug = file.slice(0, -3);
      if (slug.startsWith('_') && !showExamplePages) continue;

      const abs = path.join(dir, file);
      const source = fs.readFileSync(abs, 'utf-8');
      let parsed;
      try {
        parsed = matter(source);
      } catch (err) {
        throw new Error(
          `[wiki] could not parse frontmatter in ${brain.dir}/${file}. ` +
            `Frontmatter must be the very first thing in the file — no blank lines ` +
            `or comments above the opening '---'.\n${err.message}`
        );
      }

      out.push({
        id: brain.prefix ? `${brain.prefix}:${slug}` : slug,
        slug,
        brain: brain.name,
        prefix: brain.prefix,
        file: abs,
        relFile: path.relative(repoRoot, abs),
        data: parsed.data || {},
        body: parsed.content,
      });
    }
  }

  return out;
}

/** Normalise a wikilink target into a page id. `[[foo]]` in brain 'x' -> 'foo' or 'x:foo'. */
export function resolveTarget(raw, fromBrainPrefix, known) {
  const target = String(raw).trim();
  if (!target) return null;

  // Explicit cross-brain link: [[projects:retrieval-pipeline]]
  if (target.includes(':')) {
    return known.has(target) ? target : null;
  }
  // Same-brain first, then any brain (unprefixed link in a multi-brain setup).
  const local = fromBrainPrefix ? `${fromBrainPrefix}:${target}` : target;
  if (known.has(local)) return local;
  if (known.has(target)) return target;
  for (const id of known) {
    if (id.endsWith(`:${target}`)) return id;
  }
  return null;
}

/** URL path for a page id. */
export function hrefFor(id) {
  return '/' + String(id).replace(':', '/') + '/';
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Load every wiki page, resolve wikilinks, invert the link graph.
 *
 * @param {object} options
 * @param {string} options.repoRoot          repo root; `dir` entries resolve against it
 * @param {Function} options.matter          gray-matter, injected by the caller
 * @param {Array}  [options.wikiDirs]        defaults to WIKI_DIRS
 * @param {boolean}[options.showExamplePages] include `_`-prefixed slugs
 * @param {Function}[options.render]         markdown -> html. Omit to skip rendering.
 * @param {Function}[options.onWarn]
 * @returns {{ pages: Array, byId: Map, known: Set<string> }}
 */
export function loadWiki(options) {
  const {
    repoRoot,
    matter,
    wikiDirs = WIKI_DIRS,
    showExamplePages = true,
    render = null,
    onWarn = (msg) => console.warn(msg),
  } = options;

  if (typeof matter !== 'function') {
    throw new Error('[wiki] loadWiki needs `matter` — pass gray-matter from the calling package');
  }

  const raw = readRawPages({ repoRoot, wikiDirs, showExamplePages, onWarn, matter });
  const known = new Set(raw.map((p) => p.id));
  const backlinks = new Map();

  const pages = raw.map((p) => {
    const links = [];
    const brokenLinks = [];

    // Rewrite wikilinks into markdown links before rendering.
    const withLinks = p.body.replace(WIKILINK, (_m, target, label) => {
      const text = String(label ?? target).trim();
      const resolved = resolveTarget(target, p.prefix, known);
      if (!resolved) {
        const name = String(target).trim();
        if (!brokenLinks.includes(name)) brokenLinks.push(name);
        return `<span class="wikilink is-broken" title="No page named &quot;${escapeAttr(name)}&quot;">${text}</span>`;
      }
      if (!links.includes(resolved)) links.push(resolved);
      return `<a class="wikilink" href="${hrefFor(resolved)}">${text}</a>`;
    });

    const title = asString(p.data.title) || p.slug;
    const extra = {};
    for (const [k, v] of Object.entries(p.data)) {
      if (!BASE_KEYS.has(k)) extra[k] = v;
    }

    const sources = normalizeSources(p.data.sources);
    const { relations, unknownKeys } = normalizeRelations(p.data.relations);

    return {
      slug: p.slug,
      id: p.id,
      brain: p.brain,
      prefix: p.prefix,
      file: p.file,
      relFile: p.relFile,
      title,
      type: asString(p.data.type) || 'untyped',
      tier: asString(p.data.tier) || 'curated',
      origin: asString(p.data.origin) || 'source',
      tags: asArray(p.data.tags),
      aliases: asArray(p.data.aliases),
      status: asString(p.data.status),
      confidence: asString(p.data.confidence),
      owner: asString(p.data.owner),
      dateCreated: asString(p.data.date_created),
      dateModified: asString(p.data.date_modified),
      lastVerified: asString(p.data.last_verified),
      sources,
      sourcePaths: sources.map((s) => s.path).filter(Boolean),
      related: asArray(p.data.related).map(stripBrackets).filter(Boolean),
      relations,
      unknownRelationKeys: unknownKeys,
      extra,
      /** Raw frontmatter, so the audit can tell "absent" from "empty". */
      raw: p.data,
      body: p.body,
      html: render ? render(withLinks) : '',
      links,
      brokenLinks,
      backlinks: [],
    };
  });

  // Second pass: invert the link graph.
  for (const page of pages) {
    for (const target of page.links) {
      if (!backlinks.has(target)) backlinks.set(target, []);
      backlinks.get(target).push({ id: page.id, title: page.title });
    }
  }
  for (const page of pages) {
    page.backlinks = (backlinks.get(page.id) ?? []).sort((a, b) => a.title.localeCompare(b.title));
  }

  pages.sort((a, b) => a.title.localeCompare(b.title));
  return { pages, byId: new Map(pages.map((p) => [p.id, p])), known };
}

// ── presentation helpers (shared with the site) ──────────────────────────────

/** Group pages by a frontmatter field, sorted with the largest group first. */
export function groupPages(pages, key) {
  const groups = new Map();
  for (const page of pages) {
    const name = page[key] || 'untyped';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(page);
  }
  return [...groups.entries()]
    .map(([name, ps]) => ({ name, pages: ps }))
    .sort((a, b) => b.pages.length - a.pages.length || a.name.localeCompare(b.name));
}

export function allTags(pages) {
  const counts = new Map();
  for (const p of pages) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
