import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { documentCounts, hintSettings, hintWords, suggest } from '../../src/governance/hints.mjs';
import { ada, cleanup, G, git, govApp, repo } from './fixtures.mjs';

after(cleanup);

const pg = (slug, backlinks = 0, extra = {}) => ({ slug, title: slug.toUpperCase(), type: 'topic', tier: 'curated', backlinks: Array.from({ length: backlinks }, (_, i) => ({ id: `x${i}` })), ...extra });
const docs = (o) => new Map(Object.entries(o));

describe('hints: counting and thresholds', () => {
  it('counts distinct sources per page, bare slugs or links, not superseded or skipped', () => {
    const counts = documentCounts([
      { id: 's1', pages: ['a', '[[b]]'] }, { id: 's2', pages: ['a'] }, { id: 's2', pages: ['a'] },
      { id: 's3', pages: ['a'], status: 'superseded' }, { id: 's4', pages: ['a'], status: 'skipped' },
    ]);
    assert.equal(counts.get('a'), 2);
    assert.equal(counts.get('b'), 1);
  });

  it('defaults, thresholds, hot factor (rounded up), exclusions and order', () => {
    const s = hintSettings();
    assert.deepEqual(s, { enabled: true, minSources: 5, minBacklinks: 8, hotFactor: 0.6 });
    const pages = [
      pg('few', 7), pg('docs5'), pg('links8', 8), pg('hot3', 0), pg('hotlinks5', 5), pg('hot2', 0),
      pg('locked', 9), pg('claimy', 9, { type: 'claim' }), pg('_tmpl', 9), pg('plain', 0),
    ];
    const out = suggest({
      pages, documents: docs({ docs5: 5, hot3: 3, hot2: 2, locked: 30, claimy: 30, _tmpl: 30, plain: 4, links8: 1 }),
      locked: new Set(['locked']), hot: new Set(['hot3', 'hotlinks5', 'hot2']), settings: s,
    });
    // A hot page needs ceil(5 * 0.6) = 3 documents or ceil(8 * 0.6) = 5 backlinks.
    assert.deepEqual(out.map((h) => h.slug), ['docs5', 'hot3', 'links8', 'hotlinks5']);
    assert.equal(out[1].hot, true);
    assert.deepEqual(suggest({ pages, documents: docs({}), settings: { ...s, enabled: false } }), []);
  });

  it('orders by documents, then backlinks', () => {
    const out = suggest({ pages: [pg('a', 9), pg('b', 3), pg('c', 20)], documents: docs({ a: 6, b: 9, c: 6 }) });
    assert.deepEqual(out.map((h) => h.slug), ['b', 'c', 'a']);
  });

  it('a dismissed page returns only at 1.5 times the documents it had', () => {
    const base = { pages: [pg('a')], settings: hintSettings() };
    const dismissed = new Map([['a', { documents: 6 }]]);
    assert.equal(suggest({ ...base, documents: docs({ a: 6 }), dismissed }).length, 0);
    assert.equal(suggest({ ...base, documents: docs({ a: 8 }), dismissed }).length, 0);
    assert.equal(suggest({ ...base, documents: docs({ a: 9 }), dismissed }).length, 1);
  });

  it('says the counts in plain words', () => {
    assert.deepEqual(hintWords({ documents: 30, backlinks: 12, hot: true }), ['30 documents contributed to this page', '12 other pages link here', 'among the most read pages']);
    assert.deepEqual(hintWords({ documents: 1, backlinks: 1, hot: false }), ['1 document contributed to this page', '1 other page links here']);
  });
});

describe('hints on a real brain', () => {
  it('reads main, remembers a dismissal, and drops a page once it is canonical', async () => {
    const r = repo();
    const entries = Array.from({ length: 6 }, (_, i) => `  - id: doc-${i}\n    kind: local\n    path: brain/raw/processed/doc-${i}.md\n    sha256: ${String(i).padStart(64, '0')}\n    pages:\n      - beta\n    status: ingested\n`).join('');
    fs.appendFileSync(path.join(r, 'brain/manifest.yaml'), entries);
    git(r, 'add', '-A');
    git(r, 'commit', '-qm', 'docs');
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const gov = G(app);
    assert.deepEqual((await gov.hints.list({ fresh: true })).map((h) => [h.slug, h.documents]), [['beta', 7]]);
    assert.equal(await gov.hints.count(), 1);
    await assert.rejects(() => gov.dismissHint('alpha', ada), /not on the list/);
    await gov.dismissHint('beta', ada);
    assert.equal((await gov.hints.list({ fresh: true })).length, 0);
    assert.equal((await app.ctx.store.kv.get('canonical-hints.dismissed', 'beta')).documents, 7);
    await app.stop();
  });

  it('is off when governance.canonical_hint.enabled is false', async () => {
    const r = repo();
    const app = await govApp(r, { overrides: { governance: { canonical_hint: { enabled: false } } } });
    assert.deepEqual(await app.ctx.governance.hints.list({ fresh: true }), []);
    await app.stop();
  });
});
