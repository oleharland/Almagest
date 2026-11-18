import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createGit } from '../../src/core/git.mjs';
import { buildChanges } from '../../src/governance/builder.mjs';
import { cleanText, diffClaims, extractClaims } from '../../src/governance/claims.mjs';
import { focus, locate, locatorWords } from '../../src/governance/excerpt.mjs';
import { FIXTURES } from '../helpers.mjs';
import { ALPHA_V2, cleanup, DELTA, page, repo } from './fixtures.mjs';

after(cleanup);

const SIDECAR = fs.readFileSync(path.join(FIXTURES, 'clean', 'brain', 'raw', 'extracted', 'alpha.pdf.txt'), 'utf-8');

describe('claims', () => {
  it('splits paragraphs at citation runs, keeps bullets whole, reads table rows', () => {
    const body = `## Details

Alpha retries. [source: a, p.1] It backs off 30 s [source: a, p.3][source: b, line 4]. Uncited tail.

- A bullet with [[beta|Beta]] in it. [source: a, §Intro]

| Parameter | Value | Source |
|---|---|---|
| Backoff | 30 s | [source: a, p.3] |
`;
    const claims = extractClaims(body);
    assert.deepEqual(claims.map((c) => c.text), ['Alpha retries.', 'It backs off 30 s.', 'A bullet with Beta in it.', 'Backoff · 30 s']);
    assert.equal(claims[1].citations.length, 2);
    assert.deepEqual(claims[2].citations[0], { id: 'a', locator: '§Intro' });
  });

  it('pairs a reworded claim with the same citation as a change, not add + remove', () => {
    const before = extractClaims('The scheduler retries on a fixed 30-second backoff. [source: alpha-pdf, p.3]\n\nOld fact. [source: alpha-pdf, p.9]');
    const after = extractClaims('The scheduler retries on a fixed 45-second backoff. [source: alpha-pdf, p.3]\n\nBrand new. [source: alpha-pdf, p.1]');
    const d = diffClaims(before, after);
    assert.deepEqual(d.map((c) => c.op).sort(), ['add', 'change', 'remove']);
    const ch = d.find((c) => c.op === 'change');
    assert.match(ch.before, /30-second/);
    assert.match(ch.text, /45-second/);
    assert.equal(diffClaims(before, before).length, 0);
  });

  it('same words, new citation is a change with the old citation kept', () => {
    const d = diffClaims(extractClaims('X is y. [source: a, p.1]'), extractClaims('X is y. [source: a, p.2]'));
    assert.equal(d.length, 1);
    assert.equal(d[0].op, 'change');
    assert.deepEqual(d[0].beforeCitation, { id: 'a', locator: 'p.1' });
  });

  it('cleanText strips markers and tidies', () => {
    assert.equal(cleanText('Uses [[alpha]] and [[b|Bee]] . [source: x, p.1]'), 'Uses alpha and Bee.');
  });
});

describe('excerpts', () => {
  it('resolves p.N against === page N === markers', () => {
    assert.deepEqual(locate(SIDECAR, 'p.3'), { status: 'found', passage: 'The scheduler retries on a fixed 30-second backoff.', where: 'p.3' });
    assert.equal(locate(SIDECAR, 'p.1').passage, 'Alpha System Overview');
    assert.equal(locate(SIDECAR, 'p.2').status, 'not-found');
    assert.match(locate(SIDECAR, 'pp.1-3').passage, /Overview[\s\S]*30-second/);
  });

  it('resolves §section by marker, heading, then a line naming it', () => {
    const t = '=== section: Pricing ===\nIt costs 5.\n=== section: Support ===\nCall us.';
    assert.equal(locate(t, '§Pricing').passage, 'It costs 5.');
    assert.equal(locate('# Intro\nhi\n## Setup\nInstall it.\n## Next\nmore', '§Setup').passage, '## Setup\nInstall it.');
    assert.equal(locate(SIDECAR, '§Overview').passage, 'Alpha System Overview');
    assert.equal(locate(SIDECAR, '§Nowhere').status, 'not-found');
  });

  it('resolves line, row, slide and timestamps', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    assert.equal(locate(lines, 'line 5').passage, 'line 3\nline 4\nline 5\nline 6\nline 7');
    assert.equal(locate('=== row 2 ===\nb,2\n=== row 3 ===\nc,3', 'row 3').passage, 'c,3');
    assert.equal(locate('=== slide 2 ===\nRoadmap', 'slide 2').passage, 'Roadmap');
    const tx = '=== t 00:00:00 ===\nhello\n=== t 00:05:00 ===\nthe budget is 10k\n=== t 00:10:00 ===\nbye';
    assert.equal(locate(tx, 't 00:07:30').passage, 'the budget is 10k');
    assert.equal(locate(tx, 't 00:05:00').passage, 'the budget is 10k');
  });

  it('focuses long passages on the claim and caps them', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `Filler sentence number ${i}.`).join(' ');
    const text = `${filler} The retry ceiling is 90 seconds under load. ${filler}`;
    const out = focus(text, 'retry ceiling 90 seconds', 600);
    assert.ok(out.length <= 610);
    assert.match(out, /retry ceiling is 90 seconds/);
    assert.ok(out.startsWith('… '));
  });

  it('words for locators', () => {
    assert.equal(locatorWords('p.3'), 'page 3');
    assert.equal(locatorWords('pp.3-5'), 'pages 3–5');
    assert.equal(locatorWords('§Overview'), 'section “Overview”');
    assert.equal(locatorWords('t 00:01:02'), 'at 00:01:02');
  });
});

describe('proposal builder', () => {
  it('builds claim-level changes with source excerpts from git', async () => {
    const r = repo();
    const g = createGit({ repoRoot: r });
    const base = await g.revParse('main');
    const wt = await g.worktreeAdd('ingest/q3-abcdef1');
    fs.writeFileSync(path.join(wt, 'brain/wiki/alpha.md'), ALPHA_V2);
    fs.writeFileSync(path.join(wt, 'brain/wiki/delta.md'), DELTA);
    fs.writeFileSync(path.join(wt, 'brain/wiki/taxonomy.md'), page({ title: 'Taxonomy', tier: 'canonical', body: 'Tiers are gold. [source: alpha-pdf, p.1]' }));
    fs.rmSync(path.join(wt, 'brain/wiki/gamma-claim.md'));
    fs.writeFileSync(path.join(wt, 'brain/log.md'), 'log\n');
    const head = await g.commitAll(wt, { message: 'x', author: { name: 'a', email: 'a@a' } });

    const { changes, otherFiles } = await buildChanges({ git: g, baseSha: base, headSha: head, canonicalPages: ['glossary'] });
    const by = Object.fromEntries(changes.map((c) => [c.slug, c]));
    assert.deepEqual(Object.keys(by).sort(), ['alpha', 'delta', 'gamma-claim', 'taxonomy']);
    assert.equal(by.delta.action, 'create');
    assert.equal(by['gamma-claim'].action, 'delete');
    assert.equal(by.taxonomy.canonical, true);
    assert.equal(by.alpha.canonical, false);
    assert.deepEqual(otherFiles.map((f) => f.path), ['brain/log.md']);

    const changed = by.alpha.claims.find((c) => c.op === 'change');
    assert.match(changed.before, /30-second/);
    assert.equal(changed.excerptStatus, 'found');
    assert.equal(changed.excerpt, 'The scheduler retries on a fixed 30-second backoff.');
    assert.equal(changed.citation.title, 'Alpha System Overview');
    const added = by.alpha.claims.find((c) => c.op === 'add');
    assert.equal(added.excerpt, 'Alpha System Overview');
    assert.equal(by.delta.claims[0].excerpt, 'Alpha System Overview');
    assert.ok(by.alpha.fields.some((f) => f.key === 'tags') === false);
  });
});
