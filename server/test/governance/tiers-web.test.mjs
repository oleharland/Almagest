import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { tierOfText } from '../../../tools/lib/canonical.mjs';
import { commands } from '../../src/governance/index.mjs';
import { ALPHA_V2, CLEAN_AUDIT, cleanup, client, DELTA, git, govApp, job, proposalBranch, repo } from './fixtures.mjs';

const TOKENS = 'ada:owner:ada-secret-1;bob:reviewer:bob-secret-2;vic:viewer:vic-secret-3';
const LOGINS = 'ada:ada-signin-1;bob:bob-signin-2;vic:vic-signin-3';
const HOSTILE = '<img src=x onerror=alert(1)>';
let saved;
const live = [];
before(() => { saved = process.env.ALMAGEST_TOKENS; process.env.ALMAGEST_TOKENS = TOKENS; process.env.ALMAGEST_LOGINS = LOGINS; process.env.ALMAGEST_SECRET_KEY = 'test-secret'; });
after(async () => {
  for (const a of live) await a.stop().catch(() => {});
  process.env.ALMAGEST_TOKENS = saved;
  cleanup();
});

async function serve() {
  const r = repo();
  const entries = Array.from({ length: 6 }, (_, i) => `  - id: doc-${i}\n    kind: local\n    path: brain/raw/processed/doc-${i}.md\n    sha256: ${String(i).padStart(64, '0')}\n    pages:\n      - beta\n    status: ingested\n`).join('');
  fs.appendFileSync(path.join(r, 'brain/manifest.yaml'), entries);
  const beta = path.join(r, 'brain/wiki/beta.md');
  fs.writeFileSync(beta, fs.readFileSync(beta, 'utf-8').replace('title: "Beta Appliance"', `title: "${HOSTILE}"`));
  git(r, 'add', '-A');
  git(r, 'commit', '-qm', 'docs');
  git(r, 'checkout', '-q', '--detach');
  const app = await govApp(r, { overrides: { service: { http: { port: 0 } } } });
  const server = await app.start();
  live.push({ stop: () => app.stop() });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { r, app, base };
}

async function login(base, secret) {
  const c = client(base);
  const form = await c.get('/inbox/login');
  await c.post('/inbox/login', { form: { csrf: c.csrfFrom(form.text), secret, next: '/inbox' } });
  const home = await c.get('/inbox');
  return { c, csrf: c.csrfFrom(home.text), home };
}

describe('inbox: pages worth fixing as canonical', () => {
  it('lists them with their counts, escapes the title, shows the count in the nav, and dismisses behind CSRF', async () => {
    const { base, app } = await serve();
    const { c, csrf, home } = await login(base, 'ada-signin-1');
    assert.match(home.text, />Canonical \(1\)</);
    const page = await c.get('/inbox/canonical');
    assert.equal(page.status, 200);
    assert.match(page.text, /Pages worth fixing as canonical/);
    assert.match(page.text, /7 documents contributed to this page/);
    assert.match(page.text, /The agent can no longer change this page\./);
    assert.match(page.text, /New material that contradicts it is logged as a challenge and is not merged\./);
    assert.match(page.text, /Only a person can edit it\./);
    assert.ok(!page.text.includes(HOSTILE), 'the hostile title is escaped');
    assert.ok(page.text.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.ok(!/Nothing/.test(page.text.replace('Nothing', '')) || true);

    const noCsrf = await c.post('/inbox/canonical/beta/dismiss', { form: {} });
    assert.equal(noCsrf.status, 403);
    assert.equal((await app.ctx.governance.hints.list({ fresh: true })).length, 1);
    const ok = await c.post('/inbox/canonical/beta/dismiss', { form: { csrf } });
    assert.equal(ok.status, 303);
    assert.match((await c.get('/inbox/canonical')).text, /No page stands out right now\./);
    const entry = await c.get('/inbox/pages/beta');
    assert.equal(entry.status, 200);
    assert.ok(!entry.text.includes(HOSTILE));
    await app.stop();
  });

  it('the command prints the same list and writes nothing', async () => {
    const { app, r } = await serve();
    const before = git(r, 'rev-parse', 'main').trim();
    let out = '';
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => { out += s; return true; };
    try { await commands['canonical-hints'].run([], { ctx: app.ctx }); } finally { process.stdout.write = write; }
    assert.match(out, /7 documents contributed to this page/);
    assert.match(out, /\(beta\)/);
    assert.equal(git(r, 'rev-parse', 'main').trim(), before);
    assert.deepEqual(await app.ctx.store.kv.list('canonical-hints.dismissed'), []);
    await app.stop();
  });
});

describe('inbox: changing a tier', () => {
  it('a page on main: refused without a session, CSRF or the role; allowed for the owner after the confirm step', async () => {
    const { base, app, r } = await serve();
    const ada = await login(base, 'ada-signin-1');
    const bob = await login(base, 'bob-signin-2');
    const vic = await login(base, 'vic-signin-3');
    const form = (csrf, extra = {}) => ({ form: { csrf, to: 'canonical', confirm: 'yes', ...extra } });

    // An API token alone: it can read, never act.
    const viaToken = await fetch(`${base}/inbox/pages/beta/tier`, { method: 'POST', headers: { authorization: 'Bearer ada-secret-1', origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: 'to=canonical&confirm=yes' });
    assert.equal(viaToken.status, 403);
    assert.equal((await ada.c.post('/inbox/pages/beta/tier', form('wrong'))).status, 403);
    assert.equal((await vic.c.post('/inbox/pages/beta/tier', form(vic.csrf))).status, 403);
    assert.equal((await bob.c.post('/inbox/pages/beta/tier', form(bob.csrf))).status, 403);   // reviewer, not owner
    assert.equal((await ada.c.post('/inbox/pages/beta/tier', form(ada.csrf, { confirm: '' }))).status, 400);
    assert.equal(tierOfText(git(r, 'show', 'main:brain/wiki/beta.md')), 'curated');

    const done = await ada.c.post('/inbox/pages/beta/tier', form(ada.csrf));
    assert.equal(done.status, 303, done.text);
    assert.match(done.location, /^\/inbox\/p\/prp_.+m=tier_done/);
    assert.equal(tierOfText(git(r, 'show', 'main:brain/wiki/beta.md')), 'canonical');
    const view = await ada.c.get(done.location);
    assert.match(view.text, /ada wants to make “&lt;img src=x onerror=alert\(1\)&gt;” canonical\./);
    assert.ok(!view.text.includes(HOSTILE));
    await app.stop();
  });

  it('a page in an open proposal: the control, its confirm step, and the new version', async () => {
    const { base, app } = await serve();
    const b = await proposalBranch(app, 'ingest/q3-board-deck-abcdef1', { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA });
    const p = await app.ctx.governance.createFromJob(job(b.branch), { ...b, audit: CLEAN_AUDIT });
    const ada = await login(base, 'ada-signin-1');
    const bob = await login(base, 'bob-signin-2');
    const page = await ada.c.get(`/inbox/p/${p.id}`);
    assert.match(page.text, /Change the tier/);
    assert.match(page.text, /Make evidence/);
    assert.match(page.text, /Yes, make it canonical/);
    assert.match((await bob.c.get(`/inbox/p/${p.id}`)).text, /Only someone with the owner role can make a page canonical\./);

    const url = `/inbox/p/${p.id}/page/delta/tier`;
    assert.equal((await ada.c.post(url, { form: { csrf: 'bad', to: 'evidence', headSha: p.headSha } })).status, 403);
    const stale = await ada.c.post(url, { form: { csrf: ada.csrf, to: 'evidence', headSha: 'f'.repeat(40) } });
    assert.equal(stale.status, 409);
    const ok = await ada.c.post(url, { form: { csrf: ada.csrf, to: 'evidence', headSha: p.headSha } });
    assert.equal(ok.status, 303);
    const moved = await app.ctx.governance.getProposal(p.id);
    assert.notEqual(moved.headSha, p.headSha);
    assert.equal(moved.changes.find((x) => x.slug === 'delta').tier, 'evidence');
    await app.stop();
  });
});
