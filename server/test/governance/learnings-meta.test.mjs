/**
 * The front matter fields of a learning that carry meaning are shown open in
 * the inbox, next to the body, not inside the collapsed "Page details".
 */
import assert from 'node:assert/strict';
import { after, it } from 'node:test';

import { proposalPage } from '../../src/governance/web/views.mjs';
import { seedFiles } from '../ingest/_synthesis.mjs';
import { ada, CLEAN_AUDIT, cleanup, G, govApp, job, proposalBranch, repo } from './fixtures.mjs';

after(cleanup);

const NOT_READY = { ready: false, blockers: [], missing: [], explanation: '' };
const view = (p) => String(proposalPage({ proposal: p, decisions: [], evaluation: NOT_READY, actor: ada, csrf: 'c', nonce: 'n', canAct: { ok: true, canReview: true, why: '' } }));
const withoutDetails = (html) => html.replace(/<details[\s\S]*?<\/details>/g, '');

const page = `---
title: "Delta and Epsilon retry differently"
type: claim
tier: curated
origin: self
status: draft
confidence: high
tags: ["retries", "<b>bold</b>"]
aliases: ["Retry difference", "Alias two"]
owner: ""
date_created: "2026-01-05"
date_modified: "2026-01-05"
last_verified: "2026-01-05"
sources: []
related: ["[[alpha]]"]
relations:
  supports: ["[[delta]]"]
  contradicts: []
  supersedes: []
  depends_on: ["[[epsilon]]"]
---

## Summary

Body text.

## Basis

- [[delta]]
- [[epsilon]]
`;

it('shows title, aliases, tags, confidence, related and relations open', async () => {
  const app = await govApp(repo({ files: seedFiles() }));
  const b = await proposalBranch(app, 'ingest/learnings_abc1234', { 'brain/wiki/one.md': page });
  const p = await G(app).createFromJob(job(b.branch, { kind: 'synthesize', source: null, trigger: 'synthesis' }), { ...b, audit: CLEAN_AUDIT });
  const open = withoutDetails(view(p));
  assert.match(open, /Retry difference/);
  assert.match(open, /Alias two/);
  assert.match(open, /retries/);
  assert.match(open, /Confidence<\/dt>\s*<dd>High/i);
  assert.match(open, /alpha/);
  assert.match(open, /Supports/);
  assert.match(open, /Depends on/);
  assert.match(open, /delta/);
  assert.ok(!open.includes('<b>bold</b>'), 'a tag is text, never markup');
  assert.match(open, /&lt;b&gt;bold&lt;\/b&gt;/);
  await app.stop();
});
