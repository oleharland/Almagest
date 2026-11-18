/**
 * What a person sees before approving a learning, and which proposals a
 * learnings proposal can be replaced by.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { escapeHtml } from '../../src/governance/html.mjs';
import { proposalPage } from '../../src/governance/web/views.mjs';
import { seedFiles, sourcePage } from '../ingest/_synthesis.mjs';
import { ada, CLEAN_AUDIT, cleanup, G, govApp, job, proposalBranch, repo } from './fixtures.mjs';

after(cleanup);

const NOT_READY = { ready: false, blockers: [], missing: [], explanation: '' };
const view = (p) => String(proposalPage({ proposal: p, decisions: [], evaluation: NOT_READY, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true, why: '' } }));

async function brain() {
  const r = repo({ files: seedFiles() });
  return govApp(r);
}

const front = (title) => `---
title: ${JSON.stringify(title)}
type: claim
tier: curated
origin: self
status: draft
confidence: medium
tags: []
aliases: []
owner: ""
date_created: "2026-01-05"
date_modified: "2026-01-05"
last_verified: "2026-01-05"
sources: []
related: []
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---
`;

/** A learning with several sections, a long middle and markup in its text. */
function longLearning(title, marker) {
  const middle = Array.from({ length: 60 }, (_, i) => `${marker} paragraph ${i}: Delta and Epsilon retry in different ways, line ${i}.`).join('\n\n');
  return `${front(title)}
## Summary

${marker} summary line.

## Argument

${middle}

## Caveat

${marker} <img src=x onerror=alert(1)> and <script>alert(2)</script> & "quotes" at the very end.

## Basis

- [[delta]]
- [[epsilon]]
`;
}

async function learningsProposal(app, files, name = 'abc1234') {
  const b = await proposalBranch(app, `ingest/learnings-${name}`, files);
  const p = await G(app).createFromJob(job(b.branch, { kind: 'synthesize', source: null, trigger: 'synthesis' }), { ...b, audit: CLEAN_AUDIT });
  return { ...b, p };
}

describe('the inbox shows every learning whole', () => {
  it('every line of every learning body is on the page, in order, with no cut', async () => {
    const app = await brain();
    const one = longLearning('Delta and Epsilon retry differently', 'FIRST');
    const two = longLearning('Alpha and Delta agree on retries', 'SECOND');
    assert.ok(one.length > 4000, 'longer than the old 1500 character cut');
    const { p } = await learningsProposal(app, { 'brain/wiki/one.md': one, 'brain/wiki/two.md': two });
    const text = view(p);
    for (const [name, body] of [['one', one], ['two', two]]) {
      const lines = body.split('\n---\n')[1].split('\n').map((l) => l.trim()).filter(Boolean);
      let from = 0;
      for (const line of lines) {
        const at = text.indexOf(escapeHtml(line), from);
        assert.notEqual(at, -1, `${name}: line missing or out of order: ${line}`);
        from = at;
      }
    }
    assert.ok(!text.includes('<script>alert(2)'), 'a learning is text, never markup');
    assert.ok(!text.includes('<img src=x'));
    await app.stop();
  });

  it('shows the learning when it has no citation, and says nothing was cut', async () => {
    const app = await brain();
    const { p } = await learningsProposal(app, { 'brain/wiki/one.md': longLearning('Delta and Epsilon retry differently', 'ONLY') });
    const text = view(p);
    assert.match(text, /ONLY paragraph 59/);
    assert.doesNotMatch(text, /the start only/);
    await app.stop();
  });
});

describe('a proposal replaces only one of the same kind', () => {
  const sourceOf = (title) => ({ kind: 'chat', id: title, title, sha256: 'feed0000001' });

  it('a chat source titled like the learnings source does not close an open learnings proposal', async () => {
    const app = await brain();
    const main = (await app.ctx.git.revParse('main')).slice(0, 7);
    const { p } = await learningsProposal(app, { 'brain/wiki/one.md': longLearning('Delta and Epsilon retry differently', 'X') }, main);
    // What the chat tool derives from a title: its slug, `learnings-<sha7>`.
    const b = await proposalBranch(app, 'ingest/chat-0000001', { 'brain/wiki/other.md': sourcePage({ title: 'Other', sourceId: 'beta-pdf' }) });
    const other = await G(app).createFromJob(job(b.branch, { source: sourceOf(`learnings-${main}`) }), { ...b, audit: CLEAN_AUDIT });
    assert.equal(other.status, 'open');
    assert.equal((await G(app).getProposal(p.id)).status, 'open', 'the learnings proposal stays open');
    await app.stop();
  });

  it('a learnings proposal does not close a chat proposal that has the same source id', async () => {
    const app = await brain();
    const main = (await app.ctx.git.revParse('main')).slice(0, 7);
    const b = await proposalBranch(app, 'ingest/chat-0000001', { 'brain/wiki/other.md': sourcePage({ title: 'Other', sourceId: 'beta-pdf' }) });
    const other = await G(app).createFromJob(job(b.branch, { source: sourceOf(`learnings-${main}`) }), { ...b, audit: CLEAN_AUDIT });
    await learningsProposal(app, { 'brain/wiki/one.md': longLearning('Delta and Epsilon retry differently', 'X') }, main);
    assert.equal((await G(app).getProposal(other.id)).status, 'open', 'the chat proposal stays open');
    await app.stop();
  });

  it('the synthetic source id is one a slugified title cannot produce', async () => {
    const app = await brain();
    const { p } = await learningsProposal(app, { 'brain/wiki/one.md': longLearning('Delta and Epsilon retry differently', 'X') });
    assert.match(p.source.id, /^learnings_[0-9a-f]{7}$/);
    const { slugify } = await import('../../src/core/schemas.mjs');
    assert.notEqual(slugify(p.source.id), p.source.id);
    assert.ok(!/_/.test(slugify('learnings_abc1234 _ ~ anything')));
    await app.stop();
  });

  it('a newer learnings proposal still replaces an older open one', async () => {
    const app = await brain();
    const a = await learningsProposal(app, { 'brain/wiki/one.md': longLearning('Delta and Epsilon retry differently', 'X') }, 'abc1234');
    const b = await learningsProposal(app, { 'brain/wiki/two.md': longLearning('Alpha and Delta agree on retries', 'Y') }, 'abc1234b');
    assert.equal((await G(app).getProposal(a.p.id)).status, 'superseded');
    assert.equal((await G(app).getProposal(b.p.id)).status, 'open');
    await app.stop();
  });
});
