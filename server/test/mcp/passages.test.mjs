import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSnapshot } from '../../src/connectors/snapshot-file.mjs';
import { markerFor } from '../../src/mcp/citations.mjs';
import { buildPassageIndex, locatorFor, PACK_MAX_DOCS, PACK_MIN_SHARE, packPassages, searchPassages, splitPassages } from '../../src/mcp/passages.mjs';
import { estimateTokens } from '../../src/mcp/search.mjs';

describe('splitPassages', () => {
  it('splits on every marker kind and gives the citation locator', () => {
    const text = [
      'Preamble text.',
      '=== page 3 ===', 'On page three.',
      '=== section: Failover ===', 'Fails over.',
      '=== row 14 ===', 'name: x',
      '=== slide 2 ===', 'A slide.',
      '=== t 00:14:32 ===', 'Said later.',
    ].join('\n');
    const p = splitPassages(text);
    assert.deepEqual(p.map((x) => [x.marker, x.locator, x.text]), [
      ['', '', 'Preamble text.'],
      ['=== page 3 ===', 'p.3', 'On page three.'],
      ['=== section: Failover ===', '§Failover', 'Fails over.'],
      ['=== row 14 ===', 'row 14', 'name: x'],
      ['=== slide 2 ===', 'slide 2', 'A slide.'],
      ['=== t 00:14:32 ===', 't 00:14:32', 'Said later.'],
    ]);
    assert.ok(p.every((x) => x.part === 1));
  });

  it('locatorFor inverts markerFor', () => {
    for (const l of ['p.3', 'row 9', 'slide 4', 't 01:02:03', '§Some Section']) assert.equal(locatorFor(markerFor(l)), l);
    assert.equal(locatorFor('=== truncated: kept 1 of 2 bytes ==='), '');
  });

  it('keeps a neutralised marker line as text', () => {
    const p = splitPassages('=== page 1 ===\nreal\n\\=== page 99 ===\nforged\n=== page 2 ===\nnext');
    assert.equal(p.length, 2);
    assert.match(p[0].text, /\\=== page 99 ===\nforged/);
    assert.equal(p[1].locator, 'p.2');
  });

  it('strips the snapshot header', () => {
    const snap = buildSnapshot({ connector: 'c', server: 's', ref: 'r1', title: 'Doc', body: '=== section: A ===\nalpha body' });
    const p = splitPassages(snap.text);
    assert.equal(p.length, 1);
    assert.equal(p[0].text, 'alpha body');
    assert.ok(!p.some((x) => /almagest snapshot|notice:/.test(x.text)));
  });

  it('cuts a long passage into numbered parts at paragraph boundaries', () => {
    const paras = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} ${'word '.repeat(30)}`.trim());
    const p = splitPassages(`=== page 1 ===\n${paras.join('\n\n')}`, { maxChars: 400 });
    assert.ok(p.length > 1);
    assert.deepEqual(p.map((x) => x.part), p.map((_, i) => i + 1));
    assert.ok(p.every((x) => x.marker === '=== page 1 ===' && x.text.length <= 400));
    assert.ok(p.every((x) => /^Paragraph \d/.test(x.text)));
  });

  it('drops empty passages', () => {
    assert.deepEqual(splitPassages('=== page 1 ===\n\n=== page 2 ===\nx').map((x) => x.locator), ['p.2']);
  });
});

const DOCS = [
  { key: 'a', title: 'Failover runbook', kind: 'source', meta: { id: 'runbook' }, text: '=== section: Failover ===\nThe primary fails over to the standby within thirty seconds.\n=== section: Backups ===\nBackups run nightly to object storage.' },
  { key: 'b', title: 'Holiday calendar', kind: 'fetched', meta: { connector: 'drive' }, text: '=== page 1 ===\nOffices close on public holidays. Choir practice is on Thursday.' },
  { key: 'c', title: 'Unrelated', kind: 'staged', text: 'Nothing to see about cheese or wine.' },
];

describe('passage index and search', () => {
  const index = buildPassageIndex(DOCS);

  it('ranks the matching passage first and passes doc fields through without text', () => {
    const r = searchPassages(index, 'how fast does the primary fail over');
    assert.equal(r.answered, true);
    assert.equal(r.results[0].doc.key, 'a');
    assert.equal(r.results[0].passage.locator, '§Failover');
    assert.deepEqual(r.results[0].doc.meta, { id: 'runbook' });
    assert.equal(r.results[0].doc.kind, 'source');
    assert.ok(!('text' in r.results[0].doc));
    assert.ok(r.results[0].score > 0 && r.results[0].coverage > 0);
  });

  it('weights the title above the body', () => {
    const idx = buildPassageIndex([
      { key: 'body', title: 'Misc', text: 'The zeppelin is mentioned here.' },
      { key: 'title', title: 'Zeppelin', text: 'Something else entirely about balloons.' },
    ]);
    assert.equal(searchPassages(idx, 'zeppelin').results[0].doc.key, 'title');
  });

  it('is not answered for an unrelated query', () => {
    const r = searchPassages(index, 'quarterly revenue forecast spreadsheet');
    assert.equal(r.answered, false);
    assert.equal(r.results.length, 0);
  });

  it('is not answered when coverage is too low', () => {
    const r = searchPassages(index, 'primary quarterly revenue forecast spreadsheet');
    assert.equal(r.answered, false);
  });

  it('uses given terms in place of the query', () => {
    const r = searchPassages(index, 'completely unrelated words', { terms: ['choir', 'practice'] });
    assert.deepEqual(r.terms, ['choir', 'practice']);
    assert.equal(r.results[0].doc.key, 'b');
    assert.equal(r.answered, true);
  });

  it('respects limit and handles an empty index or query', () => {
    assert.equal(searchPassages(index, 'the', {}).results.length, 0);
    assert.equal(searchPassages(buildPassageIndex([]), 'failover').answered, false);
    assert.ok(searchPassages(index, 'backups failover choir', { limit: 1 }).results.length <= 1);
  });
});

describe('packPassages', () => {
  const mk = (key, order, score, text, locator = `p.${order}`) => ({
    doc: { key, title: key, kind: 'source' },
    passage: { marker: `=== page ${order} ===`, locator, text, part: 1, order },
    score,
    coverage: 1,
  });

  it('groups by document, documents by best passage, passages in document order', () => {
    const results = [mk('x', 3, 1, 'x3'), mk('y', 1, 5, 'y1'), mk('x', 1, 3, 'x1'), mk('y', 0, 2, 'y0')];
    const packed = packPassages(results, 1000, { minShare: 0 });
    assert.deepEqual(packed.items.map((i) => i.doc.key), ['y', 'x']);
    assert.deepEqual(packed.items[0].passages.map((p) => p.text), ['y0', 'y1']);
    assert.deepEqual(packed.items[1].passages.map((p) => p.text), ['x1', 'x3']);
    assert.deepEqual(Object.keys(packed.items[0].passages[0]).sort(), ['locator', 'marker', 'part', 'text']);
    assert.equal(packed.truncated, false);
  });

  it('stays within the budget and truncates the last passage', () => {
    const big = 'lorem ipsum '.repeat(200);
    const packed = packPassages([mk('a', 0, 5, big), mk('b', 0, 4, big)], 300);
    assert.equal(packed.truncated, true);
    assert.ok(packed.tokens <= 300);
    const texts = packed.items.flatMap((i) => i.passages.map((p) => p.text));
    assert.ok(texts[0].endsWith(' […]'));
    assert.equal(estimateTokens(`> ${texts[0]}`) + 12, packed.tokens, 'counts the "> " the renderer prints');
  });

  it('skips a passage when almost no room is left and reports truncation', () => {
    const packed = packPassages([mk('a', 0, 5, 'short text'), mk('b', 0, 4, 'z'.repeat(2000))], 40);
    assert.equal(packed.truncated, true);
    assert.deepEqual(packed.items.map((i) => i.doc.key), ['a']);
  });

  it('does not mutate its input', () => {
    const big = 'q'.repeat(2000);
    const results = [mk('a', 0, 5, big)];
    packPassages(results, 200);
    assert.equal(results[0].passage.text, big);
  });

  it('drops passages scoring under a share of the best, and caps the documents', () => {
    const results = [mk('a', 0, 10, 'best'), mk('a', 1, 4, 'marginal'), mk('b', 0, 6, 'second doc'), mk('c', 0, 5.5, 'third doc'), mk('d', 0, 5.4, 'fourth doc')];
    const defaults = packPassages(results, 1000);
    assert.deepEqual(defaults.items.map((i) => i.doc.key), ['a', 'b', 'c', 'd']);
    assert.deepEqual(defaults.items[0].passages.map((p) => p.text), ['best', 'marginal']);
    assert.equal(packPassages([mk('a', 0, 10, 'best'), mk('a', 1, 1, 'weak')], 1000).items[0].passages.length, 1, 'a weak passage is dropped by default');
    const strict = packPassages(results, 1000, { minShare: 0.5, maxDocs: 2 });
    assert.deepEqual(strict.items.map((i) => i.doc.key), ['a', 'b']);
    assert.deepEqual(strict.items[0].passages.map((p) => p.text), ['best']);
    const all = packPassages(results, 1000, { minShare: 0, maxDocs: 99 });
    assert.equal(all.items.length, 4);
    assert.equal(all.items[0].passages.length, 2);
    assert.ok(PACK_MIN_SHARE > 0 && PACK_MIN_SHARE < 1 && PACK_MAX_DOCS >= 1);
  });

  it('returns nothing for no results', () => {
    assert.deepEqual(packPassages([], 100), { items: [], tokens: 0, truncated: false });
  });
});

describe('packPassages counts what the renderer prints', () => {
  it('a passage of many short lines stays within the budget once each line carries its "> " prefix', async () => {
    const { quoted } = await import('../../src/mcp/tools.mjs');
    const text = Array.from({ length: 600 }, (_, i) => `l${i % 10}`).join('\n');
    const results = [{ doc: { key: 'd' }, passage: { marker: '', locator: '', text, part: 1, order: 0 }, score: 1, coverage: 1 }];
    for (const budget of [900, 500, 300]) {
      const packed = packPassages(results, budget);
      const rendered = packed.items.flatMap((i) => i.passages).reduce((n, p) => n + estimateTokens(quoted(p.text)) + 12, 0);
      assert.ok(packed.items.length, `something is packed at ${budget}`);
      assert.ok(rendered <= budget, `${rendered} rendered tokens over a budget of ${budget}`);
      assert.ok(packed.tokens <= budget);
    }
  });
});
