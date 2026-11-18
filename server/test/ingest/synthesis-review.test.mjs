/**
 * What a learning may contain, and which existing lines of the log and the
 * index a learnings run may touch. A person approves a learning from what the
 * inbox shows, so the runner refuses anything the inbox cannot show whole.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { cleanup, setup } from './_setup.mjs';
import { seedFiles } from './_synthesis.mjs';

after(cleanup);

const today = new Date().toISOString().slice(0, 10);

const LOG = '# Log\n\n| Date | Action | Details |\n|------|--------|---------|\n| 2026-01-01 | ingest alpha | by Ada |\n| 2026-01-02 | reject beta | by Bob |\n';
const PLACEHOLDER_LOG = '# Log\n\n| Date | Action | Details |\n|------|--------|---------|\n| _(no actions yet)_ | | |\n';

async function brain(extra = {}, opts = {}) {
  const t = await setup({ files: { ...seedFiles(), ...extra }, ...opts });
  await t.app.start({ http: false });
  return t;
}

/** A learning as a page: `front` is extra front matter, `body` replaces the default sections. */
function learning({ title = 'Delta and Epsilon both retry', front = '', body = null } = {}) {
  return `---
title: ${JSON.stringify(title)}
type: claim
tier: curated
origin: self
status: draft
confidence: medium
tags: []
aliases: []
owner: ""
date_created: "${today}"
date_modified: "${today}"
last_verified: "${today}"
${front || 'sources: []'}
related: []
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

${body ?? `## Summary

${title}.

## Basis

- [[delta]]
- [[epsilon]]
`}`;
}

const PAGE = 'brain/wiki/delta-and-epsilon-both-retry.md';
const BETA_SOURCE = `sources:
  - id: beta-pdf
    path: brain/raw/extracted/beta.pdf.txt
    title: "Beta overview"`;
const BASIS = '## Basis\n\n- [[delta]]\n- [[epsilon]]\n';

async function run(t, files, kind = 'synthesize') {
  t.ctx.config.ingest.fake.synth = { pages: [], files, outcome: 'written' };
  const job = await t.ctx.ingest.enqueue({ kind, trigger: 'synthesis', requestedBy: 'svc:synthesis' });
  return t.finished(job);
}

async function refused(t, files, pattern, why) {
  const done = await run(t, files);
  assert.equal(done.status, 'failed', `${why}: the run must fail (got ${done.status} ${done.error || ''})`);
  assert.match(done.error, pattern, why);
  assert.match(done.error, /not committed/);
  assert.equal(t.governance.calls.length, 0, `${why}: no proposal`);
  return done;
}

describe('guardLearnings: a learning has no sources and no citations of its own', () => {
  it('refuses a learning that lists a source of its own', async () => {
    const t = await brain();
    await refused(t, { [PAGE]: learning({ front: BETA_SOURCE }) }, /learnings run wrote .*`sources` of its own/, 'sources list');
  });

  it('refuses a learning that cites another page\'s source, which also hid its text from the inbox', async () => {
    const t = await brain();
    const body = `## Summary\n\nDelta is certified for medical use. [source: beta-pdf, p.1]\n\n${BASIS}`;
    await refused(t, { [PAGE]: learning({ front: BETA_SOURCE, body }) }, /learnings run wrote .*(`sources` of its own|citation)/, 'source + citation');
  });

  it('refuses a citation even with an empty sources list', async () => {
    const t = await brain();
    const body = `## Summary\n\nDelta retries. [source: unknown]\n\n${BASIS}`;
    await refused(t, { [PAGE]: learning({ body }) }, /learnings run wrote .*citation/, 'citation');
  });

  it('refuses the literal "[source:" even when it is not a well formed citation', async () => {
    const t = await brain();
    const body = `## Summary\n\nDelta retries [source: beta-pdf page one and more].\n\n${BASIS}`;
    await refused(t, { [PAGE]: learning({ body }) }, /learnings run wrote .*citation/, 'malformed citation');
  });

  it('refuses a body longer than 8000 characters, with the limit in the message', async () => {
    const t = await brain();
    const body = `## Summary\n\n${'Delta and Epsilon both retry. '.repeat(300)}\n\n${BASIS}`;
    assert.ok(body.length > 8000);
    await refused(t, { [PAGE]: learning({ body }) }, /learnings run wrote .*8000 characters/, 'long body');
  });

  it('accepts a learning right at the limit', async () => {
    const t = await brain();
    const head = '## Summary\n\n';
    const tail = `\n\n${BASIS}`;
    const body = head + 'x'.repeat(8000 - head.length - tail.length) + tail;
    assert.equal(body.length, 8000);
    const done = await run(t, { [PAGE]: learning({ body }) });
    assert.equal(done.status, 'succeeded', done.error);
  });
});

describe('guardLearnings: earlier rows of the log and the index are not rewritten', () => {
  it('refuses a run that rewrites an existing log row', async () => {
    const t = await brain({ 'brain/log.md': LOG });
    await refused(t, {
      [PAGE]: learning(),
      'brain/log.md': LOG.replace('| 2026-01-01 | ingest alpha | by Ada |', '| 2026-01-01 | ingest alpha | by Mallory |'),
    }, /learnings run changed an existing line of brain\/log\.md/, 'changed log row');
  });

  it('refuses a run that deletes a log row', async () => {
    const t = await brain({ 'brain/log.md': LOG });
    await refused(t, { [PAGE]: learning(), 'brain/log.md': LOG.replace('| 2026-01-02 | reject beta | by Bob |\n', '') }, /learnings run changed an existing line of brain\/log\.md/, 'deleted log row');
  });

  it('refuses a run that changes an existing index row', async () => {
    const t = await brain();
    const index = t.show('main', 'brain/index.md');
    await refused(t, { [PAGE]: learning(), 'brain/index.md': index.replace('| [[alpha]] | topic | curated | draft | 2026-01-05 |', '| [[alpha]] | topic | canonical | draft | 2026-01-05 |') }, /learnings run changed an existing line of brain\/index\.md/, 'changed index row');
  });

  it('refuses a run that reorders rows', async () => {
    const t = await brain({ 'brain/log.md': LOG });
    const [a, b] = ['| 2026-01-01 | ingest alpha | by Ada |', '| 2026-01-02 | reject beta | by Bob |'];
    await refused(t, { [PAGE]: learning(), 'brain/log.md': LOG.replace(`${a}\n${b}`, `${b}\n${a}`) }, /learnings run changed an existing line of brain\/log\.md/, 'reordered');
  });

  it('allows added rows, with or without a trailing newline in the old file', async () => {
    const t = await brain({ 'brain/log.md': LOG.replace(/\n$/, '') });
    const done = await run(t, { [PAGE]: learning(), 'brain/log.md': `${LOG}| ${today} | synthesize | one learning |\n` });
    assert.equal(done.status, 'succeeded', done.error);
  });

  it('allows a placeholder row to give way to a real row', async () => {
    const t = await brain({ 'brain/log.md': PLACEHOLDER_LOG });
    const done = await run(t, { [PAGE]: learning(), 'brain/log.md': PLACEHOLDER_LOG.replace('| _(no actions yet)_ | | |', `| ${today} | synthesize | one learning |`) });
    assert.equal(done.status, 'succeeded', done.error);
    assert.ok(!t.show(done.branch, 'brain/log.md').includes('no actions yet'));
  });

  it('a placeholder row that goes together with a real row is still refused', async () => {
    const seeded = PLACEHOLDER_LOG.replace('| _(no actions yet)_ | | |\n', '| _(no actions yet)_ | | |\n| 2026-01-01 | ingest alpha | by Ada |\n');
    const t = await brain({ 'brain/log.md': seeded });
    await refused(t, { [PAGE]: learning(), 'brain/log.md': '# Log\n\n| Date | Action | Details |\n|------|--------|---------|\n' }, /learnings run changed an existing line of brain\/log\.md/, 'real row removed');
  });

  it('holds for a revise of a learnings proposal too', async () => {
    const t = await brain({ 'brain/log.md': LOG });
    const first = await run(t, { [PAGE]: learning() });
    assert.equal(first.status, 'succeeded', first.error);
    const p = [...t.governance.proposals.values()][0];
    p.kind = 'learnings';
    const log = t.show(first.branch, 'brain/log.md');
    t.ctx.config.ingest.fake.synth = { pages: [], files: { 'brain/log.md': log.replace('by Ada', 'by Mallory') }, outcome: 'written' };
    const job = await t.ctx.ingest.enqueue({ kind: 'revise', proposalId: p.id, trigger: 'feedback', requestedBy: 'usr_ada', instructions: 'Tidy up.' });
    const done = await t.finished(job);
    assert.equal(done.status, 'failed');
    assert.match(done.error, /learnings run changed an existing line of brain\/log\.md/);
  });
});
