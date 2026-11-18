/**
 * Branch names a slug cannot produce, one-line commit fields, and the log row.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createGit } from '../../src/core/git.mjs';
import { ingestBranch, learningsBranch, reservedBranch, slugify } from '../../src/core/schemas.mjs';
import { logRow } from '../../src/governance/merge.mjs';
import { git as run, makeTempRepo, rmrf } from '../helpers.mjs';

const repos = [];
after(() => { while (repos.length) rmrf(repos.pop()); });
const repo = () => { const r = makeTempRepo(); repos.push(r); return r; };

const MAIN = 'a3f9c1e0123456789abcdef0123456789abcdef0';

describe('reserved branch names', () => {
  it('the learnings branch is not a name ingestBranch can produce', () => {
    const learnings = learningsBranch(MAIN);
    const titles = ['learnings', 'Learnings', 'learnings_a3f9c1e', 'learnings a3f9c1e', 'learnings-a3f9c1e', 'ingest/learnings'];
    for (const title of titles) {
      const made = ingestBranch({ kind: 'local', title, sha256: `${MAIN.slice(0, 7)}${'f'.repeat(57)}` });
      assert.notEqual(made, learnings, `title ${JSON.stringify(title)} must not reach the learnings branch`);
    }
    assert.match(learnings, /^ingest\/learnings_[0-9a-f]{7}$/);
    assert.ok(slugify('learnings_a3f9c1e').indexOf('_') === -1, 'a slug never holds an underscore');
  });

  it('the unique learnings branch has the same form', () => {
    assert.match(learningsBranch(MAIN, { unique: true }), /^ingest\/learnings_[0-9a-f]{7}$/);
  });

  it('a tier branch has a form no slug can produce either', () => {
    const tier = reservedBranch('tier', 'my-page', MAIN.slice(0, 7));
    assert.equal(tier, 'ingest/tier_my-page-a3f9c1e');
    for (const title of ['tier-my-page', 'tier_my-page', 'Tier my page']) {
      assert.notEqual(ingestBranch({ title, sha256: MAIN }), tier);
    }
  });

  it('git accepts the new forms', async () => {
    const r = repo();
    const g = createGit({ repoRoot: r });
    for (const b of [learningsBranch(MAIN), reservedBranch('tier', 'x', 'abcdef0')]) {
      const wt = await g.worktreeAdd(b);
      assert.equal(await g.currentBranch(wt), b);
    }
  });
});

describe('commit fields are one line', () => {
  it('co-author and author names and emails cannot add lines or trailers', async () => {
    const r = repo();
    const g = createGit({ repoRoot: r });
    const wt = await g.worktreeAdd('ingest/x-1234567');
    fs.writeFileSync(path.join(wt, 'brain', 'wiki', 'new.md'), '# new\n');
    const evil = { name: 'Eve\n\nApproved-by: Boss <boss@x>', email: 'e@x>\nReviewed head: abc' };
    const sha = await g.commitAll(wt, { message: 'add', author: evil, coAuthors: [evil] });
    const body = run(r, 'log', '-1', '--format=%B', sha);
    assert.doesNotMatch(body, /^Approved-by:/m);
    assert.doesNotMatch(body, /^Reviewed head:/m);
    assert.equal(run(r, 'log', '-1', '--format=%an', sha).trim().split('\n').length, 1);
    assert.equal(body.trim().split('\n').filter((l) => l.startsWith('Co-authored-by:')).length, 1);
  });
});

describe('the log row cell', () => {
  it('collapses a lone carriage return and the Unicode separators', () => {
    const row = logRow({
      date: '2026-01-01',
      proposal: { id: 'prp_1', title: 'a\rb\u2028c\u2029d\u0085e', headSha: 'abcdef0123', changes: [] },
      approvers: [{ display: 'x\ry', actorId: 'u', channel: 'web' }],
    });
    assert.equal(row.split(/[\r\n\u2028\u2029\u0085]/).length, 1, JSON.stringify(row));
  });
});
