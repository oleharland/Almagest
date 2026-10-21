/**
 * The github-pr channel against a simulated GitHub: a local bare repo is the
 * remote, a second clone of it plays GitHub's merge button, and a local HTTP
 * sink stands in for the REST API. Local main may move only to a merge commit
 * Almagest has checked itself — never because GitHub said so.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { runAuditIndex } from '../../src/governance/merge.mjs';
import { proposalPage } from '../../src/governance/web/views.mjs';
import { ALPHA_V2, CLEAN_AUDIT, cleanup, DELTA, git, govApp, job, proposalBranch, repo, repos } from './fixtures.mjs';

const ENV = { ALMAGEST_SECRET_KEY: 'test-secret', ALMAGEST_TOKENS: 'ada:owner:ada-secret-1', T_GH_SECRET: 'gh-hook' };
const saved = {};
const open = [];
before(() => { for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; } });
after(async () => {
  for (const close of open.splice(0)) await close().catch(() => {});
  for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  cleanup();
});

const OCTO = { octo: { id: 'usr_ada', display: 'Ada', roles: ['owner'] } };
const BRANCH = 'ingest/q3-board-deck-abcdef1';
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `almagest-${name}-`)); repos.push(d); return d; };

/** GitHub's REST API, as far as the channel uses it. */
async function fakeApi() {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ number: 7, html_url: 'https://github.test/acme/brain/pull/7' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  open.push(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

/** A service whose remote is a bare repo, with one open proposal already pushed to it. */
async function setup({ users = OCTO, files = { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA } } = {}) {
  const r = repo();
  const bare = tmp('remote');
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(r, 'push', '-q', bare, 'main');
  const app = await govApp(r, {
    overrides: {
      service: { http: { port: 0 }, git: { remote: bare } },
      governance: { channels: [{ kind: 'web' }, { kind: 'github-pr', repo: 'acme/brain', api_url: await fakeApi(), webhook_secret_env: 'T_GH_SECRET', users }] },
    },
  });
  const server = await app.start();
  open.push(() => app.stop());
  const b = await proposalBranch(app, BRANCH, files);
  // The ingest runner leaves brain/.index current on the branch; so does this.
  assert.equal((await runAuditIndex(b.worktree)).code, 0);
  b.headSha = (await app.ctx.git.commitAll(b.worktree, { message: 'index', author: { name: 'svc:ingest', email: 'ingest@almagest.local' } })) || b.headSha;
  const p = await app.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
  await app.ctx.bus.drain();
  assert.equal(git(bare, 'rev-parse', `refs/heads/${BRANCH}`).trim(), p.headSha, 'the proposal branch was pushed');

  // "GitHub": a clone of the remote where pull requests get merged.
  const gh = tmp('github');
  git(gh, 'clone', '-q', bare, '.');
  git(gh, 'fetch', '-q', 'origin', `${BRANCH}:${BRANCH}`);
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/channels/github/webhook`, {
    method: 'POST',
    headers: {
      'x-github-event': 'pull_request', 'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', ENV.T_GH_SECRET).update(body).digest('hex')}`,
    },
    body,
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
  const read = (route) => fetch(`${base}${route}`, { headers: { authorization: 'Bearer ada-secret-1' } }).then((res) => res.json());
  return { app, p, bare, gh, post, read, main: () => app.ctx.git.revParse('main') };
}

function write(dir, rel, content) {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
}

/** Merge the PR on "GitHub" the normal way (a merge commit), with optional extra edits folded into it. */
async function ghMerge(gh, { edit = null } = {}) {
  git(gh, 'checkout', '-q', 'main');
  git(gh, 'merge', '-q', '--no-ff', '--no-commit', BRANCH);
  if (edit) { await edit(gh); git(gh, 'add', '-A'); }
  git(gh, 'commit', '-q', '-m', 'Merge pull request #7 from acme/ingest');
  git(gh, 'push', '-q', 'origin', 'main');
  return git(gh, 'rev-parse', 'HEAD').trim();
}

function prEvent(p, { sha, login = 'octo', head = p.headSha, repoName = 'acme/brain', baseRef = 'main', merged = true } = {}) {
  return JSON.stringify({
    action: 'closed',
    pull_request: {
      number: 7, merged, merge_commit_sha: sha,
      head: { ref: p.branch, sha: head, repo: { full_name: repoName } },
      base: { ref: baseRef, repo: { full_name: 'acme/brain' } },
      merged_by: { login },
    },
    sender: { login },
  });
}

describe('github-pr: local main follows only a merge Almagest verified', () => {
  it('valid: local main moves to merge_commit_sha, after the audit ran', async () => {
    const { app, p, gh, post, main } = await setup();
    const before0 = await main();
    // The remote's tip moves past the merge commit: main must follow the merge commit, not the tip.
    const sha = await ghMerge(gh);
    write(gh, 'brain/wiki/unreviewed.md', '# pushed straight to main on GitHub\n');
    git(gh, 'add', '-A');
    git(gh, 'commit', '-q', '-m', 'direct push');
    git(gh, 'push', '-q', 'origin', 'main');

    const out = await post(prEvent(p, { sha }));
    assert.equal(out.status, 200);
    assert.equal(out.json.status, 'merged');
    assert.equal(out.json.accepted, true);
    assert.equal(await main(), sha);
    assert.notEqual(sha, before0);
    const merged = await app.ctx.governance.getProposal(p.id);
    assert.equal(merged.merge.accepted, true);
    assert.equal(merged.merge.audit.exit, 0, 'the service re-ran the audit on the merge commit');
    assert.equal(merged.approvals[0].channel, 'github-pr');
  });

  it('policy not met (unmapped merger): main does not move, the proposal is marked not accepted', async () => {
    const { app, p, gh, post, read, main } = await setup({ users: {} });
    const before0 = await main();
    const sha = await ghMerge(gh);
    const out = await post(prEvent(p, { sha, login: 'mallory' }));
    // The API and the inbox say what happened, and why.
    const api = await read(`/api/proposals/${p.id}`);
    assert.equal(api.proposal.status, 'merged_unaccepted');
    assert.equal(api.proposal.merge.reason, 'policy');
    const decisions = await app.ctx.governance.listDecisions(p.id);
    const page = proposalPage({
      proposal: api.proposal, decisions, evaluation: (await app.ctx.governance.evaluate(p.id)).evaluation,
      actor: null, csrf: '', nonce: '', canAct: { ok: false, why: '' },
    }).value;
    assert.match(page, /Merged on GitHub, not accepted here/);
    assert.match(page, /mallory is not a reviewer/);
    assert.equal(out.json.status, 'merged_unaccepted');
    assert.equal(out.json.accepted, false);
    assert.equal(out.json.reason, 'policy');
    assert.equal(await main(), before0);
    const after1 = await app.ctx.governance.getProposal(p.id);
    assert.equal(after1.merge.accepted, false);
    assert.match(after1.merge.message, /mallory is not a reviewer/);
    assert.equal(after1.approvals.length, 0);
    const [v] = await app.ctx.store.audit.list({ action: 'policy.violation' });
    assert.equal(v.detail.code, 'policy');
    assert.ok(app.log.lines.some((l) => l.level === 'error' && /not accepted/.test(l.msg)));
    // Redelivered, or the same PR reported again: still not accepted.
    assert.equal((await post(prEvent(p, { sha, login: 'mallory' }))).json.status, 'merged_unaccepted');
    assert.equal(await main(), before0);
  });

  it('head mismatch (a commit pushed onto the branch on GitHub): main does not move', async () => {
    const { app, p, gh, post, main } = await setup();
    const before0 = await main();
    git(gh, 'checkout', '-q', BRANCH);
    write(gh, 'tools/audit.mjs', 'process.exit(0);\n');
    git(gh, 'add', '-A');
    git(gh, 'commit', '-q', '-m', 'tweak the gate');
    const head = git(gh, 'rev-parse', 'HEAD').trim();
    const sha = await ghMerge(gh);
    const out = await post(prEvent(p, { sha, head }));
    assert.equal(out.json.status, 'merged_unaccepted');
    assert.equal(out.json.reason, 'head');
    assert.equal(await main(), before0);
    assert.equal((await app.ctx.governance.getProposal(p.id)).approvals.length, 0);
  });

  it('the merge commit changes a file outside the knowledge base: main does not move', async () => {
    const { app, p, gh, post, main } = await setup();
    const before0 = await main();
    // Right parents, right head — but the merge commit itself carries an edit to the gate.
    const sha = await ghMerge(gh, { edit: (dir) => write(dir, 'tools/audit.mjs', 'process.exit(0);\n') });
    const out = await post(prEvent(p, { sha }));
    assert.equal(out.json.status, 'merged_unaccepted');
    assert.equal(out.json.reason, 'paths');
    assert.equal(await main(), before0);
    const after1 = await app.ctx.governance.getProposal(p.id);
    assert.ok(after1.mergeError.files.some((f) => f.path === 'tools/audit.mjs'));
  });

  it('the merge commit fails the audit: main does not move', async () => {
    const { app, p, gh, post, main } = await setup();
    const before0 = await main();
    const sha = await ghMerge(gh, { edit: async (dir) => { write(dir, 'brain/wiki/delta.md', `${DELTA}\nA claim cited to a source the page does not list. [source: nowhere, p.1]\n`); await runAuditIndex(dir); } });
    const out = await post(prEvent(p, { sha }));
    assert.equal(out.json.reason, 'audit');
    assert.equal(await main(), before0);
    const { mergeError } = await app.ctx.governance.getProposal(p.id);
    assert.equal(mergeError.audit.exit, 1);
    assert.ok(mergeError.audit.findings.some((f) => /^CITE-/.test(f.id) && f.severity === 'error'), JSON.stringify(mergeError.audit));
  });

  it('a squash merge cannot be verified: main does not move, it waits for a person', async () => {
    const { p, gh, post, main } = await setup();
    const before0 = await main();
    git(gh, 'checkout', '-q', 'main');
    git(gh, 'merge', '-q', '--squash', BRANCH);
    git(gh, 'commit', '-q', '-m', 'Squashed PR #7');
    git(gh, 'push', '-q', 'origin', 'main');
    const out = await post(prEvent(p, { sha: git(gh, 'rev-parse', 'HEAD').trim() }));
    assert.equal(out.json.status, 'merged_unaccepted');
    assert.equal(out.json.reason, 'shape');
    assert.equal(await main(), before0);
  });

  it('a fork PR with the same branch name, or a PR into another base, is ignored', async () => {
    const { app, p, gh, post, main } = await setup();
    const before0 = await main();
    const sha = await ghMerge(gh);
    const fork = await post(prEvent(p, { sha, repoName: 'mallory/brain' }));
    assert.match(fork.json.ignored, /not a pull request from this repository/);
    const closedFork = await post(prEvent(p, { sha, repoName: 'mallory/brain', merged: false }));
    assert.match(closedFork.json.ignored, /not a pull request from this repository/);
    const otherBase = await post(prEvent(p, { sha, baseRef: 'release' }));
    assert.match(otherBase.json.ignored, /not a pull request from this repository/);
    assert.equal((await app.ctx.governance.getProposal(p.id)).status, 'open');
    assert.equal(await main(), before0);
    assert.ok(app.log.lines.some((l) => l.level === 'warn' && /ignoring a pull request/.test(l.msg)));
    // Same repository, different letter case: that one is acted on.
    assert.equal((await post(prEvent(p, { sha, repoName: 'Acme/Brain' }))).json.status, 'merged');
  });
});

describe('snapshot: chats read the reviewed local main', () => {
  it('pins local main even when the remote main differs, and says so', async () => {
    const { app, gh, main } = await setup();
    git(gh, 'checkout', '-q', 'main');
    write(gh, 'brain/wiki/unreviewed.md', '# pushed straight to main on GitHub\n');
    git(gh, 'add', '-A');
    git(gh, 'commit', '-q', '-m', 'direct push');
    git(gh, 'push', '-q', 'origin', 'main');
    const remoteSha = git(gh, 'rev-parse', 'HEAD').trim();

    const sha = await app.ctx.snapshot.refresh({ fetch: true });
    assert.equal(sha, await main());
    assert.notEqual(sha, remoteSha);
    assert.equal(fs.existsSync(path.join(app.ctx.snapshot.dir, 'brain/wiki/unreviewed.md')), false);
    const warns = app.log.lines.filter((l) => l.level === 'warn' && /differs from local main/.test(l.msg));
    assert.equal(warns.length, 1);
    await app.ctx.snapshot.refresh({ fetch: true });
    assert.equal(app.log.lines.filter((l) => l.level === 'warn' && /differs from local main/.test(l.msg)).length, 1, 'warned once per pair');
  });
});
