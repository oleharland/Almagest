/**
 * config.mjs — everything `tools/audit.mjs` reads that is not a wiki page.
 *
 * brain.config.yaml, the ingest manifest, brain/index.md and the canonical
 * challenges ledger. All of it is parsed defensively: the audit has to run on a
 * half-migrated brain and say what is wrong with it, so a missing file is a
 * finding, never a crash.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const DEFAULT_STALE = { canonical: 0, curated: 90, evidence: 90, stub: 30 };

function readYaml(file) {
  const text = fs.readFileSync(file, 'utf-8');
  const doc = YAML.parse(text);
  return doc == null ? {} : doc;
}

/**
 * Vocabulary values that belong in a `type_fields` field, not in `type`
 * (SCHEMA-005). Two sources, unioned:
 *
 *   1. the enumerations brain.config.yaml already documents in trailing
 *      comments — `- entity_type   # product | organisation | system | role`
 *   2. whatever the corpus actually puts in those fields
 *
 * Neither alone is enough: (1) misses hand-written vocabularies, (2) misses a
 * value nobody has used yet — which is exactly the one someone mistypes.
 */
function vocabularyFromComments(text) {
  const lines = text.split('\n');
  const vocab = new Set();
  let inBlock = false;

  for (const line of lines) {
    if (/^type_fields:/.test(line)) { inBlock = true; continue; }
    if (inBlock && /^\S/.test(line)) { inBlock = false; }
    if (!inBlock) continue;

    const comment = line.match(/#\s*(.+)$/);
    if (!comment) continue;
    const body = comment[1];
    if (!body.includes('|')) continue;
    for (const token of body.split('|')) {
      const value = token.trim().replace(/[.,]$/, '');
      if (/^[a-z][a-z0-9-]*$/.test(value)) vocab.add(value);
    }
  }
  return vocab;
}

/**
 * A `type_fields` entry is a frontmatter key, unless it is prefixed `section:`
 * — then it names a required body section. brain.config.yaml documents the
 * convention; this is where it is enforced.
 */
function splitTypeFields(list) {
  const fields = [];
  const sections = [];
  for (const entry of list || []) {
    const value = String(entry).trim();
    if (value.toLowerCase().startsWith('section:')) {
      sections.push(value.slice('section:'.length).trim().replace(/^#+\s*/, ''));
    } else {
      fields.push(value);
    }
  }
  return { fields, sections };
}

export function loadConfig(repoRoot, configPath) {
  const file = configPath ? path.resolve(repoRoot, configPath) : path.join(repoRoot, 'brain.config.yaml');
  if (!fs.existsSync(file)) {
    throw new Error(`brain.config.yaml not found at ${path.relative(repoRoot, file) || file}`);
  }
  const text = fs.readFileSync(file, 'utf-8');
  const raw = YAML.parse(text) || {};
  const audit = raw.audit || {};

  const typeFields = {};
  for (const [type, list] of Object.entries(raw.type_fields || {})) {
    typeFields[type] = splitTypeFields(list);
  }

  return {
    file,
    raw,
    brainDir: String(raw.brain_dir || 'brain'),
    manifestPath: String(raw.manifest?.path || 'brain/manifest.yaml'),
    pageTypes: (raw.page_types || []).map(String),
    typeFields,
    typeVocabulary: vocabularyFromComments(text),
    requireOwner: raw.require_owner === true,
    ownerTeams: (raw.owner_teams || []).map(String),
    canonicalPages: (raw.canonical_pages || []).map(String),
    staleAfterDays: { ...DEFAULT_STALE, ...(audit.stale_after_days || {}) },
    severityErrors: new Set((audit.severity?.errors || []).map(String)),
    severityWarnings: new Set((audit.severity?.warnings || []).map(String)),
    challengesPath: String(audit.challenges_path || 'brain/canonical-challenges.md'),
    indexDir: String(audit.index_dir || 'brain/.index'),
  };
}

/**
 * The ingest manifest. Returns the entries plus lookup maps keyed by id and by
 * path — PROV-003 and CITE-005 both need to find an entry from a page's
 * `sources[]`, and a page may cite either handle.
 */
export function loadManifest(repoRoot, manifestPath) {
  const file = path.resolve(repoRoot, manifestPath);
  const result = { file, exists: false, entries: [], byId: new Map(), byPath: new Map() };
  if (!fs.existsSync(file)) return result;

  result.exists = true;
  const doc = readYaml(file);
  const entries = Array.isArray(doc.sources) ? doc.sources : [];

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const normalized = {
      id: entry.id == null ? '' : String(entry.id),
      kind: entry.kind == null ? '' : String(entry.kind),
      path: entry.path == null ? '' : String(entry.path),
      sha256: entry.sha256 == null ? '' : String(entry.sha256).toLowerCase(),
      // Binary sources are hashed twice: `sha256` is the gitignored original,
      // `extracted_sha256` is the committed sidecar pages actually cite.
      extracted: entry.extracted == null ? '' : String(entry.extracted),
      extractedSha256: entry.extracted_sha256 == null ? '' : String(entry.extracted_sha256).toLowerCase(),
      commit: entry.commit == null ? '' : String(entry.commit),
      provider: entry.provider == null ? '' : String(entry.provider),
      repo: entry.repo == null ? '' : String(entry.repo),
      // `kind: connector` (v2) — an item fetched over MCP by the service. The
      // snapshot it was rendered to is both `path` and `extracted`: there is no
      // other original on disk. `snapshot: ephemeral` means the snapshot was
      // deliberately not committed, so its citations cannot be resolved.
      connector: entry.connector == null ? '' : String(entry.connector),
      server: entry.server == null ? '' : String(entry.server),
      ref: entry.ref == null ? '' : String(entry.ref),
      version: entry.version == null ? '' : String(entry.version),
      snapshot: entry.snapshot == null ? '' : String(entry.snapshot),
      label: entry.label == null ? '' : String(entry.label),
      status: entry.status == null ? '' : String(entry.status),
      pages: Array.isArray(entry.pages) ? entry.pages.map(String) : [],
      previousPaths: Array.isArray(entry.previous_paths) ? entry.previous_paths.map(String) : [],
    };
    result.entries.push(normalized);
    if (normalized.id) result.byId.set(normalized.id, normalized);
    if (normalized.path) result.byPath.set(normalized.path, normalized);
    if (normalized.extracted && normalized.extracted !== 'none') {
      result.byPath.set(normalized.extracted, normalized);
    }
    for (const previous of normalized.previousPaths) result.byPath.set(previous, normalized);
  }
  return result;
}

const PLACEHOLDER_ROW = /^_?\(?\s*(no|none)\b/i;

/**
 * Page slugs named by the `## Wiki pages` table in brain/index.md (PROV-004).
 *
 * The first cell is written as `[[slug]]`, as a markdown link, or as bare
 * prose. All three are accepted; matching back to a page happens in the check,
 * which knows the titles.
 */
export function loadIndex(repoRoot, brainDir) {
  const file = path.join(path.resolve(repoRoot, brainDir), 'index.md');
  const result = { file, exists: false, rows: [] };
  if (!fs.existsSync(file)) return result;

  result.exists = true;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  let inWikiTable = false;

  for (const line of lines) {
    const heading = line.trim().match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inWikiTable = /^wiki pages$/i.test(heading[1].trim());
      continue;
    }
    if (!inWikiTable) continue;

    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) continue;

    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const first = cells[0] || '';
    if (!first) continue;
    if (/^-{2,}$/.test(first.replace(/[:\s]/g, '-'))) continue;   // separator row
    if (/^page$/i.test(first)) continue;                          // header row
    if (PLACEHOLDER_ROW.test(first.replace(/[*_`]/g, ''))) continue;

    result.rows.push({ raw: first, cells });
  }
  return result;
}

/**
 * Outstanding rows in the canonical-challenges ledger (CANON-001).
 *
 * The ledger is a table under `## Challenges` with a `Status` column, appended
 * to and never edited away. A row is outstanding while its status is `open` or
 * blank; `accepted`, `rejected` and `superseded` are all resolutions, and a
 * resolved row stays in the file on purpose. Everything above that heading is
 * the file's own documentation and is not a challenge.
 */
const RESOLVED_STATUS = new Set(['accepted', 'rejected', 'superseded']);

export function loadChallenges(repoRoot, challengesPath) {
  const file = path.resolve(repoRoot, challengesPath);
  const result = { file, exists: false, outstanding: [] };
  if (!fs.existsSync(file)) return result;

  result.exists = true;
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  let inLedger = false;

  lines.forEach((line, i) => {
    const heading = line.trim().match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      inLedger = /^challenges$/i.test(heading[1].trim());
      return;
    }
    if (!inLedger) return;

    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) return;
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => c === '')) return;                                   // placeholder row
    if (/^-{2,}$/.test((cells[0] || '').replace(/[:\s]/g, '-'))) return;        // separator
    if (/^date$/i.test(cells[0] || '')) return;                                 // header

    const status = (cells[cells.length - 1] || '').toLowerCase().replace(/[`*_]/g, '');
    if (RESOLVED_STATUS.has(status)) return;
    result.outstanding.push({
      line: i + 1,
      text: [cells[1], cells[2]].filter(Boolean).join(' — ') || trimmed,
    });
  });

  return result;
}
