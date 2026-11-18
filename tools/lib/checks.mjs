/**
 * checks.mjs — every audit check, one function per ID family.
 *
 * The IDs are frozen: `agent/rules/wiki.md`, `docs/audit.md` and
 * `brain.config.yaml` → `audit.severity` all name them, so a check may change
 * its message but never its ID.
 *
 * Every check is a pure function of (pages, config, manifest, index) and
 * returns findings. Nothing here writes to disk — the audit reports, it does
 * not fix.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ENUMS,
  EXEMPT_SECTIONS,
  REQUIRED_FIELDS,
  RELATION_KEYS,
  findCitations,
  parseBody,
  resolveTarget,
  sectionLines,
  sectionNames,
} from './wiki-core.mjs';
import YAML from 'yaml';
import { canonicalSetOfPages, frontmatterBlock } from './canonical.mjs';

/** Categories drive the report layout and the emoji key in agent/rules/wiki.md. */
export const CATEGORIES = [
  { key: 'schema', emoji: '📋', label: 'Schema', prefixes: ['SCHEMA-'] },
  { key: 'links', emoji: '🔗', label: 'Broken links', ids: ['LINK-001', 'LINK-003'] },
  { key: 'orphans', emoji: '👻', label: 'Orphans', ids: ['LINK-002'] },
  { key: 'citations', emoji: '📎', label: 'Citations', prefixes: ['CITE-'] },
  { key: 'provenance', emoji: '🧾', label: 'Provenance', prefixes: ['PROV-'] },
  { key: 'canonical', emoji: '🛡️', label: 'Canonical', ids: ['CANON-'] },
  { key: 'stale', emoji: '🕸️', label: 'Stale', ids: ['STALE-', 'BASIS-'] },
  { key: 'duplicates', emoji: '👯', label: 'Duplicates', ids: ['DUP-'] },
];

export function categoryOf(id) {
  for (const c of CATEGORIES) {
    if (c.ids && c.ids.some((x) => id.startsWith(x))) return c;
    if (c.prefixes && c.prefixes.some((x) => id.startsWith(x))) return c;
  }
  return CATEGORIES[0];
}

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Fallback severities, used only for an ID `brain.config.yaml` →
 * `audit.severity` does not name. Config wins; this exists so a check still has
 * a defined severity on a config that predates it.
 */
const DEFAULT_SEVERITY = {
  'LINK-002': 'warning',
  'PROV-005': 'warning',
  'CANON-001': 'warning',
  'STALE-001': 'warning',
  'DUP-001': 'warning',
  'BASIS-001': 'warning',
};

/**
 * Shipped template pages (`_`-prefixed slugs) cannot satisfy the provenance
 * checks: their sources are placeholders and no manifest entry describes them.
 * Exempting them is what stops a fresh fork failing CI on day one. The
 * exemption is narrow — PROV-001, PROV-003 and CITE-005 only — and named in
 * the report footer, never silent.
 */
export const PROVENANCE_EXEMPT_CHECKS = new Set(['PROV-001', 'PROV-003', 'CITE-005']);

export function isTemplatePage(page) {
  return page.slug.startsWith('_');
}

class Findings {
  constructor(config) {
    this.config = config;
    this.list = [];
  }

  add(id, message, opts = {}) {
    // `opts.severity` is the only per-finding override, and it exists for two
    // cases of one fact: PROV-001 on an `extracted: none` source or an
    // ephemeral connector snapshot, where the file is legitimately absent from
    // a fresh clone. See checkProvenance.
    const severity = opts.severity
      ? opts.severity
      : this.config.severityWarnings.has(id)
        ? 'warning'
        : this.config.severityErrors.has(id)
          ? 'error'
          : (DEFAULT_SEVERITY[id] ?? 'error');
    this.list.push({
      id,
      severity,
      page: opts.page ?? null,
      file: opts.file ?? null,
      line: opts.line ?? null,
      count: opts.count ?? 1,
      message,
      hint: opts.hint ?? null,
    });
  }
}

// ── SCHEMA ───────────────────────────────────────────────────────────────────

// ── front matter indirection (SCHEMA-006) and an open body (SCHEMA-007) ───────

const BLOCK_SCALAR = /(?:^|[\s:-])[|>][1-9+-]{0,2}\s*$/;

/**
 * Anchors (`&name`), aliases (`*name`) and merge keys (`<<:`) in a page's front
 * matter, as short descriptions. A page header has no need for them, and they
 * let a value depend on another line (`tier: *t` reads whatever `&t` marked).
 *
 * Decided from the parsed YAML document: an anchor on any node, an alias node,
 * a plain `<<` key. A `*` or `&` that starts a continuation line of a plain
 * scalar, or sits in a quoted string, a comment or a block scalar, is text and
 * is never a finding, because it is not a node. Only a header that does not
 * parse falls back to a scan of the raw text (the page fails another check
 * anyway, and the scan keeps a broken header from hiding an alias).
 * Returns [] for a page with no front matter.
 */
export function frontmatterIndirection(text) {
  const block = frontmatterBlock(text);
  if (block === null) return [];
  const found = [];
  const note = (what, line) => {
    const msg = line ? `${what} on line ${line} of the front matter` : `${what} in the front matter`;
    if (!found.includes(msg)) found.push(msg);
  };

  let doc = null;
  try {
    const lineCounter = new YAML.LineCounter();
    doc = YAML.parseDocument(block, { merge: false, lineCounter });
    const lineOf = (node) => (node?.range ? lineCounter.linePos(node.range[0]).line : 0);
    YAML.visit(doc, {
      Alias(_key, node) { note(`an alias (*${node.source})`, lineOf(node)); },
      Node(_key, node) { if (node.anchor) note(`an anchor (&${node.anchor})`, lineOf(node)); },
      Pair(_key, pair) { if (YAML.isScalar(pair.key) && pair.key.value === '<<' && pair.key.type === 'PLAIN') note('a merge key (<<)', lineOf(pair.key)); },
    });
  } catch { doc = null; }
  if (doc && doc.errors.length === 0) return found;

  // The header does not parse as YAML: read the raw text so nothing hides in it.
  rawIndirection(block, note);
  return found;
}

/** The line-by-line reading, for a header that does not parse. Quoted strings, comments and block scalars are skipped. */
function rawIndirection(block, note) {
  let quote = null;          // '"' | "'" | null, carried across lines
  let blockIndent = null;    // indent of the line that opened a block scalar
  block.split('\n').forEach((raw, n) => {
    const line = raw.replace(/\r$/, '');
    const indent = line.length - line.trimStart().length;
    if (blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) return;
      blockIndent = null;
    }
    let sig = '';            // the last non-space character seen on this line outside quotes
    let gap = true;          // whitespace since `sig` (true at the start of a line)
    let token = '';          // the whitespace-delimited token being read
    let prevToken = '';
    let content = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        if (quote === '"' && c === '\\') { i++; continue; }
        if (c === quote) {
          if (quote === "'" && line[i + 1] === "'") { i++; continue; }
          quote = null;
        }
        continue;
      }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
      if (/\s/.test(c)) { if (token) prevToken = token; token = ''; gap = true; continue; }
      const start = sig === '' || (gap && (sig === '-' || sig === ':' || sig === '?')) || sig === '[' || sig === '{' || sig === ','
        || (gap && prevToken.startsWith('!') && token === '');
      if (start && (c === '&' || c === '*') && /[^\s,[\]{}]/.test(line[i + 1] || '')) {
        note(c === '&' ? `an anchor (${line.slice(i).match(/^&[^\s,[\]{}]*/)[0]})` : `an alias (${line.slice(i).match(/^\*[^\s,[\]{}]*/)[0]})`, n + 1);
      }
      if (start && c === '<' && /^<<\s*:(\s|$)/.test(line.slice(i))) note('a merge key (<<)', n + 1);
      if ((c === '"' || c === "'") && (start || sig === '')) quote = c;
      else if ((c === '"' || c === "'") && token === '') quote = c;
      token += c;
      sig = c;
      gap = false;
      content += c;
    }
    if (!quote && BLOCK_SCALAR.test(content)) blockIndent = indent;
  });
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Does a line start a block that interrupts a paragraph (so no code span crosses into it)? */
function interruptsParagraph(line) {
  if (line.trim() === '') return true;
  const open = FENCE_OPEN.exec(line);
  if (open && !(open[1][0] === '`' && open[2].includes('`'))) return true;
  return /^ {0,3}<!--/.test(line) || /^ {0,3}#{1,6}(\s|$)/.test(line);
}

/** Where a run of exactly `n` backticks starts in `line` at or after `from`, or -1. */
function findBacktickRun(line, n, from) {
  for (let i = from; i < line.length; i++) {
    if (line[i] !== '`') continue;
    let j = i;
    while (line[j] === '`') j++;
    if (j - i === n) return i;
    i = j - 1;
  }
  return -1;
}

/**
 * Does a page body end inside an HTML comment (`<!--` with no `-->` after it)
 * or inside a fenced code block? Returns 'comment', 'fence' or null. Either one
 * would swallow whatever is added below the page's last section later.
 *
 * Fences follow CommonMark: three or more backticks or tildes, indented up to
 * three spaces, a backtick fence's info string holding no backtick; one closes
 * only with the same character, at least as long, up to three spaces of indent,
 * and nothing after it but spaces. Indented code is not a fence.
 *
 * Inline code follows CommonMark too: a run of backticks closes with the next
 * run of the same length, and the span may cross a line break but not a blank
 * line (nor a line that starts a fence, a comment or a heading). A `<!--` inside
 * a span is code. A run with no closer is literal. A comment marker inside a
 * fence (or a fence marker inside a comment) means nothing.
 */
export function bodyEndsOpen(body) {
  const lines = String(body ?? '').replace(/\r/g, '').split('\n');
  let fence = null;
  let comment = false;
  let at = 0;          // line index
  let col = 0;         // column in lines[at]
  while (at < lines.length) {
    const line = lines[at];
    if (col === 0) {
      if (fence) {
        const close = FENCE_CLOSE.exec(line);
        if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
        at++;
        continue;
      }
      if (!comment) {
        const open = FENCE_OPEN.exec(line);
        if (open && !(open[1][0] === '`' && open[2].includes('`'))) {
          fence = { ch: open[1][0], len: open[1].length };
          at++;
          continue;
        }
      }
    }
    if (comment) {
      const end = line.indexOf('-->', col);
      if (end === -1) { at++; col = 0; continue; }
      comment = false;
      col = end + 3;
      continue;
    }
    const tick = line.indexOf('`', col);
    const start = line.indexOf('<!--', col);
    if (tick === -1 && start === -1) { at++; col = 0; continue; }
    if (start !== -1 && (tick === -1 || start < tick)) {
      const end = line.indexOf('-->', start + 2);
      if (end === -1) { comment = true; at++; col = 0; continue; }
      col = end + 3;
      continue;
    }
    let run = tick;
    while (line[run] === '`') run++;
    const n = run - tick;
    // The closing run: on this line, or on a later line of the same paragraph.
    let closeAt = findBacktickRun(line, n, run);
    let closeLine = at;
    for (let k = at + 1; closeAt === -1 && k < lines.length && !interruptsParagraph(lines[k]); k++) {
      closeAt = findBacktickRun(lines[k], n, 0);
      closeLine = k;
    }
    if (closeAt === -1) { col = run; continue; }   // no closer: the backticks are literal text
    at = closeLine;
    col = closeAt + n;
  }
  return fence ? 'fence' : comment ? 'comment' : null;
}

function buildTypeVocabulary(pages, config) {
  const vocab = new Set(config.typeVocabulary);
  const fieldNames = new Set();
  for (const spec of Object.values(config.typeFields)) {
    for (const field of spec.fields) fieldNames.add(field);
  }
  for (const page of pages) {
    for (const field of fieldNames) {
      const value = page.raw?.[field];
      if (typeof value !== 'string') continue;
      const normalized = value.trim().toLowerCase();
      if (/^[a-z][a-z0-9-]*$/.test(normalized)) vocab.add(normalized);
    }
  }
  // A real page type is never a vocabulary value, whatever the comments say.
  for (const type of config.pageTypes) vocab.delete(type);
  return vocab;
}

function checkSchema(pages, config, out) {
  const vocab = buildTypeVocabulary(pages, config);

  for (const page of pages) {
    const where = { page: page.id, file: page.relFile };
    const fm = page.raw || {};

    // SCHEMA-001 — required base fields.
    for (const field of REQUIRED_FIELDS) {
      const value = fm[field];
      const missing = value == null || (typeof value === 'string' && value.trim() === '');
      if (missing) {
        out.add('SCHEMA-001', `missing required field \`${field}\``, {
          ...where,
          hint: field === 'origin' ? 'add `origin: source` (or `self` for your own conclusions)' : null,
        });
      }
    }

    // SCHEMA-001 — required keys inside each `sources[]` entry.
    page.sources.forEach((source, i) => {
      if (source.legacy) {
        out.add(
          'SCHEMA-001',
          `\`sources[${i}]\` uses the retired v1 string form (\`${source.path}\`)`,
          { ...where, hint: 'rewrite as `{ id, path, sha256 }` — citations cannot be checked without an id' }
        );
        return;
      }
      for (const key of ['id', 'path', 'sha256']) {
        if (!source[key]) out.add('SCHEMA-001', `\`sources[${i}]\` is missing \`${key}\``, where);
      }
      if (source.sha256 && !/^[0-9a-f]{64}$/.test(source.sha256)) {
        out.add('SCHEMA-002', `\`sources[${i}].sha256\` is not 64 hex characters`, where);
      }
    });

    const seenIds = new Set();
    for (const source of page.sources) {
      if (!source.id) continue;
      if (seenIds.has(source.id)) {
        out.add('SCHEMA-002', `duplicate source id \`${source.id}\` — ids must be unique within the page`, where);
      }
      seenIds.add(source.id);
    }

    // SCHEMA-002 / SCHEMA-005 — enums.
    const type = String(fm.type ?? '').trim();
    if (type) {
      if (!config.pageTypes.includes(type)) {
        if (vocab.has(type.toLowerCase())) {
          out.add('SCHEMA-005', `\`type: ${type}\` is a type_fields vocabulary value, not a page type`, {
            ...where,
            hint: `page types are: ${config.pageTypes.join(' · ')}`,
          });
        } else {
          out.add('SCHEMA-002', `\`type: ${type}\` is not in \`page_types\``, {
            ...where,
            hint: `page types are: ${config.pageTypes.join(' · ')}`,
          });
        }
      }
    }
    for (const [field, allowed] of Object.entries(ENUMS)) {
      const value = String(fm[field] ?? '').trim();
      if (!value) continue;
      if (!allowed.includes(value)) {
        out.add('SCHEMA-002', `\`${field}: ${value}\` is not one of ${allowed.join(' | ')}`, where);
      }
    }
    for (const key of page.unknownRelationKeys) {
      out.add('SCHEMA-002', `\`relations.${key}\` is not a relation type`, {
        ...where,
        hint: `relations are: ${RELATION_KEYS.join(' · ')}`,
      });
    }

    // SCHEMA-003 — type_fields, both frontmatter keys and required sections.
    const spec = config.typeFields[type];
    if (spec) {
      for (const field of spec.fields) {
        const value = fm[field];
        const missing =
          value == null ||
          (typeof value === 'string' && value.trim() === '') ||
          (Array.isArray(value) && value.length === 0);
        if (missing) {
          out.add('SCHEMA-003', `\`type: ${type}\` requires field \`${field}\``, where);
        }
      }
      const headings = sectionNames(page.body).map((h) => h.toLowerCase());
      for (const section of spec.sections) {
        if (!headings.includes(section.toLowerCase())) {
          out.add('SCHEMA-003', `\`type: ${type}\` requires a \`## ${section}\` section`, where);
        }
      }
    }

    // SCHEMA-006 — no anchors, aliases or merge keys in the front matter.
    if (page.file) {
      let source = null;
      try { source = fs.readFileSync(page.file, 'utf-8'); } catch { /* unreadable: nothing to scan */ }
      const found = source === null ? [] : frontmatterIndirection(source);
      if (found.length) {
        out.add('SCHEMA-006', `the front matter uses YAML anchors, aliases or merge keys (${found.slice(0, 3).join('; ')}${found.length > 3 ? `; and ${found.length - 3} more` : ''}) — a header has no need for them, and they let a value depend on another line`, {
          ...where,
          hint: 'write each value out in full',
        });
      }
    }

    // SCHEMA-007 — the body must not end inside an HTML comment or a code fence.
    {
      const open = bodyEndsOpen(page.body);
      if (open) {
        out.add('SCHEMA-007', `the page ends inside ${open === 'comment' ? 'an HTML comment that is never closed (`<!--` with no `-->`)' : 'a fenced code block that is never closed'} — it would swallow whatever is added below it later`, {
          ...where,
          hint: open === 'comment' ? 'close the comment with `-->`' : 'close the fence with a line of the same character, at least as long',
        });
      }
    }

    // SCHEMA-004 — ownership.
    if (config.requireOwner) {
      if (!page.owner) {
        out.add('SCHEMA-004', 'missing `owner` while `require_owner: true`', {
          ...where,
          hint: `owner_teams: ${config.ownerTeams.join(' · ')}`,
        });
      } else if (!config.ownerTeams.includes(page.owner)) {
        out.add('SCHEMA-004', `\`owner: ${page.owner}\` is not in \`owner_teams\``, {
          ...where,
          hint: `owner_teams: ${config.ownerTeams.join(' · ')}`,
        });
      }
    }
  }
}

// ── LINK ─────────────────────────────────────────────────────────────────────

function checkLinks(pages, known, config, out) {
  // Inbound references of every kind — body wikilinks, `related`, `relations`.
  // An orphan is a page nothing points at, not a page nothing links from prose.
  const inbound = new Map();
  const note = (target) => inbound.set(target, (inbound.get(target) ?? 0) + 1);
  // The one definition: the config list plus every page whose tier says canonical.
  const canonical = canonicalSetOfPages(pages, config.canonicalPages);

  for (const page of pages) {
    for (const target of page.links) note(target);
    for (const raw of page.related) {
      const resolved = resolveTarget(raw, page.prefix, known);
      if (resolved && resolved !== page.id) note(resolved);
    }
    for (const key of RELATION_KEYS) {
      for (const raw of page.relations[key]) {
        const resolved = resolveTarget(raw, page.prefix, known);
        if (resolved && resolved !== page.id) note(resolved);
      }
    }
  }

  for (const page of pages) {
    const where = { page: page.id, file: page.relFile };

    for (const broken of page.brokenLinks) {
      out.add('LINK-001', `links to [[${broken}]] — page does not exist`, {
        ...where,
        hint: 'create a stub or fix the link',
      });
    }

    for (const key of RELATION_KEYS) {
      for (const raw of page.relations[key]) {
        if (!resolveTarget(raw, page.prefix, known)) {
          out.add('LINK-003', `\`relations.${key}\` names [[${raw}]] — page does not exist`, where);
        }
      }
    }

    if ((inbound.get(page.id) ?? 0) === 0 && !canonical.has(page.slug)) {
      out.add('LINK-002', '0 backlinks', {
        ...where,
        hint: 'link it from a related page or archive it',
      });
    }
  }
}

// ── CITE ─────────────────────────────────────────────────────────────────────

/**
 * A `kind: connector` snapshot's digest as it sits on disk, or '' when the
 * file is absent. Memoised per run — many pages cite one snapshot.
 */
function snapshotDigest(repoRoot, rel, cache) {
  if (cache.has(rel)) return cache.get(rel);
  const file = path.resolve(repoRoot, rel);
  const digest = fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : '';
  cache.set(rel, digest);
  return digest;
}

function checkCitations(pages, config, manifest, repoRoot, out) {
  const digests = new Map();
  for (const page of pages) {
    const where = { page: page.id, file: page.relFile };
    const ids = new Set(page.sources.map((s) => s.id).filter(Boolean));

    // CITE-001 / CITE-002 — the frozen grammar, then the id.
    const seen = new Map();
    for (const citation of findCitations(page.body)) {
      const key = `${citation.ok ? 'ok' : 'bad'}::${citation.raw}`;
      if (seen.has(key)) { seen.get(key).count++; continue; }
      seen.set(key, { citation, count: 1 });
    }
    for (const { citation, count } of seen.values()) {
      if (!citation.ok) {
        out.add('CITE-001', `\`${citation.raw}\` — ${citation.reason}`, {
          ...where,
          line: citation.line,
          count,
          hint: '`[source: <id>, <locator>]` — the prose form is retired; the label lives in `sources[].title`',
        });
        continue;
      }
      if (citation.id !== 'unknown' && !ids.has(citation.id)) {
        out.add('CITE-002', `citation id \`${citation.id}\` is not in this page's \`sources\``, {
          ...where,
          line: citation.line,
          count,
          hint: ids.size ? `known ids: ${[...ids].join(' · ')}` : 'this page declares no source ids',
        });
      }
    }

    // CITE-004 — an origin: source page with nothing behind it.
    if (page.origin === 'source' && page.sources.length === 0) {
      out.add('CITE-004', '`origin: source` but `sources` is empty', where);
    }

    // CITE-003 — a body claim with no citation at all.
    if (page.origin === 'source') {
      for (const block of parseBody(page.body)) {
        if (EXEMPT_SECTIONS.has(block.section.trim().toLowerCase())) continue;
        if (block.text.includes('[source:')) continue;
        if (!/[a-z]/i.test(block.text)) continue;
        out.add('CITE-003', `unsourced ${block.kind}: "${excerpt(block.text)}"`, {
          ...where,
          line: block.line,
          hint: block.section ? `in \`## ${block.section}\`` : 'before the first section heading',
        });
      }
    }

    // CITE-006 — an origin: self page must show its working.
    if (page.origin === 'self') {
      const headings = sectionNames(page.body).map((h) => h.toLowerCase());
      if (!headings.includes('basis')) {
        out.add('CITE-006', '`origin: self` but there is no `## Basis` section', {
          ...where,
          hint: 'list the `origin: source` pages this rests on as [[wikilinks]]',
        });
      } else {
        const bullets = sectionLines(page.body, 'Basis')
          .map((l) => l.trim())
          .filter((l) => /^([-*+]|\d+[.)])\s+/.test(l));
        if (bullets.length === 0) {
          out.add('CITE-006', '`## Basis` has no bullets', where);
        }
        for (const bullet of bullets) {
          const text = bullet.replace(/^([-*+]|\d+[.)])\s+/, '').trim();
          if (!/^\[\[[^\]]+\]\]/.test(text)) {
            out.add('CITE-006', `\`## Basis\` bullet is not a wikilink: "${excerpt(text)}"`, where);
          }
        }
      }
    }

    // CITE-005 — the page's digest against the manifest's.
    //
    // For a binary source the page cites the committed sidecar, so the digest
    // to compare is `extracted_sha256`, not the original's `sha256`. Text
    // sources have no sidecar and fall back to `sha256`.
    if (!isTemplatePage(page)) {
      for (const source of page.sources) {
        if (source.legacy || !source.sha256) continue;
        const entry =
          (source.id && manifest.byId.get(source.id)) ||
          (source.path && manifest.byPath.get(source.path)) ||
          null;
        if (!entry) continue;
        const expected = entry.extractedSha256 || entry.sha256;

        // A connector snapshot was fingerprinted by the service, not by
        // whoever committed it. If the committed bytes no longer hash to that
        // digest, the file was edited after capture — and every citation into
        // it points at text the source never said. The page/manifest
        // comparison below cannot see this: both would still agree.
        if (entry.kind === 'connector' && expected && entry.extracted && entry.snapshot !== 'ephemeral') {
          const onDisk = snapshotDigest(repoRoot, entry.extracted, digests);
          if (onDisk && onDisk !== expected) {
            out.add(
              'CITE-005',
              `connector snapshot \`${entry.extracted}\` hashes to ${short(onDisk)}, but the service fingerprinted it as ${short(expected)}`,
              { ...where, hint: 'the snapshot was edited after it was captured — restore it, or re-sync the connector and re-ingest' }
            );
          }
        }

        if (!expected || expected === source.sha256) continue;
        out.add(
          'CITE-005',
          `\`${source.id || source.path}\` sha256 ${short(source.sha256)} disagrees with manifest ${short(expected)}`,
          { ...where, hint: 'the source changed after this page was written — re-ingest before trusting its citations' }
        );
      }
    }
  }
}

function excerpt(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > 72 ? flat.slice(0, 71) + '…' : flat;
}

function short(digest) {
  return String(digest).slice(0, 8);
}

// ── PROV ─────────────────────────────────────────────────────────────────────

/**
 * A remote source path: `<provider>:<owner>/<repo>/<path>@<sha>`.
 *
 * Nothing is downloaded for a remote ingest — that is the design — so the path
 * never exists on disk and PROV-001 cannot check it. What IS checkable is that
 * it parses, and that the manifest holds the same commit; both are done below.
 */
const REMOTE_PATH_RE = /^(github|gitlab):([^/\s:@]+\/[^/\s:@]+)\/(.+?)@([0-9a-f]{7,40})$/;

function parseRemotePath(value) {
  const m = REMOTE_PATH_RE.exec(String(value).trim());
  if (!m) return null;
  return { provider: m[1], repo: m[2], path: m[3], commit: m[4] };
}

/** Something spelled like a remote path, whether or not it actually parses. */
function looksRemote(value) {
  return /^(github|gitlab):/.test(String(value).trim());
}

function checkProvenance(pages, config, manifest, index, repoRoot, out) {
  const brainDir = path.resolve(repoRoot, config.brainDir);

  for (const page of pages) {
    const where = { page: page.id, file: page.relFile };
    if (isTemplatePage(page)) continue;

    for (const source of page.sources) {
      if (!source.path) continue;

      const entry =
        (source.id && manifest.byId.get(source.id)) ||
        (source.path && manifest.byPath.get(source.path)) ||
        null;

      const remote = parseRemotePath(source.path);
      if (remote || looksRemote(source.path)) {
        // A remote source is never on disk. PROV-001 becomes two checks it can
        // actually make: the path parses, and the manifest agrees on the commit.
        if (!remote) {
          out.add('PROV-001', `\`${source.path}\` does not parse as \`<provider>:<owner>/<repo>/<path>@<commit>\``, where);
        } else if (entry && entry.commit && !entry.commit.startsWith(remote.commit)) {
          out.add('PROV-003', `\`${source.id || source.path}\` cites commit ${remote.commit} — the manifest is at ${short(entry.commit)}`, {
            ...where,
            hint: 're-ingest, or correct the commit the citation pins',
          });
        }
        if (!entry) {
          out.add('PROV-003', `remote source \`${source.id || source.path}\` is absent from \`${config.manifestPath}\``, where);
        }
        continue;
      }

      // `kind: connector` — the entry must say where the snapshot came from,
      // or nobody can re-sync it. The snapshot itself is a committed sidecar,
      // so the ordinary on-disk check below applies to it unchanged. (Pages
      // find connector entries by path: a `<connector>:<ref>` manifest id is
      // never a valid citation id.)
      if (entry && entry.kind === 'connector') {
        const lacking = ['connector', 'ref', 'extracted'].filter((k) => !entry[k]);
        if (lacking.length) {
          out.add('PROV-003', `connector entry \`${entry.id}\` is missing ${lacking.map((k) => `\`${k}\``).join(', ')}`, {
            ...where,
            hint: 'connector entries record connector, server, ref, version, extracted and extracted_sha256',
          });
        }
      }

      // Repo-root relative is the schema. `raw/…` relative to brain_dir is the
      // v1 spelling and still resolves, so PROV-001 does not double-report what
      // SCHEMA-001 already flags as legacy.
      const candidates = [path.resolve(repoRoot, source.path), path.resolve(brainDir, source.path)];
      if (!candidates.some((c) => fs.existsSync(c))) {
        // `extracted: none` means the source yielded no text at all — a scan
        // with no OCR, an untranscribed recording. The page then cites the
        // gitignored original, which is absent on every fresh clone. That is a
        // fact worth reporting and not a build failure, so it is a warning.
        if (entry && entry.kind === 'connector' && entry.snapshot === 'ephemeral') {
          // `snapshot: ephemeral` — the connector was configured not to commit
          // its snapshots. Same honesty as `extracted: none`: reported, not fatal.
          out.add('PROV-001', `\`${source.path}\` is an ephemeral connector snapshot — not committed, so the citation cannot be machine-verified`, {
            ...where,
            severity: 'warning',
            hint: 'set `snapshot: commit` on the connector to make these citations checkable',
          });
        } else if (entry && entry.extracted === 'none') {
          out.add('PROV-001', `\`${source.path}\` is unextractable and gitignored — the citation cannot be machine-verified`, {
            ...where,
            severity: 'warning',
            hint: 'the manifest records `extracted: none`; verification is by hand or not at all',
          });
        } else {
          out.add('PROV-001', `source path does not exist: \`${source.path}\``, where);
        }
      }

      if (!entry) {
        out.add('PROV-003', `source \`${source.id || source.path}\` is absent from \`${config.manifestPath}\``, {
          ...where,
          hint: manifest.exists ? 'every cited source must be a manifest entry' : 'the manifest file does not exist',
        });
      }
    }
  }

  // PROV-002 — the manifest pointing at pages that are gone.
  const slugs = new Set(pages.flatMap((p) => [p.id, p.slug]));
  for (const entry of manifest.entries) {
    for (const slug of entry.pages) {
      if (!slugs.has(slug)) {
        out.add('PROV-002', `manifest entry \`${entry.id || entry.path}\` names page \`${slug}\` — no such page`, {
          file: path.relative(repoRoot, manifest.file),
        });
      }
    }
  }

  // PROV-004 / PROV-005 — index.md and the wiki must agree, in both
  // directions, at two different severities. A row naming a page that does not
  // exist asserts something false: error. A page with no row is an omission
  // that asserts nothing: warning.
  if (!index.exists) {
    out.add('PROV-004', `\`${config.brainDir}/index.md\` does not exist`, {});
    return;
  }

  const indexFile = path.relative(repoRoot, index.file);
  const byTitle = new Map(pages.map((p) => [p.title.toLowerCase(), p]));
  const bySlug = new Map(pages.flatMap((p) => [[p.id, p], [p.slug, p]]));
  const listed = new Set();

  for (const row of index.rows) {
    const page = matchIndexRow(row.raw, bySlug, byTitle);
    if (page) { listed.add(page.id); continue; }
    out.add('PROV-004', `\`index.md\` lists \`${excerpt(row.raw)}\` — no such page in the wiki`, {
      file: indexFile,
    });
  }

  for (const page of pages) {
    if (listed.has(page.id)) continue;
    out.add('PROV-005', `no \`index.md\` row for \`${page.slug}\``, {
      page: page.id,
      file: indexFile,
      hint: 'add it to the `## Wiki pages` table',
    });
  }
}

/** `[[slug]]`, `[Title](wiki/slug.md)`, `` `slug` `` or bare prose — all accepted. */
function matchIndexRow(raw, bySlug, byTitle) {
  const cleaned = String(raw).trim();

  const wikilink = cleaned.match(/\[\[([^\]|#]+)/);
  if (wikilink) {
    const key = wikilink[1].trim();
    return bySlug.get(key) || byTitle.get(key.toLowerCase()) || null;
  }

  const mdLink = cleaned.match(/\]\(([^)]+)\)/);
  if (mdLink) {
    const base = mdLink[1].split('#')[0].split('/').pop().replace(/\.md$/, '');
    if (bySlug.has(base)) return bySlug.get(base);
  }

  const plain = cleaned.replace(/[*_`]/g, '').replace(/^\[|\]\([^)]*\)$/g, '').trim();
  return bySlug.get(plain) || byTitle.get(plain.toLowerCase()) || bySlug.get(slugify(plain)) || null;
}

// ── CANON / STALE ────────────────────────────────────────────────────────────

function checkCanonical(challenges, config, repoRoot, out) {
  if (!challenges.exists || challenges.outstanding.length === 0) return;
  const file = path.relative(repoRoot, challenges.file);
  for (const entry of challenges.outstanding) {
    out.add('CANON-001', `outstanding challenge: ${excerpt(entry.text)}`, { file, line: entry.line });
  }
}

function checkStale(pages, config, today, out) {
  for (const page of pages) {
    const where = { page: page.id, file: page.relFile };
    const byTier = Number(config.staleAfterDays[page.tier] ?? 0);
    const byStatus = page.status === 'stub' ? Number(config.staleAfterDays.stub ?? 0) : 0;
    // `stub` wins over the tier threshold — brain.config.yaml says so.
    const threshold = byStatus > 0 ? byStatus : byTier;
    if (threshold <= 0) continue;

    const stamp = page.lastVerified || (page.status === 'stub' ? page.dateCreated : '');
    if (!stamp) {
      out.add('STALE-001', `never verified (${page.tier}${page.status === 'stub' ? ', stub' : ''})`, where);
      continue;
    }
    const when = new Date(`${stamp}T00:00:00Z`);
    if (Number.isNaN(when.getTime())) {
      out.add('STALE-001', `\`last_verified: ${stamp}\` is not an ISO date`, where);
      continue;
    }
    const age = daysBetween(when, today);
    if (age > threshold) {
      const label = page.status === 'stub' && !page.lastVerified ? 'stub since' : 'last verified';
      out.add('STALE-001', `${label} ${stamp} (${age} days, ${page.tier}, threshold ${threshold})`, where);
    }
  }
}

// ── DUP / BASIS ──────────────────────────────────────────────────────────────

const normalizeName = (text) => String(text ?? '').trim().toLowerCase();

/**
 * DUP-001 — two pages share a title or an alias, compared case-insensitively
 * and trimmed. Usually the same subject written twice. Each pair is reported
 * once, on the page that sorts first, and names both. Template pages are exempt.
 */
function checkDuplicates(pages, out) {
  const live = pages.filter((p) => !isTemplatePage(p)).sort((a, b) => a.id.localeCompare(b.id));
  const names = new Map();   // normalized name → [{ page, kind }]
  for (const page of live) {
    const mine = new Map();
    const add = (text, kind) => {
      const key = normalizeName(text);
      if (key && !mine.has(key)) mine.set(key, { page, kind, text: String(text).trim() });
    };
    add(page.title, 'title');
    for (const alias of page.aliases) add(alias, 'alias');
    for (const [key, entry] of mine) {
      if (!names.has(key)) names.set(key, []);
      names.get(key).push(entry);
    }
  }
  const reported = new Set();
  for (const [, entries] of [...names].sort(([a], [b]) => a.localeCompare(b))) {
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i];
        const b = entries[j];
        const pair = `${a.page.id}\0${b.page.id}`;
        if (reported.has(pair)) continue;
        reported.add(pair);
        const message = a.kind === b.kind
          ? `\`${a.page.slug}\` and \`${b.page.slug}\` share the ${a.kind} "${a.text}"`
          : `\`${a.page.slug}\` and \`${b.page.slug}\` share a name: "${a.text}" is the ${a.kind} of \`${a.page.slug}\` and the ${b.kind} of \`${b.page.slug}\``;
        out.add('DUP-001', message, {
          page: a.page.id,
          file: a.page.relFile,
          hint: 'merge the two pages, or give one a distinct title and aliases',
        });
      }
    }
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/**
 * BASIS-001 — a claim page whose Basis names a page modified after the
 * claim's `last_verified` (or the claim has no `last_verified`). The ground
 * moved, so the conclusion may no longer follow. The message names the page
 * that changed.
 */
function checkBasis(pages, known, out) {
  const byId = new Map(pages.map((p) => [p.id, p]));
  for (const page of pages) {
    if (page.type !== 'claim' || isTemplatePage(page)) continue;
    const verified = ISO_DAY.test(page.lastVerified) ? page.lastVerified.slice(0, 10) : '';
    const seen = new Set();
    for (const line of sectionLines(page.body, 'Basis')) {
      const m = line.trim().match(/^(?:[-*+]|\d+[.)])\s+\[\[([^\]|#]+)/);
      if (!m) continue;
      const id = resolveTarget(m[1], page.prefix, known);
      const basis = id ? byId.get(id) : null;
      if (!basis || basis === page || seen.has(basis.id)) continue;
      seen.add(basis.id);
      if (!ISO_DAY.test(basis.dateModified)) continue;
      const changed = basis.dateModified.slice(0, 10);
      if (verified && changed <= verified) continue;
      out.add('BASIS-001', verified
        ? `\`${basis.slug}\` was modified ${changed}, after this claim was last verified ${verified}`
        : `\`${basis.slug}\` was modified ${changed} and this claim has no \`last_verified\``, {
        page: page.id,
        file: page.relFile,
        hint: 'check the claim still follows from its Basis, then update `last_verified`',
      });
    }
  }
}

// ── entry point ──────────────────────────────────────────────────────────────

/** Pages exempt from the provenance checks — named in the report, never silent. */
export function templatePages(pages) {
  return pages.filter(isTemplatePage);
}

export function runChecks({ pages, known, config, manifest, index, challenges, repoRoot, today }) {
  const out = new Findings(config);
  checkSchema(pages, config, out);
  checkLinks(pages, known, config, out);
  checkCitations(pages, config, manifest, repoRoot, out);
  checkProvenance(pages, config, manifest, index, repoRoot, out);
  checkCanonical(challenges, config, repoRoot, out);
  checkStale(pages, config, today, out);
  checkDuplicates(pages, out);
  checkBasis(pages, known, out);

  const order = new Map(CATEGORIES.map((c, i) => [c.key, i]));
  out.list.sort((a, b) => {
    const ca = order.get(categoryOf(a.id).key);
    const cb = order.get(categoryOf(b.id).key);
    if (ca !== cb) return ca - cb;
    if (a.id !== b.id) return a.id.localeCompare(b.id);
    if ((a.page ?? '') !== (b.page ?? '')) return (a.page ?? '').localeCompare(b.page ?? '');
    return (a.line ?? 0) - (b.line ?? 0);
  });
  return out.list;
}
