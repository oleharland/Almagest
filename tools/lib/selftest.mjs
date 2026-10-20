#!/usr/bin/env node
/**
 * tools/lib/selftest.mjs — prove the audit actually fires.
 *
 * Two fixture brains under `__fixtures__/`:
 *   clean/  the control. Anything the audit says about it is a bug in the audit.
 *   dirty/  trips every check ID at least once, with the documented severity.
 *
 * Plus unit coverage of the two parsers that have no natural fixture: the
 * frozen citation grammar and the body-block splitter behind CITE-003.
 *
 * Run: node tools/lib/selftest.mjs      (or `npm run selftest`)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

import { findCitations, parseBody, parseCitation, sectionLines } from './wiki-core.mjs';
import { renderAliasesTsv, renderPagesTsv } from './derived-index.mjs';
import { loadWiki } from './wiki-core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const AUDIT = path.join(REPO, 'tools', 'audit.mjs');
const CLEAN = path.join(HERE, '__fixtures__', 'clean');
const DIRTY = path.join(HERE, '__fixtures__', 'dirty');
const TODAY = '2026-01-10';

let pass = 0;
let fail = 0;
const C = process.stdout.isTTY && !process.env.NO_COLOR;
const green = (s) => (C ? `\u001b[32m${s}\u001b[0m` : s);
const red = (s) => (C ? `\u001b[31m${s}\u001b[0m` : s);

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ${green('✓')} ${name}`);
  } else {
    fail++;
    console.log(`  ${red('✗')} ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Run the CLI exactly as CI would. Returns { code, stdout, stderr }. */
function audit(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [AUDIT, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, ALMAGEST_AUDIT_TODAY: TODAY, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 2, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function auditJson(repo) {
  const result = audit(['--repo', repo, '--json']);
  return { code: result.code, json: JSON.parse(result.stdout) };
}

// ── the control ──────────────────────────────────────────────────────────────

console.log('\nclean fixture — the audit must say nothing');
{
  const { code, json } = auditJson(CLEAN);
  check('exit 0', code === 0, `got ${code}`);
  check('no findings', json.findings.length === 0, JSON.stringify(json.findings.map((f) => f.id + ':' + f.slug)));
  check('3 pages scanned', json.pages === 3, `got ${json.pages}`);
  check('ok: true', json.ok === true);
}

// ── every check ID ───────────────────────────────────────────────────────────

const EXPECTED = {
  'SCHEMA-001': 'error',
  'SCHEMA-002': 'error',
  'SCHEMA-003': 'error',
  'SCHEMA-004': 'error',
  'SCHEMA-005': 'error',
  'LINK-001': 'error',
  'LINK-002': 'warning',
  'LINK-003': 'error',
  'CITE-001': 'error',
  'CITE-002': 'error',
  'CITE-003': 'error',
  'CITE-004': 'error',
  'CITE-005': 'error',
  'CITE-006': 'error',
  'PROV-001': 'error',
  'PROV-002': 'error',
  'PROV-003': 'error',
  'PROV-004': 'error',
  'PROV-005': 'warning',
  'CANON-001': 'warning',
  'STALE-001': 'warning',
};

console.log('\ndirty fixture — every check ID fires at its documented severity');
{
  const { code, json } = auditJson(DIRTY);
  check('exit 1', code === 1, `got ${code}`);

  const bySeverity = new Map();
  for (const f of json.findings) {
    if (!bySeverity.has(f.id)) bySeverity.set(f.id, new Set());
    bySeverity.get(f.id).add(f.severity);
  }
  for (const [id, severity] of Object.entries(EXPECTED)) {
    const seen = bySeverity.get(id);
    check(`${id} fires as ${severity}`, Boolean(seen?.has(severity)), seen ? [...seen].join('/') : 'never fired');
  }

  // The two documented exceptions to PROV-001's severity.
  const prov001 = json.findings.filter((f) => f.id === 'PROV-001');
  check(
    'PROV-001 downgrades `extracted: none` to a warning',
    prov001.some((f) => f.severity === 'warning' && f.slug === 'unextractable')
  );
  check(
    'PROV-001 skips a well-formed remote path',
    !prov001.some((f) => f.message.includes('0007-caching'))
  );
  check(
    'PROV-001 rejects a malformed remote path',
    prov001.some((f) => f.severity === 'error' && f.message.includes('github:acme@abc'))
  );
  check(
    'PROV-003 catches a commit the manifest has moved past',
    json.findings.some((f) => f.id === 'PROV-003' && f.message.includes('deadbee'))
  );

  // The finding shape docs/audit.md documents.
  const sample = json.findings[0];
  check(
    'findings carry id/severity/slug/path/line/message',
    ['id', 'severity', 'slug', 'path', 'line', 'message'].every((k) => k in sample)
  );
}

// ── connector sources (kind: connector) ──────────────────────────────────────
//
// Two more fixture brains, kept apart from clean/ and dirty/ so the v1
// control stays exactly what it was. Their snapshots are real output of the
// service's snapshot builder (server/src/connectors/snapshot-file.mjs).

console.log('\nconnector fixtures — snapshots cite like sidecars, and drift is caught');
{
  const CONNECTOR_CLEAN = path.join(HERE, '__fixtures__', 'connector-clean');
  const CONNECTOR_DIRTY = path.join(HERE, '__fixtures__', 'connector-dirty');

  const clean = auditJson(CONNECTOR_CLEAN);
  check('connector-clean exits 0', clean.code === 0, `got ${clean.code}`);
  check('connector-clean has no findings', clean.json.findings.length === 0, JSON.stringify(clean.json.findings.map((f) => `${f.id}:${f.slug}`)));
  check('connector-clean scans 2 pages', clean.json.pages === 2, `got ${clean.json.pages}`);

  const dirty = auditJson(CONNECTOR_DIRTY);
  const has = (id, severity, slug, text) =>
    dirty.json.findings.some((f) => f.id === id && f.severity === severity && f.slug === slug && f.message.includes(text));
  check('connector-dirty exits 1', dirty.code === 1, `got ${dirty.code}`);
  check('CITE-005 catches a snapshot edited after the service fingerprinted it',
    has('CITE-005', 'error', 'release-policy', 'but the service fingerprinted it as'));
  check('CITE-005 catches a page citing an older snapshot digest',
    has('CITE-005', 'error', 'release-cadence', 'disagrees with manifest 7c7be2da'));
  check('PROV-003 catches a connector entry with no `ref`',
    has('PROV-003', 'error', 'connector-drift', 'is missing `ref`'));
  check('PROV-003 catches a snapshot no manifest entry records',
    has('PROV-003', 'error', 'connector-drift', '`notion-orphan` is absent'));
  check('PROV-001 is a warning for an ephemeral snapshot',
    has('PROV-001', 'warning', 'connector-drift', 'ephemeral connector snapshot'));
  check('PROV-001 is an error for a committed snapshot that is missing',
    has('PROV-001', 'error', 'connector-drift', 'eng-42-deadbeef.txt'));
  check('nothing else fires on connector-dirty', dirty.json.findings.length === 6,
    JSON.stringify(dirty.json.findings.map((f) => `${f.id}:${f.slug}`)));

  const snapshot = fs.readFileSync(path.join(CONNECTOR_CLEAN, 'brain/raw/extracted/team-calls/not-abc123def456gh-6eeedaeb.txt'), 'utf-8');
  const cited = findCitations(fs.readFileSync(path.join(CONNECTOR_CLEAN, 'brain/wiki/release-cadence.md'), 'utf-8'));
  check('a transcript snapshot carries the marker its citation names',
    cited.some((c) => c.ok && c.locator === 't 00:00:00') && snapshot.includes('=== t 00:00:00 ==='));
}

// ── template-page exemption ──────────────────────────────────────────────────

console.log('\ntemplate pages — exempt from provenance, and said so out loud');
{
  const { json } = auditJson(REPO);
  const exempt = new Set(json.exempt);
  check('`_`-prefixed slugs are listed as exempt', exempt.size > 0, [...exempt].join(', '));
  check(
    'no PROV-001/PROV-003/CITE-005 against a template page',
    !json.findings.some((f) => ['PROV-001', 'PROV-003', 'CITE-005'].includes(f.id) && exempt.has(f.slug))
  );
  const report = audit(['--repo', REPO, '--no-color']).stdout;
  check('the report names the exemption', report.includes('exempt from PROV-001'));
}

// ── the citation grammar ─────────────────────────────────────────────────────

console.log('\ncitation grammar — frozen, so both directions must hold');
{
  const good = [
    ['[source: kb-02, §Failover]', 'kb-02'],
    ['[source: kb-02-site-survey, p.3]', 'kb-02-site-survey'],
    ['[source: kb-02, pp.3-7]', 'kb-02'],
    ['[source: kb-02, row 14]', 'kb-02'],
    ['[source: kb-02, slide 4]', 'kb-02'],
    ['[source: kb-02, t 00:14:32]', 'kb-02'],
    ['[source: kb-02, line 91]', 'kb-02'],
    ['[source: kb-02, §Capability Matrix]', 'kb-02'],
    ['[source: kb-02, p.3, (2027-06-15)]', 'kb-02'],
    ['[source: unknown]', 'unknown'],
  ];
  for (const [raw, id] of good) {
    const parsed = parseCitation(raw.slice('[source:'.length, -1));
    check(`accepts ${raw}`, parsed.ok && parsed.id === id, parsed.reason ?? parsed.id);
  }

  const bad = [
    '[source: System Documentation / Architecture, §Failover, p.3]',
    '[source: kb-02]',
    '[source: kb-02, page 3]',
    '[source: KB-02, p.3]',
    '[source: ]',
    '[source: kb-02, p.3, 2027-06-15]',
  ];
  for (const raw of bad) {
    const parsed = parseCitation(raw.slice('[source:'.length, -1));
    check(`rejects ${raw}`, !parsed.ok, 'parsed clean');
  }

  const found = findCitations('a [source: kb-02, p.1]\n\nb [source: unknown]\n');
  check('findCitations reports line numbers', found.length === 2 && found[0].line === 1 && found[1].line === 3);
}

// ── body blocks ──────────────────────────────────────────────────────────────

console.log('\nbody blocks — what CITE-003 does and does not treat as a claim');
{
  const body = [
    '## Summary',
    'A summary sentence.',
    '',
    '## Details',
    'A paragraph claim.',
    'Its citation on the next line.',
    '',
    '- A list item claim.',
    '',
    '| a | b |',
    '|---|---|',
    '| 1 | 2 |',
    '',
    '> A disputed marker.',
    '',
    '```',
    'code that is not a claim',
    '```',
    '',
    '## Open questions',
    '- Something unknown.',
  ].join('\n');

  const blocks = parseBody(body);
  const details = blocks.filter((b) => b.section === 'Details');
  check('a paragraph is one block, continuation lines included', details[0].kind === 'paragraph' && details[0].text.includes('next line'));
  check('a list item is its own block', details[1]?.kind === 'list-item');
  check('table rows are not blocks', !blocks.some((b) => b.text.includes('| 1 |')));
  check('blockquotes are not blocks', !blocks.some((b) => b.text.includes('disputed marker')));
  check('fenced code is not a block', !blocks.some((b) => b.text.includes('code that is not')));
  check('sections are tagged', blocks.some((b) => b.section === 'Summary') && blocks.some((b) => b.section === 'Open questions'));
  check('Details holds exactly two blocks', details.length === 2, String(details.length));

  const basis = sectionLines('## Basis\n\n- [[a]]\n- [[b]]\n\n## Next\n- [[c]]\n', 'Basis');
  check('sectionLines stops at the next heading', basis.filter((l) => l.trim()).length === 2);
}

// ── the derived index ────────────────────────────────────────────────────────

console.log('\nderived index — deterministic bytes, and drift is caught');
{
  const { pages } = loadWiki({ repoRoot: CLEAN, matter, showExamplePages: true, onWarn: () => {} });
  const first = renderPagesTsv(pages);
  const second = renderPagesTsv(pages);
  check('pages.tsv is byte-identical across runs', first === second);
  check('pages.tsv has a header row', first.split('\n')[0].startsWith('slug\ttitle\ttype'));
  check('rows are sorted by slug', (() => {
    const rows = first.trim().split('\n').slice(1).map((r) => r.split('\t')[0]);
    return rows.join() === [...rows].sort().join();
  })());
  check('every cell is tab-separated with 12 columns', first.trim().split('\n').every((r) => r.split('\t').length === 12));
  check('multi-value cells use |', first.includes('alpha-pdf'));

  const aliases = renderAliasesTsv(pages);
  check('aliases.tsv has a header row', aliases.split('\n')[0] === 'alias\tslug');
  check('aliases.tsv carries titles lowercased', aliases.includes('alpha system\talpha'));
  check('aliases.tsv carries declared aliases', aliases.includes('b-1\tbeta'));
  check('aliases.tsv is sorted', (() => {
    const rows = aliases.trim().split('\n').slice(1);
    return rows.join() === [...rows].sort().join();
  })());

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-selftest-'));
  try {
    fs.cpSync(CLEAN, tmp, { recursive: true });
    check('`index` exits 0', audit(['--repo', tmp, 'index']).code === 0);
    check('`--check-index` is clean straight after `index`', audit(['--repo', tmp, '--check-index']).code === 0);

    const pagesTsv = path.join(tmp, 'brain', '.index', 'pages.tsv');
    fs.appendFileSync(pagesTsv, 'drifted\tDrifted\ttopic\tcurated\tdraft\tsource\thigh\t\t\t\t\t\n');
    const drifted = audit(['--repo', tmp, '--check-index']);
    check('`--check-index` exits 1 on drift', drifted.code === 1, `got ${drifted.code}`);
    check('drift is named in the output', drifted.stderr.includes('pages.tsv'));

    fs.rmSync(path.join(tmp, 'brain', '.index'), { recursive: true, force: true });
    check('`--check-index` exits 1 when the index is missing', audit(['--repo', tmp, '--check-index']).code === 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  check('the committed clean-fixture index is current', audit(['--repo', CLEAN, '--check-index']).code === 0);
}

// ── the audit never writes to the wiki ───────────────────────────────────────

console.log('\nblast radius — the audit reports, it does not fix');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-blast-'));
  try {
    fs.cpSync(DIRTY, tmp, { recursive: true });
    const wikiDir = path.join(tmp, 'brain', 'wiki');
    const before = fs.readdirSync(wikiDir).sort().map((f) => f + ':' + fs.readFileSync(path.join(wikiDir, f), 'utf-8').length);
    audit(['--repo', tmp]);
    audit(['--repo', tmp, '--json']);
    audit(['--repo', tmp, 'index']);
    const after = fs.readdirSync(wikiDir).sort().map((f) => f + ':' + fs.readFileSync(path.join(wikiDir, f), 'utf-8').length);
    check('brain/wiki/ is byte-identical after a full run', before.join() === after.join());
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// ── CLI contract ─────────────────────────────────────────────────────────────

console.log('\nCLI — exit codes are the contract');
{
  check('--help exits 0', audit(['--help']).code === 0);
  check('an unknown flag exits 2', audit(['--nonsense']).code === 2);
  check('a missing config exits 2', audit(['--repo', os.tmpdir()]).code === 2);
  // A page still carrying the retired v1 string-form `sources:` must be caught
  // and named. This used to sample benchmarks/fixtures/wiki, which was v1 at the
  // time; those fixtures are v2 now, so the case is built here instead of
  // borrowed from a corpus that is free to change under it.
  const v1 = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-v1-'));
  try {
    fs.cpSync(CLEAN, v1, { recursive: true });
    const page = path.join(v1, 'brain', 'wiki', 'alpha.md');
    fs.writeFileSync(
      page,
      fs.readFileSync(page, 'utf8').replace(
        /^sources:\n(?:[ \t]+\S.*\n)+/m,
        'sources:\n  - "brain/raw/extracted/alpha.pdf.txt"\n',
      ),
    );
    const legacy = audit(['--repo', v1, '--no-color']);
    check('a retired v1 string-form `sources:` exits 1', legacy.code === 1, `got ${legacy.code}`);
    check('and is named as v1 string form', legacy.stdout.includes('retired v1 string form'));
  } finally {
    fs.rmSync(v1, { recursive: true, force: true });
  }
}

console.log(`\n${fail === 0 ? green('✓') : red('✗')} ${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
