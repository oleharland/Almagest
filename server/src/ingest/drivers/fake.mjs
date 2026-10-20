/**
 * fake.mjs — a deterministic stand-in for an agent. No model, no network, no
 * money. It does what a well-behaved runner-mode agent does, mechanically, so
 * the queue, the runner, the audit gate and governance's createFromJob can be
 * tested end to end:
 *
 *   reads the placed source, writes one `origin: source` page citing it, adds
 *   the manifest entry, the index.md rows and a log.md line, and writes
 *   `.almagest/run-report.json`.
 *
 * Modes (`ingest.fake.mode`, read on every run so a test can switch it):
 *
 *   write         (default) the above
 *   blocked       the above, plus one `contradiction` in blocked[]
 *   blocked-only  no page; log.md line + one blocked[] decision
 *   unchanged     nothing written, outcome `unchanged`
 *   audit-fail    a page whose citation id is not in its sources (CITE-002)
 *   escape        also edits brain.config.yaml — the runner's path guard must refuse
 *   no-report     writes nothing at all
 *   crash         returns ok: false
 *   crash-once    crashes on attempt 1, behaves as `write` afterwards
 *   hang          never finishes until aborted (timeout tests)
 *
 * The page it writes is the smallest one the clean fixture's audit accepts.
 */
import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { loadConfig } from '../../../../tools/lib/config.mjs';
import { slugify } from '../../core/schemas.mjs';
import { appendTableRow } from '../md.mjs';

const today = () => new Date().toISOString().slice(0, 10);

function titleCase(s) {
  return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || 'Untitled';
}

function upsertManifest(file, entry) {
  const doc = fs.existsSync(file) ? YAML.parseDocument(fs.readFileSync(file, 'utf-8')) : new YAML.Document({ version: 1, sources: [] });
  if (!doc.has('sources')) doc.set('sources', doc.createNode([]));
  const seq = doc.get('sources');
  const items = seq.items || [];
  const i = items.findIndex((it) => it?.get?.('id') === entry.id);
  const node = doc.createNode(entry);
  if (i === -1) seq.add(node);
  else {
    const prev = items[i].toJSON();
    items[i] = doc.createNode({ ...prev, ...entry, first_ingested: prev.first_ingested || entry.first_ingested, pages: [...new Set([...(prev.pages || []), ...entry.pages])] });
  }
  fs.writeFileSync(file, doc.toString());
}

function pageText({ title, type, source, citeId, citePath, sha, idForCitation, claim, line }) {
  return `---
title: ${JSON.stringify(title)}
type: ${type}
tier: evidence
origin: source
status: draft
confidence: medium
tags: []
aliases: []
owner: ""
date_created: "${today()}"
date_modified: "${today()}"
last_verified: "${today()}"
sources:
  - id: ${citeId}
    path: ${citePath}
    sha256: "${sha}"
    title: ${JSON.stringify(source.title || source.id)}
related: []
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

## Summary

${title}, as recorded by the fake ingest driver.

## Details

${claim} [source: ${idForCitation}, line ${line}]
`;
}

export function createFakeDriver(ctx, options = {}) {
  const mode = () => options.mode || ctx.config.ingest.fake?.mode || 'write';

  return {
    name: 'fake',
    capabilities: { tool_restriction: true, budget_cap: true, cost_reporting: true, session_isolation: true, sandbox: true },

    async run({ cwd, signal, logStream, job, source, sourcePath }) {
      const started = Date.now();
      let m = mode();
      if (m === 'crash-once') m = (job?.attempts || 1) <= 1 ? 'crash' : 'write';
      logStream?.write(`[fake] mode ${m}\n`);

      if (m === 'hang') {
        await new Promise((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener('abort', resolve, { once: true });
        });
        return { ok: false, durationMs: Date.now() - started, error: 'aborted', raw: {} };
      }
      if (m === 'crash') return { ok: false, durationMs: Date.now() - started, error: 'simulated crash', raw: {} };
      if (m === 'no-report') return { ok: true, durationMs: Date.now() - started, raw: {} };

      const report = (body) => {
        fs.mkdirSync(path.join(cwd, '.almagest'), { recursive: true });
        fs.writeFileSync(path.join(cwd, '.almagest', 'run-report.json'), JSON.stringify({ source: { id: source?.id || 'none', sha256: source?.sha256 }, ...body }, null, 2));
        return { ok: true, costUsd: 0, durationMs: Date.now() - started, raw: { mode: m } };
      };

      const cfg = loadConfig(cwd);
      const brain = cfg.brainDir;
      const logFile = path.join(cwd, brain, 'log.md');
      const logLine = (what) => {
        const base = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : '# Log\n';
        fs.writeFileSync(logFile, appendTableRow(base, /^#\s+Log\b/, '| Date | Action | Details |\n|------|--------|---------|', `| ${today()} | ${what} | fake driver, ${job?.id || 'no job'} |`));
      };

      if (m === 'unchanged') return report({ outcome: 'unchanged', pages: [], blocked: [], notes: 'fake: unchanged' });

      if (job?.kind === 'revise' || job?.kind === 'reverify') {
        logLine(`${job.kind} ${source?.id || ''}: ${String(job.instructions || '').replace(/\|/g, '/').slice(0, 120)}`);
        return report({ outcome: 'written', pages: [], blocked: [], notes: `fake: applied ${job.kind}` });
      }

      const decision = {
        kind: 'contradiction',
        slug: '',
        question: `Does ${source?.title || source?.id} supersede the existing claim?`,
        claimA: 'existing claim', sourceA: 'alpha-pdf', claimB: 'new claim', sourceB: source?.id || '',
        options: [
          { id: 'replace', label: 'Replace with the new source', effect: 'Replace the existing claim with the new one and cite the new source.' },
          { id: 'keep', label: 'Keep the existing claim', effect: 'Leave the existing page unchanged and note the disagreement under Open questions.' },
        ],
      };

      if (m === 'blocked-only') {
        logLine(`blocked ${source?.id}: contradiction left unwritten`);
        return report({ outcome: 'blocked-only', pages: [], blocked: [decision], notes: 'fake: blocked only' });
      }

      // A local text source is cited where the runner will move it
      // (processed/); a connector snapshot is its own committed sidecar and is
      // cited in place (ingest.md → Connector sources).
      const placed = sourcePath || source?.path || '';
      const connector = source?.kind === 'connector';
      const name = path.basename(placed);
      const citePath = connector ? placed : `${brain}/raw/processed/${name}`;
      const citeId = slugify(source.id);   // manifest ids may hold `:` — a citation id may not
      const text = fs.readFileSync(path.join(cwd, placed), 'utf-8');
      const lines = text.split('\n');
      const lineNo = Math.max(1, lines.findIndex((l) => l.trim() && !/^(===|---)/.test(l.trim())) + 1);
      const claim = (lines[lineNo - 1] || 'The source is empty.').trim().replace(/\[|\]/g, '');
      const slug = slugify(name.replace(/\.[^.]+$/, ''));
      const title = titleCase(slug);
      const type = cfg.pageTypes.includes('topic') ? 'topic' : cfg.pageTypes[0] || 'topic';
      const pageFile = path.join(cwd, brain, 'wiki', `${slug}.md`);
      const action = fs.existsSync(pageFile) ? 'update' : 'create';

      fs.mkdirSync(path.dirname(pageFile), { recursive: true });
      fs.writeFileSync(pageFile, pageText({
        title, type, source, citeId, citePath, sha: source.sha256,
        idForCitation: m === 'audit-fail' ? 'not-a-source' : citeId, claim, line: lineNo,
      }));

      const dates = { bytes: Buffer.byteLength(text), first_ingested: today(), last_ingested: today(), pages: [slug], status: 'ingested' };
      upsertManifest(path.join(cwd, cfg.manifestPath), connector
        ? {
          id: source.id, kind: 'connector', connector: source.connector, server: source.server || source.connector, ref: source.ref,
          ...(source.version ? { version: source.version } : {}),
          path: placed, sha256: source.sha256, extracted: placed, extracted_sha256: source.sha256, snapshot: source.snapshot || 'commit', ...dates,
        }
        : { id: source.id, kind: 'local', path: citePath, sha256: source.sha256, ...dates });
      const processed = citePath;

      const indexFile = path.join(cwd, brain, 'index.md');
      let index = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf-8') : '# Index\n';
      if (action === 'create') {
        index = appendTableRow(index, /^##\s+Wiki pages/i, '## Wiki pages\n\n| Page | Type | Tier | Status | Last modified |\n|------|------|------|--------|---------------|',
          `| [[${slug}]] | ${type} | evidence | draft | ${today()} |`);
      }
      index = appendTableRow(index, /^##\s+Raw sources/i, '## Raw sources (local)\n\n| Source file | Ingested | Pages created/updated |\n|------------|----------|-----------------------|',
        `| \`${processed}\` | ${today()} | ${slug} |`);
      fs.writeFileSync(indexFile, index);
      logLine(`ingest ${source.id} (${String(source.sha256).slice(0, 7)}…): ${action} [[${slug}]]`);

      if (m === 'escape') fs.appendFileSync(path.join(cwd, 'brain.config.yaml'), '\n# the agent was here\n');

      return report({
        outcome: 'written',
        pages: [{ slug, action, tier: 'evidence', summary: `${action === 'create' ? 'New' : 'Updated'} page from ${source.title || source.id}` }],
        blocked: m === 'blocked' ? [{ ...decision, slug }] : [],
        notes: `fake: ${m}`,
      });
    },
  };
}
