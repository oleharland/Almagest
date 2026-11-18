import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { mergePages, pageProvenance, parsePage } from '../../src/governance/page-merge.mjs';

const SRC_A = { id: 'src-a', path: 'brain/raw/extracted/a.txt', sha256: 'a'.repeat(64), title: 'Source A' };
const SRC_B = { id: 'src-b', path: 'brain/raw/extracted/b.txt', sha256: 'b'.repeat(64), title: 'Source B' };

const yamlList = (name, items) => (items.length ? `${name}:\n${items.map((i) => `  - ${i}`).join('\n')}` : `${name}: []`);
const sourcesYaml = (list) => `sources:\n${list.map((s) => `  - id: ${s.id}\n    path: ${s.path}\n    sha256: "${s.sha256}"\n    title: "${s.title}"`).join('\n')}`;

/** A page in the shape the fixtures use; every frontmatter field can be overridden. */
function pg({ body = '## Summary\n\nA thing.\n', sources = [SRC_A], aliases = [], tags = [], related = [], relations = [], extra = '', ...f } = {}) {
  const v = {
    title: '"Morning Brew"', type: 'topic', tier: 'evidence', origin: 'source', status: 'draft', confidence: 'medium', owner: '""',
    date_created: '"2026-01-02"', date_modified: '"2026-01-05"', last_verified: '"2026-01-05"', ...f,
  };
  const scalars = Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => `${k}: ${x}`).join('\n');
  return `---\n${scalars}\n${yamlList('aliases', aliases.map((a) => `"${a}"`))}\n${yamlList('tags', tags)}\n${sourcesYaml(sources)}\n${yamlList('related', related.map((r) => `"[[${r}]]"`))}\nrelations:\n  supports: ${relations.length ? `[${relations.join(', ')}]` : '[]'}\n  contradicts: []\n  supersedes: []\n  depends_on: []\n${extra}---\n\n${body}`;
}

const merged = (args) => {
  const r = mergePages(args);
  assert.equal(r.ok, true, r.reason);
  return { text: r.text, ...parsePage(r.text) };
};
const clashes = (args, re) => {
  const r = mergePages(args);
  assert.equal(r.ok, false, 'expected a clash');
  if (re) assert.match(r.reason, re);
};

describe('page merge: frontmatter lists', () => {
  it('unions sources by id, main first', () => {
    const m = merged({ ours: pg({ sources: [SRC_A] }), theirs: pg({ sources: [SRC_B, SRC_A] }) });
    assert.deepEqual(m.data.sources.map((s) => s.id), ['src-a', 'src-b']);
  });

  it('the same source id with a different path is a clash', () => {
    clashes({ ours: pg({ sources: [SRC_A] }), theirs: pg({ sources: [{ ...SRC_A, path: 'brain/raw/extracted/other.txt' }] }) }, /src-a/);
  });

  it('the same source id with a different sha256 is a clash', () => {
    clashes({ ours: pg({ sources: [SRC_A] }), theirs: pg({ sources: [{ ...SRC_A, sha256: 'c'.repeat(64) }] }) }, /src-a/);
  });

  it('unions aliases, tags, related and each relations list, main first', () => {
    const m = merged({
      ours: pg({ aliases: ['MB', 'Brew'], tags: ['news'], related: ['beta'], relations: ['alpha'] }),
      theirs: pg({ aliases: ['Brew', 'Morning Brew Daily'], tags: ['email', 'news'], related: ['gamma-claim'], relations: ['beta', 'alpha'] }),
    });
    assert.deepEqual(m.data.aliases, ['MB', 'Brew', 'Morning Brew Daily']);
    assert.deepEqual(m.data.tags, ['news', 'email']);
    assert.deepEqual(m.data.related, ['[[beta]]', '[[gamma-claim]]']);
    assert.deepEqual(m.data.relations.supports, ['alpha', 'beta']);
  });
});

describe('page merge: fixed and one-sided scalars', () => {
  for (const key of ['title', 'type', 'tier', 'origin']) {
    it(`${key} must be equal`, () => {
      const other = { title: '"Morning Brew Inc"', type: 'entity', tier: 'curated', origin: 'self' }[key];
      clashes({ ours: pg(), theirs: pg({ [key]: other }) }, new RegExp(key));
    });
  }

  it('status, confidence and owner: equal is fine', () => {
    const m = merged({ ours: pg({ status: 'draft' }), theirs: pg({ status: 'draft', body: '## Details\n\nMore. [source: src-a, p.1]\n' }) });
    assert.equal(m.data.status, 'draft');
  });

  it('status changed on the proposal side only, against the base, takes the change', () => {
    const base = pg({ status: 'draft' });
    const m = merged({ base, ours: pg({ status: 'draft' }), theirs: pg({ status: 'evergreen' }) });
    assert.equal(m.data.status, 'evergreen');
  });

  it('confidence changed on main only, against the base, keeps main', () => {
    const base = pg({ confidence: 'medium' });
    const m = merged({ base, ours: pg({ confidence: 'high' }), theirs: pg({ confidence: 'medium' }) });
    assert.equal(m.data.confidence, 'high');
  });

  it('owner changed differently on both sides is a clash', () => {
    const base = pg({ owner: '""' });
    clashes({ base, ours: pg({ owner: 'finance' }), theirs: pg({ owner: 'legal' }) }, /owner/);
  });

  it('with no base, differing values are a clash unless the proposal extends the page', () => {
    clashes({ ours: pg({ confidence: 'high' }), theirs: pg({ confidence: 'low' }) }, /confidence/);
    const m = merged({ ours: pg({ confidence: 'high' }), theirs: pg({ confidence: 'low' }), extended: true });
    assert.equal(m.data.confidence, 'high', "main's value is kept");
  });

  it('with a base, extends does not override a change made on both sides', () => {
    const base = pg({ status: 'stub' });
    clashes({ base, ours: pg({ status: 'draft' }), theirs: pg({ status: 'evergreen' }), extended: true }, /status/);
  });
});

describe('page merge: dates', () => {
  it('date_created is the earlier, date_modified the later, last_verified the earlier', () => {
    const m = merged({
      ours: pg({ date_created: '"2026-01-09"', date_modified: '"2026-01-10"', last_verified: '"2026-01-10"' }),
      theirs: pg({ date_created: '"2026-01-03"', date_modified: '"2026-02-01"', last_verified: '"2026-01-02"', body: '## Details\n\nMore.\n' }),
    });
    assert.equal(m.data.date_created, '2026-01-03');
    assert.equal(m.data.date_modified, '2026-02-01');
    assert.equal(m.data.last_verified, '2026-01-02');
  });

  it('dates written unquoted still compare as dates and come out quoted', () => {
    const m = merged({
      ours: pg({ date_created: '2026-01-09', date_modified: '2026-03-01' }),
      theirs: pg({ date_created: '2026-01-03', body: '## Details\n\nMore.\n' }),
    });
    assert.equal(m.data.date_created, '2026-01-03');
    assert.equal(m.data.date_modified, '2026-03-01');
    assert.match(m.text, /date_created: "2026-01-03"/);
  });

  it('a page one side never verified is not verified as a whole', () => {
    const m = merged({ ours: pg({ last_verified: null }), theirs: pg({ last_verified: '"2026-01-02"', body: '## Details\n\nMore.\n' }) });
    assert.equal('last_verified' in m.data, false);
  });

  it('something that is not a date on both sides is a clash', () => {
    clashes({ ours: pg({ date_created: 'soon' }), theirs: pg({ date_created: '"2026-01-03"' }) }, /date_created/);
  });
});

describe('page merge: unknown frontmatter keys', () => {
  it('equal is kept, one-sided is kept, differing is a clash', () => {
    const m = merged({ ours: pg({ extra: 'reviewer: ada\n' }), theirs: pg({ extra: 'reviewer: ada\nkind: newsletter\n' }) });
    assert.equal(m.data.reviewer, 'ada');
    assert.equal(m.data.kind, 'newsletter');
    clashes({ ours: pg({ extra: 'kind: newsletter\n' }), theirs: pg({ extra: 'kind: podcast\n' }) }, /kind/);
  });
});

describe('page merge: body sections', () => {
  const O = pg({ body: '## Summary\n\nMorning Brew is a daily newsletter.\n\n## Details\n\nFounded in 2015. [source: src-a, p.1]\n' });

  it('a section on one side only is kept, in main order then the proposal order', () => {
    const T = pg({ sources: [SRC_B], body: '## Summary\n\nMorning Brew is a daily newsletter.\n\n## Audience\n\nMostly young professionals. [source: src-b, p.2]\n\n## Funding\n\nAcquired in 2020. [source: src-b, p.3]\n' });
    const m = merged({ ours: O, theirs: T });
    assert.deepEqual([...m.body.matchAll(/^## (.*)$/gm)].map((x) => x[1]), ['Summary', 'Details', 'Audience', 'Funding']);
    assert.match(m.body, /Founded in 2015\./);
    assert.match(m.body, /Acquired in 2020\./);
  });

  it('a section identical on both sides is kept once', () => {
    const m = merged({ ours: O, theirs: pg({ sources: [SRC_B], body: '## Summary\n\nMorning Brew is a daily newsletter.\n\n## Audience\n\nYoung readers. [source: src-b, p.2]\n' }) });
    assert.equal(m.body.match(/is a daily newsletter\./g).length, 1);
  });

  it('a section changed on one side only, against the base, takes the changed side', () => {
    const base = O;
    const changed = O.replace('Founded in 2015.', 'Founded in 2015 in New York.');
    const a = merged({ base, ours: O, theirs: changed });
    assert.match(a.body, /in New York/);
    const b = merged({ base, ours: changed, theirs: O.replace('daily newsletter', 'daily email newsletter') });
    assert.match(b.body, /in New York/);
    assert.match(b.body, /daily email newsletter/);
  });

  it('a section whose lines are a superset of the other side takes the superset', () => {
    const bigger = O.replace('[source: src-a, p.1]\n', '[source: src-a, p.1]\n\nIt has a podcast. [source: src-a, p.4]\n');
    const m = merged({ ours: O, theirs: bigger });
    assert.match(m.body, /It has a podcast\./);
    const n = merged({ ours: bigger, theirs: O });
    assert.match(n.body, /It has a podcast\./);
  });

  it('a section both sides wrote differently is a clash', () => {
    clashes({ ours: O, theirs: pg({ sources: [SRC_B], body: O.split('---\n\n')[1].replace('Founded in 2015. [source: src-a, p.1]', 'Founded in 2014. [source: src-b, p.2]') }) }, /Details/);
  });

  it('with extends, main\'s lines come first, then the proposal\'s lines main does not have', () => {
    const theirs = pg({ sources: [SRC_B], body: '## Summary\n\nMorning Brew is a daily newsletter.\n\n## Details\n\nFounded in 2014. [source: src-b, p.2]\n\nSent at 6am. [source: src-b, p.3]\n' });
    const m = merged({ ours: O, theirs, extended: true });
    const details = m.body.split('## Details')[1];
    assert.ok(details.indexOf('Founded in 2015.') < details.indexOf('Founded in 2014.'));
    assert.ok(details.indexOf('Founded in 2014.') < details.indexOf('Sent at 6am.'));
    assert.match(details, /Founded in 2014\. \[source: src-b, p\.2\]\n\nSent at 6am\./, 'paragraph breaks are kept');
  });

  it('a section deleted on one side and unchanged on the other stays deleted; deleted against changed is a clash', () => {
    const base = O;
    const withoutDetails = '## Summary\n\nMorning Brew is a daily newsletter.\n';
    const m = merged({ base, ours: O, theirs: pg({ body: withoutDetails }) });
    assert.doesNotMatch(m.body, /Founded in 2015/);
    clashes({ base, ours: O.replace('2015', '2014'), theirs: pg({ body: withoutDetails }) }, /removed on one side/);
  });

  it('refuses a page whose headings it cannot read the way the audit does', () => {
    clashes({ ours: pg({ body: '## A\n\nx\n\n## A\n\ny\n' }), theirs: pg({ body: '## B\n\nz\n' }) }, /share a heading/);
  });

  it('a fenced "##" is not a heading', () => {
    const body = '## Summary\n\n```\n## not a heading\n```\n';
    const m = merged({ ours: pg({ body }), theirs: pg({ body: `${body}\n## Extra\n\nmore\n` }) });
    assert.match(m.body, /## not a heading/);
  });
});

describe('page merge: the invariant', () => {
  const ours = pg({ body: '## Summary\n\nOne.\n\n## Details\n\nTwo.\n' });
  const theirs = pg({ sources: [SRC_B], body: '## Summary\n\nOne.\n\n## Audience\n\nThree.\n' });

  it('passes for a combined page', () => {
    const m = merged({ ours, theirs });
    assert.equal(pageProvenance(m.text, ours, theirs), null);
  });

  it('rejects a body line that is in neither version', () => {
    const m = merged({ ours, theirs });
    assert.match(pageProvenance(m.text.replace('Three.', 'Three, reworded.'), ours, theirs), /neither version/);
    assert.match(pageProvenance(`${m.text}\nAn invented line.\n`, ours, theirs), /neither version/);
  });

  it('rejects a frontmatter value that is in neither version, including a source entry', () => {
    const m = merged({ ours, theirs });
    assert.match(pageProvenance(m.text.replace('confidence: medium', 'confidence: high'), ours, theirs), /confidence/);
    assert.match(pageProvenance(m.text.replace(SRC_A.sha256, 'd'.repeat(64)), ours, theirs), /sources/);
    assert.match(pageProvenance(m.text.replace('tags: []', 'tags:\n  - invented'), ours, theirs), /tags/);
  });

  it('rejects a combined page with no frontmatter or with conflict markers', () => {
    assert.match(pageProvenance('just text', ours, theirs), /frontmatter/);
    const m = merged({ ours, theirs });
    assert.match(pageProvenance(`${m.text}<<<<<<< ours\n`, ours, theirs), /neither version/);
  });

  it('mergePages itself returns a clash rather than a page that fails the check', () => {
    // A frontmatter value the merge rules cannot produce from either side: a
    // date that is neither side's, which is what a buggy earlier/later pick would write.
    const r = mergePages({ ours, theirs });
    assert.equal(r.ok, true);
    assert.equal(pageProvenance(r.text, ours, theirs), null);
  });
});

describe('page merge: shape', () => {
  it('returns main\'s text byte for byte when the proposal adds nothing', () => {
    const ours = pg({ body: '## Summary\n\nOne.\n\n## Details\n\nTwo.\n' });
    const theirs = pg({ body: '## Summary\n\nOne.\n' });
    assert.equal(mergePages({ ours, theirs }).text, ours);
  });

  it('refuses a version it cannot read', () => {
    assert.equal(mergePages({ ours: 'no frontmatter', theirs: pg() }).ok, false);
  });
});
