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

/** Categories drive the report layout and the emoji key in agent/rules/wiki.md. */
export const CATEGORIES = [
  { key: 'schema', emoji: '📋', label: 'Schema', prefixes: ['SCHEMA-'] },
  { key: 'links', emoji: '🔗', label: 'Broken links', ids: ['LINK-001', 'LINK-003'] },
  { key: 'orphans', emoji: '👻', label: 'Orphans', ids: ['LINK-002'] },
  { key: 'citations', emoji: '📎', label: 'Citations', prefixes: ['CITE-'] },
  { key: 'provenance', emoji: '🧾', label: 'Provenance', prefixes: ['PROV-'] },
  { key: 'canonical', emoji: '🛡️', label: 'Canonical', ids: ['CANON-'] },
  { key: 'stale', emoji: '🕸️', label: 'Stale', ids: ['STALE-'] },
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

    if ((inbound.get(page.id) ?? 0) === 0 && !config.canonicalPages.includes(page.slug)) {
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
