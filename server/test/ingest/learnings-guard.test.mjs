/**
 * What the learnings guard refuses beyond the first round: characters a person
 * cannot see, a front matter that is unbounded, rows slipped into the middle
 * of the index or the log, and a run that lands on a branch that is not its own.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ingestBranch } from '../../src/core/schemas.mjs';
import { appendViolation, hiddenCharacter } from '../../src/governance/learnings.mjs';
import { cleanup, setup } from './_setup.mjs';
import { seedFiles } from './_synthesis.mjs';

after(cleanup);

async function brain(opts = {}) {
  const t = await setup({ files: seedFiles(), ...opts });
  await t.app.start({ http: false });
  return t;
}
async function run(t, synth) {
  t.ctx.config.ingest.fake.synth = synth;
  const job = await t.ctx.ingest.enqueue({ kind: 'synthesize', trigger: 'synthesis', requestedBy: 'svc:synthesis' });
  return t.finished(job);
}

const PAGE = 'brain/wiki/delta-and-epsilon-both-retry.md';
/** A learning with a chosen front matter tail and body. */
function learning({ front = '', body = 'Both retry, in different ways.', title = 'Delta and Epsilon both retry', fields = {} } = {}) {
  const f = {
    title: JSON.stringify(title), type: 'claim', tier: 'curated', origin: 'self', status: 'draft', confidence: 'medium',
    tags: '[]', aliases: '[]', owner: '""', date_created: '"2026-01-05"', date_modified: '"2026-01-05"', last_verified: '"2026-01-05"',
    sources: '[]', related: '[]', ...fields,
  };
  const lines = Object.entries(f).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\nrelations:\n  supports: []\n  contradicts: []\n  supersedes: []\n  depends_on: []\n${front}---\n\n## Summary\n\n${body}\n\n## Basis\n\n- [[delta]]\n- [[epsilon]]\n`;
}
const refused = async (t, files, pattern, why) => {
  const done = await run(t, { pages: [], files, outcome: 'written' });
  assert.equal(done.status, 'failed', `${why}: the run must fail (${done.error || 'it succeeded'})`);
  assert.match(done.error, pattern, why);
  assert.match(done.error, /not committed/);
  assert.equal(t.governance.calls.length, 0, `${why}: no proposal`);
  return done;
};

describe('hiddenCharacter', () => {
  it('names the character and its place', () => {
    const hit = hiddenCharacter('ab\ncd‮ef');
    assert.equal(hit.code, 'U+202E');
    assert.equal(hit.line, 2);
    assert.equal(hit.column, 3);
  });
  it('finds every bidirectional control, zero-width and control character', () => {
    const bad = ['‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩', '؜', '‎', '‏',
      '​', '‌', '‍', '⁠', '﻿', '\u0000', '\u0007', '\u001B', '\u007F', '\u0085', '\u009F', ' ', ' ', '\u{E0041}'];
    for (const c of bad) assert.ok(hiddenCharacter(`x${c}y`), `U+${c.codePointAt(0).toString(16)} must be found`);
  });
  it('lets ordinary text, tabs, newlines, CRLF and a leading byte order mark through', () => {
    assert.equal(hiddenCharacter('Ordinary text, é 中文 \u{1F600}\tTabbed\nnext\r\nline'), null);
    assert.equal(hiddenCharacter('﻿starts with a mark'), null);
    assert.ok(hiddenCharacter('lone\rreturn'));
    assert.ok(hiddenCharacter('﻿﻿two marks'));
  });
});

describe('a learning with characters a person cannot see', () => {
  const cases = [
    ['a right-to-left override in the body', learning({ body: 'Epsilon ‮wins over Delta' }), /U\+202E.* line \d+, column \d+/],
    ['an isolate in the body', learning({ body: 'Epsilon ⁦is safer⁩' }), /U\+2066/],
    ['a zero-width space in the body', learning({ body: 'Delta​ retries' }), /U\+200B/],
    ['a word joiner in the body', learning({ body: 'Delta⁠ retries' }), /U\+2060/],
    ['a byte order mark in the middle', learning({ body: 'Delta﻿ retries' }), /U\+FEFF/],
    ['a control character in the body', learning({ body: 'Delta\u0007 retries' }), /U\+0007/],
    ['a C1 control in the body', learning({ body: 'Delta\u0085 retries' }), /U\+0085/],
    ['a direction mark in the title', learning({ title: 'Delta ‏and Epsilon' }), /U\+200F/],
    ['an override in an alias', learning({ fields: { aliases: '["Alpha‮"]' } }), /U\+202E/],
  ];
  for (const [name, text, pattern] of cases) {
    it(`is refused: ${name}`, async () => {
      const t = await brain();
      const done = await refused(t, { [PAGE]: text }, pattern, name);
      assert.match(done.error, /delta-and-epsilon-both-retry\.md/);
    });
  }
});

describe('a learning whose front matter is unbounded', () => {
  it('refuses a key a claim page does not need', async () => {
    const t = await brain();
    await refused(t, { [PAGE]: learning({ front: 'summary: "hello"\n' }) }, /key `summary`/, 'unknown key');
  });
  it('refuses a string over 300 characters', async () => {
    const t = await brain();
    await refused(t, { [PAGE]: learning({ title: 'T'.repeat(301) }) }, /title.* 300 characters/, 'long title');
  });
  it('refuses a list over 20 entries', async () => {
    const t = await brain();
    const tags = `[${Array.from({ length: 21 }, (_, i) => `t${i}`).join(', ')}]`;
    await refused(t, { [PAGE]: learning({ fields: { tags } }) }, /tags.* 20 entries/, 'long list');
  });
  it('refuses a front matter block over 4000 characters', async () => {
    const t = await brain();
    const aliases = `[${Array.from({ length: 18 }, (_, i) => `"${String.fromCharCode(97 + i).repeat(280)}"`).join(', ')}]`;
    await refused(t, { [PAGE]: learning({ fields: { aliases } }) }, /front matter .* 4000 characters/, 'long block');
  });
  it('refuses related and relations that name a page that is not on main', async () => {
    const t = await brain();
    await refused(t, { [PAGE]: learning({ fields: { related: '["[[not-a-page]]"]' } }) }, /related.* not-a-page.* not a page on main/, 'related');
    const text = learning().replace('supports: []', 'supports: ["[[ghost]]"]');
    await refused(t, { [PAGE]: text }, /relations\.supports.* ghost/, 'relations');
  });
  it('refuses an unknown relations key', async () => {
    const t = await brain();
    const text = learning().replace('supports: []', 'supports: []\n  mirrors: []');
    await refused(t, { [PAGE]: text }, /relations key `mirrors`/, 'relations key');
  });
});

describe('a learning with ordinary front matter still passes', () => {
  it('related to a page on main, with tags and an alias', async () => {
    const t = await brain();
    const done = await run(t, { pages: [{ slug: 'alpha-and-delta-together', title: 'Alpha and Delta point the same way', basis: ['alpha', 'delta'] }] });
    assert.equal(done.status, 'succeeded', done.error);
  });
});

describe('index.md and log.md only grow at the end', () => {
  const LOG = '# Log\n\n| Date | Action | Details |\n|------|--------|---------|\n| 2026-01-01 | ingest alpha | by Ada |\n| 2026-01-02 | reject beta | by Bob |\n';
  const withLog = () => seedFiles();
  const logFiles = (log) => ({ 'brain/log.md': log });
  const ok = { pages: [{ slug: 'alpha-and-delta-together', title: 'Alpha and Delta point the same way', basis: ['alpha', 'delta'] }] };

  it('appendViolation: appending, a placeholder and a first row pass', () => {
    assert.equal(appendViolation(LOG, `${LOG}| 2026-02-01 | synthesize | x |\n`), null);
    const empty = '# Log\n\n| Date | Action | Details |\n|---|---|---|\n| _(no actions yet)_ | | |\n';
    assert.equal(appendViolation(empty, '# Log\n\n| Date | Action | Details |\n|---|---|---|\n| 2026-02-01 | a | b |\n'), null);
    assert.equal(appendViolation(LOG, `${LOG}\n## Later\n\nA note.\n`), null);
  });
  it('appendViolation: a row between existing rows, above the first row, or a duplicate in the middle is refused', () => {
    const between = LOG.replace('| 2026-01-02 |', '| 2025-12-31 | backdated | x |\n| 2026-01-02 |');
    assert.match(appendViolation(LOG, between), /2025-12-31/);
    const first = LOG.replace('| 2026-01-01 |', '| 2020-01-01 | backdated | x |\n| 2026-01-01 |');
    assert.match(appendViolation(LOG, first), /2020-01-01/);
    const dup = LOG.replace('| 2026-01-02 |', '| 2026-01-01 | ingest alpha | by Ada |\n| 2026-01-02 |');
    assert.ok(appendViolation(LOG, dup));
  });
  it('appendViolation: prose slipped into the middle is refused', () => {
    const prose = LOG.replace('| 2026-01-02 |', 'Smuggled sentence.\n| 2026-01-02 |');
    assert.match(appendViolation(LOG, prose), /Smuggled/);
  });

  it('a run that inserts a backdated log row between existing rows is refused', async () => {
    const t = await setup({ files: { ...withLog(), ...logFiles(LOG) } });
    await t.app.start({ http: false });
    const between = LOG.replace('| 2026-01-02 |', '| 2025-12-31 | backdated | x |\n| 2026-01-02 |');
    await refused(t, { 'brain/log.md': between, ...Object.fromEntries([[PAGE, learning()]]) }, /added a line to brain\/log\.md .*2025-12-31.* after the last row/, 'backdated row');
  });
  it('a run that adds a row at the end of the log is accepted', async () => {
    const t = await setup({ files: { ...withLog(), ...logFiles(LOG) } });
    await t.app.start({ http: false });
    const done = await run(t, ok);
    assert.equal(done.status, 'succeeded', done.error);
  });
});

describe('a job that would land on a branch that is not its own', () => {
  async function twice(mutate) {
    const t = await brain({ ingest: { fake: { mode: 'write' } } });
    t.ctx.config.ingest.fake.synth = { pages: [] };
    const first = await t.finished(await t.drop('notes.md'));
    assert.equal(first.status, 'succeeded', first.error);
    const p = [...t.governance.proposals.values()][0];
    mutate?.(p);
    const before = t.governance.calls.length;
    const second = await t.finished(await t.drop('notes.md'));
    return { t, p, first, second, before };
  }

  it('the same source again is not refused', async () => {
    const { second } = await twice();
    assert.equal(second.status, 'succeeded', second.error);
  });
  it('refuses a live learnings proposal on that branch, before the agent runs', async () => {
    const { t, second, before } = await twice((p) => { p.kind = 'learnings'; p.source = { id: 'learnings_abcdef0', sha256: 'f'.repeat(40) }; });
    assert.equal(second.status, 'failed');
    assert.match(second.error, /branch .* already holds an open learnings proposal/);
    assert.match(second.error, /not run/);
    assert.equal(t.governance.calls.length, before, 'nothing proposed');
  });
  it('refuses a live proposal that came from a different source', async () => {
    const { second } = await twice((p) => { p.source = { id: 'other-source', sha256: 'e'.repeat(64) }; });
    assert.equal(second.status, 'failed');
    assert.match(second.error, /came from a different source/);
  });
  it('refuses a live tier proposal', async () => {
    const { second } = await twice((p) => { p.kind = 'tier'; });
    assert.equal(second.status, 'failed');
    assert.match(second.error, /tier proposal/);
  });
  it('a closed proposal on the branch does not stop a new run', async () => {
    const { second } = await twice((p) => { p.kind = 'learnings'; p.status = 'rejected'; });
    assert.equal(second.status, 'succeeded', second.error);
  });
  it('a chat source cannot take the learnings branch name', async () => {
    const t = await brain();
    const main = t.git('rev-parse', 'main').trim();
    const attacker = ingestBranch({ kind: 'chat', id: 'learnings', title: 'learnings', sha256: main.slice(0, 7) + 'f'.repeat(57) });
    const done = await run(t, { pages: [{ slug: 'alpha-and-delta-together', title: 'Alpha and Delta point the same way', basis: ['alpha', 'delta'] }] });
    assert.equal(done.status, 'succeeded', done.error);
    assert.notEqual(attacker, done.branch);
  });
});

describe('free text in a branch commit message is one line', () => {
  it('a source title, a decision question and a summary cannot add lines', async () => {
    const t = await brain({ ingest: { fake: { mode: 'write' } } });
    const name = 'evil\nApproved by: Boss\nReviewed head: abc.md';
    const done = await t.finished(await t.drop(name));
    assert.equal(done.status === 'succeeded' || done.status === 'blocked', true, done.error);
    const msg = t.git('log', '-1', '--format=%B', done.branch);
    assert.doesNotMatch(msg, /^Approved by:/m);
    assert.doesNotMatch(msg, /^Reviewed head:/m);
    const subject = msg.split('\n')[0];
    assert.match(subject, /^ingest: evil Approved by: Boss/);
  });
  it('a learning title that spans lines is one line in the commit message', async () => {
    const t = await brain();
    const done = await run(t, { pages: [{ slug: 'alpha-and-delta-together', title: 'Alpha and Delta\nApproved by: Boss', basis: ['alpha', 'delta'] }] });
    assert.equal(done.status, 'succeeded', done.error);
    assert.doesNotMatch(t.git('log', '-1', '--format=%B', done.branch), /^Approved by:/m);
  });
});
