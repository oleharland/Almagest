/**
 * Shared scaffolding for the governance tests: a temp repo, an app with the
 * real governance module and a fake ingest, a proposal branch, and a tiny
 * cookie-keeping HTTP client.
 */
import fs from 'node:fs';
import path from 'node:path';

import { humanActor } from '../../src/core/auth.mjs';
import { newId } from '../../src/core/schemas.mjs';
import { vouch } from '../../src/governance/trust.mjs';
import { git, makeApp, makeTempRepo, rmrf } from '../helpers.mjs';

export const repos = [];
export function repo(opts) { const r = makeTempRepo(opts); repos.push(r); return r; }
export function cleanup() { repos.splice(0).forEach(rmrf); }

/** A person as a signed-in browser session would present them (trust.mjs). */
export function sess(actor) {
  return vouch({ ...actor, session: { sid: `test-${actor.id}` } }, 'session');
}

export const ada = sess(humanActor({ id: 'usr_ada', display: 'Ada', email: 'ada@acme.test', roles: ['owner'], teams: ['engineering'] }));
export const bob = sess(humanActor({ id: 'usr_bob', display: 'Bob', email: 'bob@acme.test', roles: ['reviewer'], teams: ['product'] }));
export const vic = sess(humanActor({ id: 'usr_vic', display: 'Vic', roles: ['viewer'] }));

/**
 * ctx.governance, with approve / resolveDecision filling in the version the
 * person "looked at" (the current headSha) when a test does not say. Tests
 * about pinning call the real service directly.
 */
export function G(app) {
  const gov = app.ctx.governance;
  return new Proxy(gov, {
    get(target, prop) {
      if (prop === 'approve') {
        return async (id, actor, opts = {}) => target.approve(id, actor, { headSha: (await target.getProposal(id))?.headSha, ...opts });
      }
      if (prop === 'resolveDecision') {
        return async (id, actor, opts = {}) => {
          const d = await target.getDecision(id);
          const p = d ? await target.getProposal(d.proposalId) : null;
          return target.resolveDecision(id, actor, { headSha: p?.headSha, ...opts });
        };
      }
      return target[prop];
    },
  });
}

export function fakeIngest() {
  const jobs = [];
  return {
    jobs,
    async enqueue(spec) { const job = { id: newId('job'), status: 'queued', ...spec }; jobs.push(job); return job; },
    async get(id) { return jobs.find((j) => j.id === id) || null; },
    async list() { return jobs; },
    async start() {},
    async stop() {},
  };
}

export async function govApp(repoRoot, { overrides = {}, ingest = fakeIngest(), modules = {} } = {}) {
  const app = await makeApp({
    repoRoot,
    real: ['governance'],
    modules: { ingest: { create: async () => ingest }, ...modules },
    overrides,
  });
  app.ingest = ingest;
  return app;
}

const ALPHA_SOURCES = `sources:
  - id: alpha-pdf
    path: brain/raw/extracted/alpha.pdf.txt
    sha256: "3b50e003ca81fc8afceca1f8d8a259adfd2a3940144e429640ee160e4f8677d9"
    title: "Alpha System Overview"`;

export function page({ title, body, tier = 'curated', owner = '', extra = '' }) {
  return `---
title: "${title}"
type: topic
tier: ${tier}
origin: source
status: draft
confidence: high
tags: [alpha]
aliases: []
owner: "${owner}"
date_created: "2026-01-01"
date_modified: "2026-01-06"
last_verified: "2026-01-06"
${ALPHA_SOURCES}
related:
  - "[[beta]]"
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
${extra}---

${body}
`;
}

/**
 * Commit `files` (path → content, or null to delete) on `branch` in its own
 * worktree, the way the ingest runner would. Returns { branch, worktree, baseSha, headSha }.
 */
export async function proposalBranch(app, branch, files, { message = 'ingest' } = {}) {
  const g = app.ctx.git;
  const baseSha = await g.revParse('main');
  const worktree = await g.worktreeAdd(branch);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(worktree, rel);
    if (content === null) fs.rmSync(abs, { force: true });
    else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); }
  }
  const headSha = await g.commitAll(worktree, { message, author: { name: 'svc:ingest', email: 'ingest@almagest.local' } });
  return { branch, worktree, baseSha, headSha };
}

export function job(branch, extra = {}) {
  return {
    id: newId('job'), kind: 'ingest', branch,
    source: { kind: 'local', id: 'alpha-pdf', path: 'brain/raw/alpha.pdf', title: 'Q3 board deck', sha256: 'abcdef1234' },
    requestedBy: 'agent:claude-code', ...extra,
  };
}

export const CLEAN_AUDIT = { exit: 0, errors: 0, warnings: 0, findings: [] };

export const ALPHA_V2 = page({
  title: 'Alpha System',
  body: `## Summary

Alpha is the scheduling subsystem inside [[beta]].

## Details

The scheduler retries on a fixed 45-second backoff. [source: alpha-pdf, p.3]

Alpha ships with an overview document. [source: alpha-pdf, p.1]

## Open questions

- What is the ceiling under load? [source: unknown]`,
});

export const DELTA = page({
  title: 'Delta',
  body: `## Summary

Delta is new.

## Details

Delta relies on the Alpha overview. [source: alpha-pdf, p.1]`,
});

export { git };

/** fetch with a cookie jar and no redirect following. */
export function client(base) {
  const jar = new Map();
  async function req(method, p, { form, json, headers = {} } = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (form) { h['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    if (json) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
    const res = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (/Max-Age=0/.test(c)) jar.delete(k); else jar.set(k, v);
    }
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location') };
  }
  const csrfFrom = (htmlText) => (htmlText.match(/name="csrf" value="([^"]+)"/) || [])[1];
  return { jar, req, get: (p, o) => req('GET', p, o), post: (p, o) => req('POST', p, o), csrfFrom };
}
