/**
 * _setup.mjs — shared scaffolding for the ingest tests (not itself a test
 * file: the runner only picks up *.test.mjs).
 *
 *   const t = await setup({ mode: 'write' });   // temp repo + app with real ingest, fake governance
 *   const job = await t.drop('notes.md', 'text');  // write into brain/raw/ and enqueue
 *   const done = await t.finished(job);
 */
import fs from 'node:fs';
import path from 'node:path';

import { newId } from '../../src/core/schemas.mjs';
import { git, makeApp, makeTempRepo, rmrf } from '../helpers.mjs';

/** Records createFromJob calls and upserts by branch, the way WS3's will. */
export function fakeGovernance() {
  const proposals = new Map();
  const calls = [];
  return {
    calls,
    proposals,
    async createFromJob(job, details) {
      calls.push({ job, details });
      const existing = [...proposals.values()].find((p) => p.branch === details.branch);
      const p = {
        ...(existing || { id: newId('prp'), status: 'open', jobId: job.id, source: job.source }),
        branch: details.branch, baseSha: details.baseSha, headSha: details.headSha, audit: details.audit,
        changes: (details.runReport?.pages || existing?.changes || []).map((pg) => ({ slug: pg.slug, path: `brain/wiki/${pg.slug}.md`, action: pg.action })),
        decisions: (details.runReport?.blocked || []).map(() => newId('dec')),
      };
      proposals.set(p.id, p);
      return p;
    },
    async getProposal(id) { return proposals.get(id) || null; },
    async listProposals() { return [...proposals.values()]; },
  };
}

const repos = [];
const live = new Set();
/** after(cleanup): stops any app a failed test left running (or the file would hang), then removes the repos. */
export async function cleanup() {
  for (const t of live) await t.stop().catch(() => {});
  while (repos.length) rmrf(repos.pop());
}

export async function setup({ mode = 'write', ingest = {}, files = {}, governance = fakeGovernance(), connectors, http = false, overrides = {} } = {}) {
  const repo = makeTempRepo({ files });
  repos.push(repo);
  const modules = { governance: { create: async () => governance } };
  if (connectors) modules.connectors = { create: async () => connectors };
  const app = await makeApp({
    repoRoot: repo,
    real: ['ingest'],
    modules,
    overrides: {
      ...overrides,
      ingest: { driver: 'fake', watch_raw: false, poll_ms: 25, spool_interval_seconds: 0, fake: { mode }, ...ingest },
      ...(http ? { service: { http: { port: 0 } } } : {}),
    },
  });
  const { ctx } = app;

  const t = {
    repo, app, ctx, governance,
    git: (...args) => git(repo, ...args),
    write(rel, content) {
      const abs = path.join(repo, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
      return abs;
    },
    async drop(name, content = `${name} says the widget ships in March.\n`, extra = {}) {
      t.write(`brain/raw/${name}`, content);
      return ctx.ingest.enqueue({ kind: 'ingest', source: { kind: 'local', path: `brain/raw/${name}` }, trigger: 'manual', requestedBy: { id: 'usr_ada', display: 'Ada', email: 'ada@example.com' }, ...extra });
    },
    finished(job, timeoutMs = 20000) {
      return ctx.bus.waitFor('job.finished', (p) => p.job.id === job.id, timeoutMs).then((p) => p.job);
    },
    show(ref, file) {
      try { return git(repo, 'show', `${ref}:${file}`); } catch { return null; }
    },
    async stop() {
      if (!live.has(t)) return;
      live.delete(t);
      await app.stop();
    },
  };
  live.add(t);
  return t;
}
