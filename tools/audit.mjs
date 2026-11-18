#!/usr/bin/env node
/**
 * tools/audit.mjs — reconcile brain/wiki/ against its own schema, its sources,
 * and the two records that describe them (brain/manifest.yaml, brain/index.md).
 *
 *   tools/audit.mjs                 full audit, human report to stdout
 *   tools/audit.mjs --json          machine-readable findings
 *   tools/audit.mjs index           regenerate brain/.index/
 *   tools/audit.mjs --check-index   verify brain/.index/ is current (CI)
 *   tools/audit.mjs --demand <tsv>  also run DEMAND-001/002 against a demand export
 *
 * Exit codes: 0 clean · 1 violations found · 2 tool error.
 *
 * It NEVER writes to brain/wiki/. The audit reports; the human decides what
 * changes. The only files it writes are the derived index under
 * `brain.config.yaml` → `audit.index_dir`, and only under `index`.
 *
 * The loader is `tools/lib/wiki-core.mjs` — the same module the Astro site
 * imports through `site/src/lib/wiki.ts`. There is deliberately no second
 * frontmatter or wikilink parser in this repo.
 *
 * Check IDs are frozen and documented in `docs/audit.md`; their severities come
 * from `brain.config.yaml` → `audit.severity`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

import { loadWiki, WIKI_DIRS } from './lib/wiki-core.mjs';
import { loadChallenges, loadConfig, loadIndex, loadManifest } from './lib/config.mjs';
import { CATEGORIES, runChecks, templatePages } from './lib/checks.mjs';
import { checkDemand, DEMAND_CATEGORY, loadDemand } from './lib/checks-demand.mjs';
import { renderJson, renderReport, colors } from './lib/report.mjs';
import { diffIndex, indexFiles, writeIndex } from './lib/derived-index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const USAGE = `Usage: tools/audit.mjs [<subcommand>] [options]

  (none)          Run every check and print the human report.
  index           Regenerate the derived index under audit.index_dir.
  --check-index   Regenerate to a temp dir and diff. Exit 1 on drift.

Options:
  --json                  Machine-readable findings instead of the report.
  --repo <dir>            Repo root. Default: the parent of tools/.
  --config <path>         brain.config.yaml to read. Default: <repo>/brain.config.yaml.
  --wiki <dir>            Wiki directory to scan. Repeatable. Overrides the default.
  --brain <dir>           Brain directory (holds index.md). Overrides brain_dir.
  --manifest <path>       Manifest to reconcile against. Overrides manifest.path.
  --index-md <path>       index.md to reconcile against. Default: <brain>/index.md.
  --index-dir <dir>       Where the derived index is written. Overrides audit.index_dir.
  --demand <file>         Demand export (.almagest/demand.tsv) — adds DEMAND-001/002 for hot pages.
  --no-example-pages      Skip \`_\`-prefixed slugs entirely.
  --no-color              Never emit ANSI colour.
  -h, --help              This text.

Exit codes: 0 clean · 1 violations found · 2 tool error.
`;

function parseArgs(argv) {
  const opts = {
    command: 'audit',
    json: false,
    checkIndex: false,
    repo: REPO_ROOT,
    config: null,
    wikiDirs: [],
    brainDir: null,
    manifest: null,
    indexMd: null,
    indexDir: null,
    demand: null,
    showExamplePages: true,
    color: process.stdout.isTTY === true && !process.env.NO_COLOR,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value == null) throw new Error(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case 'index': opts.command = 'index'; break;
      case '--json': opts.json = true; break;
      case '--check-index': opts.checkIndex = true; opts.command = 'check-index'; break;
      case '--repo': opts.repo = path.resolve(next()); break;
      case '--config': opts.config = next(); break;
      case '--wiki': opts.wikiDirs.push(next()); break;
      case '--brain': opts.brainDir = next(); break;
      case '--manifest': opts.manifest = next(); break;
      case '--index-md': opts.indexMd = next(); break;
      case '--index-dir': opts.indexDir = next(); break;
      case '--demand': opts.demand = next(); break;
      case '--no-example-pages': opts.showExamplePages = false; break;
      case '--no-color': opts.color = false; break;
      case '-h': case '--help': opts.command = 'help'; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/** The reference date for STALE-001. Overridable so tests are deterministic. */
function referenceDate() {
  const override = process.env.ALMAGEST_AUDIT_TODAY;
  if (override) {
    const parsed = new Date(`${override}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) throw new Error(`ALMAGEST_AUDIT_TODAY is not an ISO date: ${override}`);
    return parsed;
  }
  return new Date();
}

/**
 * Everything the checks need, loaded once. Kept in one function so the audit,
 * the index writer and `--check-index` all see identical inputs — a
 * `--check-index` that loaded pages differently from `index` would report drift
 * that regenerating could not fix.
 */
function loadEverything(opts) {
  const repoRoot = opts.repo;
  const config = loadConfig(repoRoot, opts.config);

  const brainDir = opts.brainDir ?? config.brainDir;
  const wikiDirs = opts.wikiDirs.length
    ? opts.wikiDirs.map((dir, i) => ({ name: path.basename(dir) || `brain${i}`, prefix: '', dir }))
    : WIKI_DIRS;

  const warnings = [];
  const { pages, known } = loadWiki({
    repoRoot,
    matter,
    wikiDirs,
    showExamplePages: opts.showExamplePages,
    onWarn: (msg) => warnings.push(msg),
  });

  return {
    repoRoot,
    config: { ...config, brainDir, indexDir: opts.indexDir ?? config.indexDir },
    pages,
    known,
    warnings,
    manifest: loadManifest(repoRoot, opts.manifest ?? config.manifestPath),
    index: opts.indexMd
      ? loadIndex(repoRoot, path.dirname(opts.indexMd)) // --index-md <dir>/index.md
      : loadIndex(repoRoot, brainDir),
    challenges: loadChallenges(repoRoot, config.challengesPath),
  };
}

function cmdAudit(opts) {
  const ctx = loadEverything(opts);
  // Loaded before any check runs: an unreadable demand file is a tool error
  // (exit 2), never a silent "nothing is hot".
  const demand = opts.demand ? loadDemand(path.resolve(ctx.repoRoot, opts.demand)) : null;
  const today = referenceDate();
  const findings = runChecks({ ...ctx, today });
  if (demand) {
    if (!CATEGORIES.some((c) => c.key === DEMAND_CATEGORY.key)) CATEGORIES.push(DEMAND_CATEGORY);
    findings.push(...checkDemand({ pages: ctx.pages, config: ctx.config, demand, today }));
  }

  const meta = {
    pageCount: ctx.pages.length,
    exempt: templatePages(ctx.pages).map((p) => p.slug),
    legacySources: ctx.pages.reduce((n, p) => n + p.sources.filter((s) => s.legacy).length, 0),
  };

  if (opts.json) {
    process.stdout.write(renderJson(findings, meta));
  } else {
    for (const warning of ctx.warnings) process.stderr.write(warning + '\n');
    process.stdout.write(renderReport(findings, meta, { color: opts.color }));
  }
  return findings.some((f) => f.severity === 'error') ? 1 : 0;
}

function cmdIndex(opts) {
  const ctx = loadEverything(opts);
  const c = colors(opts.color);
  const dir = path.resolve(ctx.repoRoot, ctx.config.indexDir);
  const files = indexFiles(ctx.pages);
  const written = writeIndex(dir, files);

  const rel = path.relative(ctx.repoRoot, dir) || ctx.config.indexDir;
  if (written.length === 0) {
    process.stderr.write(c.grn(`✓ ${rel}/ already current (${ctx.pages.length} pages)`) + '\n');
  } else {
    for (const name of written) process.stderr.write(c.dim(`  ${rel}/${name}`) + '\n');
    process.stderr.write(c.grn(`✓ ${rel}/ regenerated from ${ctx.pages.length} pages`) + '\n');
  }
  return 0;
}

function cmdCheckIndex(opts) {
  const ctx = loadEverything(opts);
  const c = colors(opts.color);
  const dir = path.resolve(ctx.repoRoot, ctx.config.indexDir);
  const rel = path.relative(ctx.repoRoot, dir) || ctx.config.indexDir;
  const files = indexFiles(ctx.pages);

  // Same idiom as `tools/agent-shims.sh check`: regenerate aside, diff, never
  // touch the working tree. The temp dir is what makes that literally true.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-index-'));
  try {
    writeIndex(tmp, files);
    const drift = diffIndex(dir, files);
    if (drift.length === 0) {
      process.stderr.write(c.grn(`✓ ${rel}/ is in sync (${Object.keys(files).length} files, ${ctx.pages.length} pages)`) + '\n');
      return 0;
    }
    for (const item of drift) {
      process.stderr.write(c.yel(`⚠ ${item.reason}: ${rel}/${item.name}`) + '\n');
      if (item.reason === 'stale') process.stderr.write(unifiedDiff(`${rel}/${item.name}`, item.before, item.after));
    }
    process.stderr.write('\n');
    process.stderr.write(c.red(`✗ ${drift.length} stale or missing — run: tools/audit.mjs index`) + '\n');
    return 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** A minimal line diff. `diff -u` is not guaranteed present; Node is. */
function unifiedDiff(name, before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const out = [`--- ${name} (working tree)`, `+++ ${name} (regenerated)`];
  const seen = new Set(a);
  const want = new Set(b);
  for (const line of a) if (!want.has(line)) out.push(`-${line}`);
  for (const line of b) if (!seen.has(line)) out.push(`+${line}`);
  return out.join('\n') + '\n';
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n\n${USAGE}`);
    return 2;
  }

  if (opts.command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }

  try {
    if (opts.command === 'index') return cmdIndex(opts);
    if (opts.command === 'check-index') return cmdCheckIndex(opts);
    return cmdAudit(opts);
  } catch (err) {
    process.stderr.write(`✗ audit failed: ${err.message}\n`);
    if (process.env.ALMAGEST_DEBUG) process.stderr.write(String(err.stack) + '\n');
    return 2;
  }
}

process.exitCode = main();
