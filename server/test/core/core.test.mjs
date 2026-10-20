import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { agentActor, assertCanApprove, humanActor, parseTokens, serviceActor } from '../../src/core/auth.mjs';
import { deepMerge, expandEnv, loadServiceConfig } from '../../src/core/config.mjs';
import { createGit } from '../../src/core/git.mjs';
import { createRouter } from '../../src/core/http.mjs';
import { ingestBranch, newId, seal, unseal, validateRunReport } from '../../src/core/schemas.mjs';
import { makeApp, makeTempRepo, rmrf } from '../helpers.mjs';

const repos = [];
after(() => repos.forEach(rmrf));
function repo(opts) { const r = makeTempRepo(opts); repos.push(r); return r; }

describe('config', () => {
  it('fills profile defaults without branching on the name', () => {
    const r = repo();
    const solo = loadServiceConfig(r);
    assert.equal(solo.profile, 'solo');
    assert.equal(solo.service.store.driver, 'sqlite');
    assert.equal(solo.governance.separation_of_duties, false);
    const ent = loadServiceConfig(r, { overrides: { service: { profile: 'enterprise' } }, env: { DATABASE_URL: 'postgres://x' } });
    assert.equal(ent.service.store.driver, 'postgres');
    assert.equal(ent.service.store.url, 'postgres://x');
    assert.equal(ent.governance.separation_of_duties, true);
  });

  it('expands ${VAR:-default} and replaces arrays when merging', () => {
    assert.equal(expandEnv('${NOPE:-fallback}/${HOME_X}', { HOME_X: 'h' }), 'fallback/h');
    assert.deepEqual(deepMerge({ a: [1, 2], b: { c: 1 } }, { a: [3], b: { d: 2 } }), { a: [3], b: { c: 1, d: 2 } });
  });

  it('maps v1 sources.remote onto connectors', () => {
    const r = repo();
    const cfgPath = path.join(r, 'brain.config.yaml');
    const YAML_REMOTE = '  remote:\n    - provider: github\n      repo: acme/docs\n      paths: ["**/*.md"]\n';
    const text = fs.readFileSync(cfgPath, 'utf-8').replace(/^\s*remote:.*$/m, '').replace(/^sources:\s*$/m, `sources:\n${YAML_REMOTE}`);
    fs.writeFileSync(cfgPath, text.includes('sources:') ? text : `${text}\nsources:\n${YAML_REMOTE}`);
    const c = loadServiceConfig(r);
    assert.equal(c.sources.connectors.length, 1);
    assert.equal(c.sources.connectors[0].recipe, 'github');
    assert.equal(c.sources.connectors[0].fromV1Remote, true);
  });
});

describe('auth', () => {
  it('only a human with an approver role can approve — no exceptions', () => {
    const owner = humanActor({ id: 'usr_a', roles: ['owner'] });
    assert.doesNotThrow(() => assertCanApprove(owner));
    assert.throws(() => assertCanApprove(humanActor({ id: 'usr_v', roles: ['viewer'] })), /approver role/);
    assert.throws(() => assertCanApprove(agentActor('claude-code', owner)), /cannot approve/);
    assert.throws(() => assertCanApprove(serviceActor('ingest')), /cannot approve/);
    assert.throws(() => assertCanApprove(null), /authenticated/);
  });

  it('parses the token spec', () => {
    const [t] = parseTokens('ada:owner,reviewer:s3:cret');
    assert.equal(t.secret, 's3:cret');
    assert.deepEqual(t.actor.roles, ['owner', 'reviewer']);
    assert.throws(() => parseTokens('broken'), /malformed/);
  });
});

describe('schemas', () => {
  it('ids sort by time', () => {
    assert.ok(newId('job', 1000) < newId('job', 2000));
  });

  it('seals secrets', () => {
    const s = seal('tok', 'key');
    assert.equal(unseal(s, 'key'), 'tok');
    assert.throws(() => unseal(s, 'other'));
  });

  it('validates run reports and names every problem', () => {
    assert.equal(validateRunReport({ source: { id: 'x' }, outcome: 'written' }).pages.length, 0);
    assert.throws(
      () => validateRunReport({ outcome: 'nope', blocked: [{ kind: 'contradiction' }] }),
      (e) => e.problems.length === 4,
    );
  });

  it('branch names follow ingest/<slug>-<sha7>', () => {
    assert.equal(ingestBranch({ title: 'Q3 Board Deck.pdf', sha256: 'abcdef1234' }), 'ingest/q3-board-deck-pdf-abcdef1');
  });
});

describe('http', () => {
  it('routes, extracts params, enforces auth level', async () => {
    const human = humanActor({ id: 'usr_a', roles: ['owner'] });
    const agent = agentActor('x');
    const auth = { authenticate: async (req) => ({ h: human, a: agent })[req.headers['x-who']] || null };
    const r = createRouter({ auth });
    r.route('GET', '/p/:id', async (_q, _s, { params }) => ({ id: params.id }), { auth: 'human' });
    const server = await r.listen({ port: 0 });
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.equal((await fetch(`${base}/p/1`)).status, 401);
      assert.equal((await fetch(`${base}/p/1`, { headers: { 'x-who': 'a' } })).status, 403);
      const ok = await fetch(`${base}/p/42`, { headers: { 'x-who': 'h' } });
      assert.deepEqual(await ok.json(), { id: '42' });
      assert.equal((await fetch(`${base}/missing`)).status, 404);
    } finally {
      server.close();
    }
  });
});

describe('git', () => {
  it('creates worktrees off main without touching the main checkout', async () => {
    const r = repo();
    const g = createGit({ repoRoot: r });
    const wt = await g.worktreeAdd('ingest/test-1234567');
    assert.equal(await g.currentBranch(r), 'main');
    assert.equal(await g.currentBranch(wt), 'ingest/test-1234567');
    fs.writeFileSync(path.join(wt, 'brain', 'wiki', 'new.md'), '# new\n');
    const sha = await g.commitAll(wt, { message: 'add', author: { name: 'A', email: 'a@a' } });
    assert.ok(sha);
    assert.equal(await g.commitAll(wt, { message: 'noop', author: { name: 'A', email: 'a@a' } }), null);
    const changes = await g.diffNames('main', 'ingest/test-1234567', ['brain/wiki']);
    assert.deepEqual(changes, [{ status: 'A', path: 'brain/wiki/new.md' }]);
    assert.equal(await g.show('main', 'brain/wiki/new.md'), null);
    assert.equal(await g.worktreeAdd('ingest/test-1234567'), wt);
  });
});

describe('app', () => {
  it('boots with every module stubbed and serves /healthz', async () => {
    const app = await makeApp({ repoRoot: repo(), overrides: { service: { http: { port: 0 } } } });
    const server = await app.start();
    const res = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
    assert.deepEqual(await res.json(), { ok: true, profile: 'solo' });
    await assert.rejects(() => app.ctx.governance.approve('prp_x'), /not implemented/);
    await app.stop();
  });
});

describe('snapshot', () => {
  it('reads main even when the checkout is on another branch, and follows main', async () => {
    const r = repo();
    const app = await makeApp({ repoRoot: r });
    const { git, snapshot } = app.ctx;
    const before = (await snapshot.load()).pages.map((p) => p.slug);
    const wt = await git.worktreeAdd('ingest/x-1234567');
    fs.writeFileSync(path.join(wt, 'brain', 'wiki', 'delta.md'), fs.readFileSync(path.join(wt, 'brain', 'wiki', 'alpha.md'), 'utf-8').replace(/title: .*/, 'title: "Delta"'));
    await git.commitAll(wt, { message: 'delta', author: { name: 'A', email: 'a@a' } });
    assert.deepEqual((await snapshot.load()).pages.map((p) => p.slug), before);
    await git.run(['merge', '--ff-only', 'ingest/x-1234567']);
    await snapshot.refresh();
    assert.ok((await snapshot.load()).pages.some((p) => p.slug === 'delta'));
    await app.stop();
  });
});

describe('app start', () => {
  it('background: false starts neither the ingest runner nor telemetry timers (almagest mcp)', async () => {
    const started = [];
    const spy = (name) => ({ create: async () => ({ start: async () => { started.push(name); }, stop: async () => {} }), commands: {} });
    const app = await makeApp({ repoRoot: repo(), modules: { ingest: spy('ingest'), telemetry: spy('telemetry') } });
    await app.start({ http: false, background: false });
    assert.deepEqual(started, []);
    await app.start({ http: false });
    assert.deepEqual(started.sort(), ['ingest', 'telemetry']);
    await app.stop();
  });
});
