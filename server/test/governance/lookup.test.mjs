import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { describe as describeProposal, lookupQuestionOf } from '../../src/governance/summary.mjs';
import { gapsPage } from '../../src/governance/web/views.mjs';
import { ALPHA_V2, CLEAN_AUDIT, cleanup, client, DELTA, govApp, job, proposalBranch, repo } from './fixtures.mjs';

const LOOKUP_NOTE = 'Fetched by live lookup: someone asked a question the brain could not answer.';
let saved;
const live = [];
before(() => { saved = process.env.ALMAGEST_TOKENS; process.env.ALMAGEST_TOKENS = 'ada:owner:ada-secret-1'; process.env.ALMAGEST_LOGINS = 'ada:ada-signin-1'; process.env.ALMAGEST_SECRET_KEY = 'test-secret'; });
after(async () => {
  for (const a of live) await a.stop().catch(() => {});
  process.env.ALMAGEST_TOKENS = saved;
  cleanup();
});

async function proposalFor(jobExtra) {
  const app = await govApp(repo(), { overrides: { service: { http: { port: 0 } } } });
  const server = await app.start();
  live.push(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const b = await proposalBranch(app, 'ingest/q3-board-deck-abcdef1', { 'brain/wiki/alpha.md': ALPHA_V2, 'brain/wiki/delta.md': DELTA });
  const p = await app.ctx.governance.createFromJob(job(b.branch, jobExtra), { ...b, audit: CLEAN_AUDIT });
  const c = client(base);
  const form = await c.get('/inbox/login');
  await c.post('/inbox/login', { form: { csrf: c.csrfFrom(form.text), secret: 'ada-signin-1', next: '/inbox' } });
  return { app, c, p };
}

const asked = (q) => `Asked: "${q}". Fetched by live lookup.`;

describe('proposals that live lookup queued', () => {
  it('says so, and shows the question when instructions carry it', async () => {
    const { c, p } = await proposalFor({ trigger: 'lookup', instructions: asked('what is the grid fee?') });
    assert.equal(p.trigger, 'lookup');
    assert.equal(p.lookupQuestion, 'what is the grid fee?');
    const text = (await c.get(`/inbox/p/${p.id}`)).text;
    assert.ok(text.includes(LOOKUP_NOTE));
    assert.match(text, /The question was “what is the grid fee\?”\./);
  });

  it('says so without a question when queries are not stored plain', async () => {
    const { c, p } = await proposalFor({ trigger: 'lookup', instructions: 'Fetched by live lookup to answer a question asked in a chat.' });
    assert.equal(p.lookupQuestion, undefined);
    const text = (await c.get(`/inbox/p/${p.id}`)).text;
    assert.ok(text.includes(LOOKUP_NOTE));
    assert.ok(!text.includes('The question was'));
  });

  it('escapes a question that contains markup', async () => {
    const evil = '<script>alert(1)</script> <img src=x onerror=alert(2)>';
    const { c, p } = await proposalFor({ trigger: 'lookup', instructions: asked(evil) });
    const text = (await c.get(`/inbox/p/${p.id}`)).text;
    assert.ok(!text.includes('<script>alert(1)'));
    assert.ok(!text.includes('<img src=x'));
    assert.ok(text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  });

  it('leaves other proposals unchanged', async () => {
    const { c, p } = await proposalFor({ trigger: 'watch', instructions: asked('ignored: not a lookup job') });
    assert.equal(p.trigger, 'watch');
    assert.equal(p.lookupQuestion, undefined);
    const text = (await c.get(`/inbox/p/${p.id}`)).text;
    assert.ok(!text.includes('live lookup'));
  });

  it('adds the same words to the summary Slack and email use, and only for lookup', () => {
    const base = { source: { title: 'Q3 board deck' }, changes: [] };
    assert.ok(!describeProposal(base).sentence.includes('live lookup'));
    assert.equal(describeProposal(base).lookup, '');
    const l = describeProposal({ ...base, trigger: 'lookup' });
    assert.equal(l.lookup, LOOKUP_NOTE);
    assert.match(l.sentence, /from “Q3 board deck” · fetched by live lookup/);
    assert.equal(lookupQuestionOf({ trigger: 'manual', instructions: asked('x') }), '');
  });
});

describe('gaps page', () => {
  const render = (items) => String(gapsPage({ items, actor: { id: 'ada', display: 'Ada' }, csrf: 'c', nonce: 'n', now: Date.parse('2026-06-02T00:00:00Z') }));
  const gap = (lookup) => ({ representative: 'grid fee', count: 4, distinctSessions: 2, lastSeen: '2026-06-01T00:00:00Z', queries: [], suggestion: 'Suggestion text.', lookup });

  it('shows what lookup did, in plain words, and nothing for a gap without it', () => {
    const served = render([gap({ served: 4, lastStep: 'connectors', connectors: ['team-drive'], jobs: ['job_1'] })]);
    assert.match(served, /Answered 4 times by looking it up live from team-drive\. The document has been sent for review\./);
    assert.match(render([gap({ served: 2, lastStep: 'staged', connectors: [], jobs: [] })]), /from documents waiting for review\. Nothing has been sent for review\./);
    assert.ok(!render([gap(null)]).includes('looking it up live'));
    assert.ok(!render([gap({ served: 0, lastStep: null, connectors: [], jobs: [] })]).includes('looking it up live'));
  });

  it('escapes connector names', () => {
    const out = render([gap({ served: 1, lastStep: 'connectors', connectors: ['<b>x</b>'], jobs: [] })]);
    assert.ok(!out.includes('<b>x</b>'));
    assert.ok(out.includes('&lt;b&gt;x&lt;/b&gt;'));
  });
});
