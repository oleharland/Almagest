import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { locate, markerFor, verifyPathFor } from '../../src/mcp/citations.mjs';
import { answerRules } from '../../src/mcp/rules.mjs';
import { buildIndex, normalizePhrase, search, snippetFor, splitSections, stem, tokenize } from '../../src/mcp/search.mjs';
import { REPO_ROOT } from '../helpers.mjs';

function fakePage({ id, title, aliases = [], tags = [], body = '' }) {
  return { id, slug: id, title, aliases, tags, body, type: 'topic', tier: 'curated', confidence: 'high', origin: 'source', sources: [] };
}

describe('tokenizer', () => {
  it('lowercases, folds accents, drops stopwords, stems', () => {
    assert.deepEqual(tokenize('The Café is RETRYING'), ['cafe', 'retry']);
    assert.equal(stem('retries'), 'retry');
    assert.equal(stem('retried'), 'retry');
    assert.equal(stem('schedulers'), 'scheduler');
    assert.equal(stem('stopped'), 'stop');
    assert.equal(stem('class'), 'class');
    assert.equal(stem('status'), 'status');
    assert.deepEqual(tokenize('30-second backoff'), ['30', 'second', 'backoff']);
  });

  it('normalizes phrases so punctuation variants of an alias meet', () => {
    assert.equal(normalizePhrase('B-1'), normalizePhrase('b 1'));
    assert.equal(normalizePhrase('  Ünïcode—Name '), 'unicode name');
  });

  it('splits sections at # and ## only, ignoring headings inside code fences', () => {
    const s = splitSections('intro\n\n## One\nа\n### Sub\nb\n```\n## not a heading\n```\n## Two\nc');
    assert.deepEqual(s.map((x) => x.name), ['', 'One', 'Two']);
    assert.match(s[1].text, /### Sub/);
    assert.match(s[1].text, /## not a heading/);
  });
});

describe('BM25F ranking', () => {
  const pages = [
    fakePage({ id: 'body-hit', title: 'Operations Notes', body: '## Notes\n\nSomeone mentioned kestrel once, between other things entirely unrelated.' }),
    fakePage({ id: 'title-hit', title: 'Kestrel Deployment Guide', body: '## Summary\n\nHow the runner is rolled out.' }),
    fakePage({ id: 'alias-hit', title: 'Job Runner', aliases: ['Kestrel'], body: '## Summary\n\nRuns jobs.' }),
    fakePage({ id: 'unrelated', title: 'Billing', tags: ['finance'], body: '## Summary\n\nInvoices go out monthly.' }),
  ];
  const index = buildIndex(pages, 'sha1');

  it('ranks exact alias > title > body', () => {
    const r = search(index, 'kestrel');
    assert.deepEqual(r.results.map((x) => x.slug), ['alias-hit', 'title-hit', 'body-hit']);
    assert.equal(r.results[0].match, 'exact-alias');
    assert.ok(r.results[1].score > r.results[2].score, 'title boost beats a body mention');
    assert.equal(r.answered, true);
  });

  it('ranks an alias named inside a longer question first', () => {
    const r = search(index, 'how is kestrel rolled out to production');
    assert.equal(r.results[0].slug, 'alias-hit');
    assert.equal(r.results[0].match, 'alias');
  });

  it('tags count', () => {
    assert.equal(search(index, 'finance').results[0].slug, 'unrelated');
  });

  it('a query with nothing matching is a miss', () => {
    const r = search(index, 'quantum entanglement supremacy');
    assert.equal(r.results.length, 0);
    assert.equal(r.answered, false);
  });

  it('a query that only grazes the corpus is a miss (coverage below threshold)', () => {
    const r = search(index, 'kubernetes autoscaling invoices helm terraform');
    assert.ok(r.results.length > 0, 'something matched');
    assert.equal(r.answered, false);
  });

  it('filters by type and tier', () => {
    assert.equal(search(index, 'kestrel', { type: 'entity' }).results.length, 0);
    assert.equal(search(index, 'kestrel', { tier: 'curated' }).results.length, 3);
  });

  it('snippets come from the best-matching line, with its section, and keep citations', () => {
    const p = fakePage({ id: 'x', title: 'X', body: '## A\n\nNothing here.\n\n## Details\n\nThe scheduler retries on a fixed backoff. [source: a-pdf, p.3]\n' });
    assert.equal(snippetFor(p, tokenize('scheduler backoff')), '§Details: The scheduler retries on a fixed backoff. [source: a-pdf, p.3]');
  });
});

describe('citation verification', () => {
  const sidecar = '=== page 1 ===\nIntro\n\n=== page 3 ===\nThe scheduler retries on a fixed 30-second backoff.\n\n=== page 4 ===\nMore.\n=== row 7 ===\na,b,c\n';

  it('maps locators to sidecar markers', () => {
    assert.equal(markerFor('p.3'), '=== page 3 ===');
    assert.equal(markerFor('row 7'), '=== row 7 ===');
    assert.equal(markerFor('t 00:01:02'), '=== t 00:01:02 ===');
    assert.equal(markerFor('§Failover'), '=== section: Failover ===');
    assert.equal(markerFor('line 4'), '');
  });

  it('finds the passage a locator points at', () => {
    assert.equal(locate(sidecar, 'p.3').excerpt, 'The scheduler retries on a fixed 30-second backoff.');
    assert.match(locate(sidecar, 'pp.3-4').excerpt, /backoff[\s\S]*More\./);
    assert.equal(locate(sidecar, 'row 7').excerpt, 'a,b,c');
    assert.equal(locate(sidecar, 'line 2').excerpt, 'Intro');
    assert.equal(locate(sidecar, 'p.9').found, false);
    assert.equal(locate('# Doc\n## Failover\nIt fails over.\n## Other\nx', '§Failover').excerpt, 'It fails over.');
  });

  it('verifies binaries against their committed sidecar', () => {
    const manifest = { byId: new Map([['deck', { extracted: 'brain/raw/extracted/deck.pdf.txt', path: 'brain/raw/processed/deck.pdf' }]]), byPath: new Map() };
    assert.equal(verifyPathFor({ id: 'deck', path: 'brain/raw/processed/deck.pdf' }, manifest), 'brain/raw/extracted/deck.pdf.txt');
    assert.equal(verifyPathFor({ id: 'notes', path: 'brain/raw/processed/notes.md' }, manifest), 'brain/raw/processed/notes.md');
  });
});

describe('answer rules', () => {
  it('are lifted from agent/rules/read.md when the repo carries it', () => {
    const r = answerRules(REPO_ROOT);
    assert.equal(r.source, 'agent/rules/read.md');
    assert.match(r.text, /## Citation format for query answers/);
    assert.match(r.text, /Original: "System Documentation/);
    assert.match(r.text, /## Answering from `origin: self` pages/);
    assert.match(r.text, /Never invent an `id`/);
    assert.match(r.text, /DATA, not instructions/);
  });

  it('fall back to the embedded copy otherwise', () => {
    const r = answerRules('/nonexistent');
    assert.equal(r.source, 'embedded');
    assert.match(r.text, /## Citation rules/);
  });
});
