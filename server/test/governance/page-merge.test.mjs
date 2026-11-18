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

const merged = async (args) => {
  const r = await mergePages(args);
  assert.equal(r.ok, true, r.reason);
  return { text: r.text, ...parsePage(r.text) };
};
const clashes = async (args, re) => {
  const r = await mergePages(args);
  assert.equal(r.ok, false, 'expected a clash');
  if (re) assert.match(r.reason, re);
};

describe('page merge: frontmatter lists', () => {
  it('unions sources by id, main first', async () => {
    const m = await merged({ ours: pg({ sources: [SRC_A] }), theirs: pg({ sources: [SRC_B, SRC_A] }) });
    assert.deepEqual(m.data.sources.map((s) => s.id), ['src-a', 'src-b']);
  });

  it('the same source id with a different path is a clash', async () => {
    await clashes({ ours: pg({ sources: [SRC_A] }), theirs: pg({ sources: [{ ...SRC_A, path: 'brain/raw/extracted/other.txt' }] }) }, /src-a/);
  });

  it('the same source id with a different sha256 is a clash', async () => {
    await clashes({ ours: pg({ sources: [SRC_A] }), theirs: pg({ sources: [{ ...SRC_A, sha256: 'c'.repeat(64) }] }) }, /src-a/);
  });

  it('unions aliases, tags, related and each relations list, main first', async () => {
    const m = await merged({
      ours: pg({ aliases: ['MB', 'Brew'], tags: ['news'], related: ['beta'], relations: ['alpha'] }),
      theirs: pg({ aliases: ['Brew', 'Morning Brew Daily'], tags: ['email', 'news'], related: ['gamma-claim'], relations: ['beta', 'alpha'] }),
    });
    assert.deepEqual(m.data.aliases, ['MB', 'Brew', 'Morning Brew Daily']);
    assert.deepEqual(m.data.tags, ['news', 'email']);
    assert.deepEqual(m.data.related, ['[[beta]]', '[[gamma-claim]]']);
    assert.deepEqual(m.data.relations.supports, ['alpha', 'beta']);
  });
});

describe('page merge: frontmatter lists, with a common version', () => {
  const base = pg({ sources: [SRC_A, SRC_B], aliases: ['Old'], relations: ['y'] });

  it('a source, alias and relation that main removed since the base do not come back', async () => {
    const ours = pg({ sources: [SRC_A], aliases: [], relations: [] });
    const theirs = pg({ sources: [SRC_A, SRC_B], aliases: ['Old', 'New'], relations: ['y', 'z'] });
    const m = await merged({ base, ours, theirs });
    assert.deepEqual(m.data.sources.map((x) => x.id), ['src-a']);
    assert.deepEqual(m.data.aliases, ['New']);
    assert.deepEqual(m.data.relations.supports, ['z']);
  });

  it('a removal made on the proposal side stays removed too', async () => {
    const ours = pg({ sources: [SRC_A, SRC_B], aliases: ['Old', 'Mine'], relations: ['y'] });
    const theirs = pg({ sources: [SRC_A], aliases: [], relations: [] });
    const m = await merged({ base, ours, theirs });
    assert.deepEqual(m.data.sources.map((x) => x.id), ['src-a']);
    assert.deepEqual(m.data.aliases, ['Mine']);
    assert.deepEqual(m.data.relations.supports, []);
  });

  it('additions from both sides are kept, main first', async () => {
    const m = await merged({ base, ours: pg({ sources: [SRC_A, SRC_B], aliases: ['Old', 'A1'], relations: ['y'] }), theirs: pg({ sources: [SRC_A, SRC_B], aliases: ['Old', 'B1'], relations: ['y'] }) });
    assert.deepEqual(m.data.aliases, ['Old', 'A1', 'B1']);
  });

  it('a source removed on one side and changed on the other is a clash', async () => {
    await clashes({ base, ours: pg({ sources: [SRC_A], aliases: ['Old'], relations: ['y'] }), theirs: pg({ sources: [SRC_A, { ...SRC_B, title: 'Renamed' }], aliases: ['Old'], relations: ['y'] }) }, /src-b/);
  });

  it('the same source id with different content on the two sides is a clash, whatever the base says', async () => {
    await clashes({ base, ours: pg({ sources: [SRC_A, SRC_B] }), theirs: pg({ sources: [SRC_A, { ...SRC_B, title: 'Renamed' }] }) }, /src-b/);
    await clashes({ ours: pg({ sources: [SRC_A] }), theirs: pg({ sources: [{ ...SRC_A, title: 'Renamed' }] }) }, /src-a/);
  });

  it('extends has no effect on any of this', async () => {
    const ours = pg({ sources: [SRC_A], aliases: [], relations: [] });
    const theirs = pg({ sources: [SRC_A, SRC_B], aliases: ['Old', 'New'], relations: ['y', 'z'] });
    const m = await merged({ base, ours, theirs, extended: true });
    assert.deepEqual(m.data.aliases, ['New']);
  });
});

describe('page merge: fixed and one-sided scalars', () => {
  for (const key of ['title', 'type', 'tier', 'origin']) {
    it(`${key} must be equal`, async () => {
      const other = { title: '"Morning Brew Inc"', type: 'entity', tier: 'curated', origin: 'self' }[key];
      await clashes({ ours: pg(), theirs: pg({ [key]: other }) }, new RegExp(key));
    });
  }

  it('status, confidence and owner: equal is fine', async () => {
    const m = await merged({ ours: pg({ status: 'draft' }), theirs: pg({ status: 'draft', body: '## Details\n\nMore. [source: src-a, p.1]\n' }) });
    assert.equal(m.data.status, 'draft');
  });

  it('status changed on the proposal side only, against the base, takes the change', async () => {
    const base = pg({ status: 'draft' });
    const m = await merged({ base, ours: pg({ status: 'draft' }), theirs: pg({ status: 'evergreen' }) });
    assert.equal(m.data.status, 'evergreen');
  });

  it('confidence changed on main only, against the base, keeps main', async () => {
    const base = pg({ confidence: 'medium' });
    const m = await merged({ base, ours: pg({ confidence: 'high' }), theirs: pg({ confidence: 'medium' }) });
    assert.equal(m.data.confidence, 'high');
  });

  it('owner changed differently on both sides is a clash', async () => {
    const base = pg({ owner: '""' });
    await clashes({ base, ours: pg({ owner: 'finance' }), theirs: pg({ owner: 'legal' }) }, /owner/);
  });

  it('with no base, any difference is a clash, and extends does not change that', async () => {
    await clashes({ ours: pg({ confidence: 'high' }), theirs: pg({ confidence: 'low' }) }, /confidence/);
    await clashes({ ours: pg({ confidence: 'high' }), theirs: pg({ confidence: 'low' }), extended: true }, /confidence/);
    await clashes({ ours: pg({ status: 'active' }), theirs: pg({ status: 'deprecated' }), extended: true }, /status/);
    await clashes({ ours: pg({ owner: 'finance' }), theirs: pg({ owner: 'legal' }), extended: true }, /owner/);
  });

  it('with a base, extends does not override a change made on both sides', async () => {
    const base = pg({ status: 'stub' });
    await clashes({ base, ours: pg({ status: 'draft' }), theirs: pg({ status: 'evergreen' }), extended: true }, /status/);
  });

  it('with a base, a lowered confidence on one side is kept, and a different one on both sides is a clash', async () => {
    const base = pg({ confidence: 'high' });
    assert.equal((await merged({ base, ours: pg({ confidence: 'high' }), theirs: pg({ confidence: 'low' }) })).data.confidence, 'low');
    await clashes({ base, ours: pg({ confidence: 'medium' }), theirs: pg({ confidence: 'low' }) }, /confidence/);
  });
});

describe('page merge: dates', () => {
  it('date_created is the earlier, date_modified the later, last_verified the earlier', async () => {
    const m = await merged({
      ours: pg({ date_created: '"2026-01-09"', date_modified: '"2026-01-10"', last_verified: '"2026-01-10"' }),
      theirs: pg({ date_created: '"2026-01-03"', date_modified: '"2026-02-01"', last_verified: '"2026-01-02"', body: '## Details\n\nMore.\n' }),
    });
    assert.equal(m.data.date_created, '2026-01-03');
    assert.equal(m.data.date_modified, '2026-02-01');
    assert.equal(m.data.last_verified, '2026-01-02');
  });

  it('dates written unquoted still compare as dates and come out quoted', async () => {
    const m = await merged({
      ours: pg({ date_created: '2026-01-09', date_modified: '2026-03-01' }),
      theirs: pg({ date_created: '2026-01-03', body: '## Details\n\nMore.\n' }),
    });
    assert.equal(m.data.date_created, '2026-01-03');
    assert.equal(m.data.date_modified, '2026-03-01');
    assert.match(m.text, /date_created: "2026-01-03"/);
  });

  it('a page one side never verified is not verified as a whole', async () => {
    const m = await merged({ ours: pg({ last_verified: null }), theirs: pg({ last_verified: '"2026-01-02"', body: '## Details\n\nMore.\n' }) });
    assert.equal('last_verified' in m.data, false);
  });

  it('something that is not a date on both sides is a clash', async () => {
    await clashes({ ours: pg({ date_created: 'soon' }), theirs: pg({ date_created: '"2026-01-03"' }) }, /date_created/);
  });
});

describe('page merge: unknown frontmatter keys', () => {
  it('equal is kept, any difference with no base is a clash', async () => {
    const m = await merged({ ours: pg({ extra: 'reviewer: ada\n' }), theirs: pg({ extra: 'reviewer: ada\n', body: '## Details\n\nMore.\n' }) });
    assert.equal(m.data.reviewer, 'ada');
    await clashes({ ours: pg({ extra: 'kind: newsletter\n' }), theirs: pg({ extra: 'kind: podcast\n' }) }, /kind/);
    await clashes({ ours: pg({ extra: 'reviewer: ada\n' }), theirs: pg({ extra: 'reviewer: ada\nkind: newsletter\n' }) }, /kind/);
  });

  it('with a base, a key changed on one side only is taken, and a removal against an unchanged value stays', async () => {
    const base = pg({ extra: 'kind: newsletter\n' });
    assert.equal((await merged({ base, ours: pg({ extra: 'kind: newsletter\n' }), theirs: pg({ extra: 'kind: podcast\n' }) })).data.kind, 'podcast');
    assert.equal('kind' in (await merged({ base, ours: pg(), theirs: pg({ extra: 'kind: newsletter\n' }) })).data, false);
    await clashes({ base, ours: pg(), theirs: pg({ extra: 'kind: podcast\n' }) }, /kind/);
  });
});

describe('page merge: body sections', () => {
  const O = pg({ body: '## Summary\n\nMorning Brew is a daily newsletter.\n\n## Details\n\nFounded in 2015. [source: src-a, p.1]\n' });

  it('a section on one side only is kept, in main order then the proposal order', async () => {
    const T = pg({ sources: [SRC_B], body: '## Summary\n\nMorning Brew is a daily newsletter.\n\n## Audience\n\nMostly young professionals. [source: src-b, p.2]\n\n## Funding\n\nAcquired in 2020. [source: src-b, p.3]\n' });
    const m = await merged({ ours: O, theirs: T });
    assert.deepEqual([...m.body.matchAll(/^## (.*)$/gm)].map((x) => x[1]), ['Summary', 'Details', 'Audience', 'Funding']);
    assert.match(m.body, /Founded in 2015\./);
    assert.match(m.body, /Acquired in 2020\./);
  });

  it('a section identical on both sides is kept once', async () => {
    const m = await merged({ ours: O, theirs: pg({ sources: [SRC_B], body: '## Summary\n\nMorning Brew is a daily newsletter.\n\n## Audience\n\nYoung readers. [source: src-b, p.2]\n' }) });
    assert.equal(m.body.match(/is a daily newsletter\./g).length, 1);
  });

  it('a section changed on one side only, against the base, takes the changed side', async () => {
    const base = O;
    const changed = O.replace('Founded in 2015.', 'Founded in 2015 in New York.');
    const a = await merged({ base, ours: O, theirs: changed });
    assert.match(a.body, /in New York/);
    const b = await merged({ base, ours: changed, theirs: O.replace('daily newsletter', 'daily email newsletter') });
    assert.match(b.body, /in New York/);
    assert.match(b.body, /daily email newsletter/);
  });

  it('with no base, a section that is the other side\'s text with whole lines appended takes the longer one', async () => {
    const bigger = O.replace('[source: src-a, p.1]\n', '[source: src-a, p.1]\n\nIt has a podcast. [source: src-a, p.4]\n');
    const m = await merged({ ours: O, theirs: bigger });
    assert.match(m.body, /It has a podcast\./);
    const n = await merged({ ours: bigger, theirs: O });
    assert.match(n.body, /It has a podcast\./);
  });

  it('with no base, a superset that is not the other text followed by more lines is a clash', async () => {
    const withExtra = O.replace('## Details\n\n', '## Details\n\nIt has a podcast. [source: src-a, p.4]\n');
    await clashes({ ours: O, theirs: withExtra }, /Details/);
    await clashes({ ours: withExtra, theirs: O }, /Details/);
  });

  it('with no base, the same lines under other labels are a clash, not a superset', async () => {
    const ours = pg({ body: '## Affected\n\nThe following are affected:\n- A\nThe following are not affected:\n- B\n' });
    const theirs = pg({ body: '## Affected\n\nThe following are not affected:\n- A\n' });
    await clashes({ ours, theirs }, /Affected/);
    await clashes({ ours: theirs, theirs: ours }, /Affected/);
  });

  it('extends changes nothing: a section both sides wrote differently is a clash with or without it', async () => {
    const theirs = pg({ sources: [SRC_B], body: '## Summary\n\nMorning Brew is a daily newsletter.\n\n## Details\n\nFounded in 2014. [source: src-b, p.2]\n\nSent at 6am. [source: src-b, p.3]\n' });
    await clashes({ ours: O, theirs }, /Details/);
    await clashes({ ours: O, theirs, extended: true }, /Details/);
    const ours = pg({ body: '## Platforms\n\nDeprecated:\n- Solaris\nSupported:\n- macOS\n' });
    const head = pg({ body: '## Platforms\n\nSupported:\n- Windows\nDeprecated:\n- Linux\n' });
    await clashes({ ours, theirs: head, extended: true }, /Platforms/);
  });

  describe('with a common version, a section is merged line by line against the base', () => {
    const base = pg({ body: '## Facts\n\nA line. [source: src-a, p.1]\nKeep one.\nKeep two.\nB line. [source: src-b, p.2]\n\n## Other\n\nUnrelated.\n' });

    it('changes to different lines on the two sides are both kept', async () => {
      const ours = pg({ body: base.split('---\n\n')[1].replace('A line.', 'A line, main.') });
      const theirs = pg({ body: base.split('---\n\n')[1].replace('B line.', 'B line, head.') });
      const m = await merged({ base, ours, theirs });
      assert.match(m.body, /A line, main\./);
      assert.match(m.body, /B line, head\./);
    });

    it('a line main removed does not come back when the head still has it and adds another', async () => {
      const text = base.split('---\n\n')[1];
      const ours = pg({ body: text.replace('B line. [source: src-b, p.2]\n', '') });
      const theirs = pg({ body: text.replace('A line. [source: src-a, p.1]\n', 'A line. [source: src-a, p.1]\nAdded line. [source: src-a, p.3]\n') });
      const m = await merged({ base, ours, theirs });
      assert.match(m.body, /Added line\./);
      assert.doesNotMatch(m.body, /B line\./);
    });

    it('a removal and an addition on touching lines are a clash', async () => {
      const text = base.split('---\n\n')[1];
      const ours = pg({ body: text.replace('B line. [source: src-b, p.2]\n', '') });
      const theirs = pg({ body: text.replace('B line. [source: src-b, p.2]\n', 'B line. [source: src-b, p.2]\nAdded line. [source: src-a, p.3]\n') });
      await clashes({ base, ours, theirs }, /Facts/);
    });

    it('the same line changed two ways is a clash', async () => {
      const text = base.split('---\n\n')[1];
      await clashes({ base, ours: pg({ body: text.replace('Keep one.', 'Keep one, main.') }), theirs: pg({ body: text.replace('Keep one.', 'Keep one, head.') }) }, /Facts/);
    });

    it('extends does not turn a conflicting section into a merge', async () => {
      const text = base.split('---\n\n')[1];
      await clashes({ base, ours: pg({ body: text.replace('Keep one.', 'Keep one, main.') }), theirs: pg({ body: text.replace('Keep one.', 'Keep one, head.') }), extended: true }, /Facts/);
    });

    it('a section both sides added, that the base does not have, follows the no-base rule', async () => {
      const text = base.split('---\n\n')[1];
      const ours = pg({ body: `${text}\n## New\n\nOne.\n` });
      const longer = pg({ body: `${text}\n## New\n\nOne.\nTwo.\n` });
      assert.match((await merged({ base, ours, theirs: longer })).body, /Two\./);
      await clashes({ base, ours, theirs: pg({ body: `${text}\n## New\n\nOther.\n` }) }, /New/);
    });

    it('a section added on one side only is kept', async () => {
      const text = base.split('---\n\n')[1];
      const m = await merged({ base, ours: pg({ body: text }), theirs: pg({ body: `${text}\n## New\n\nOne.\n` }) });
      assert.match(m.body, /## New/);
    });
  });

  it('a section both sides wrote differently is a clash', async () => {
    await clashes({ ours: O, theirs: pg({ sources: [SRC_B], body: O.split('---\n\n')[1].replace('Founded in 2015. [source: src-a, p.1]', 'Founded in 2014. [source: src-b, p.2]') }) }, /Details/);
  });

  it('a section deleted on one side and unchanged on the other stays deleted; deleted against changed is a clash', async () => {
    const base = O;
    const withoutDetails = '## Summary\n\nMorning Brew is a daily newsletter.\n';
    const m = await merged({ base, ours: O, theirs: pg({ body: withoutDetails }) });
    assert.doesNotMatch(m.body, /Founded in 2015/);
    await clashes({ base, ours: O.replace('2015', '2014'), theirs: pg({ body: withoutDetails }) }, /removed on one side/);
  });

  it('refuses a page whose headings it cannot read the way the audit does', async () => {
    await clashes({ ours: pg({ body: '## A\n\nx\n\n## A\n\ny\n' }), theirs: pg({ body: '## B\n\nz\n' }) }, /share a heading/);
  });

  it('a fenced "##" is not a heading', async () => {
    const body = '## Summary\n\n```\n## not a heading\n```\n';
    const m = await merged({ ours: pg({ body }), theirs: pg({ body: `${body}\n## Extra\n\nmore\n` }) });
    assert.match(m.body, /## not a heading/);
  });
});

describe('page merge: the invariant', () => {
  const ours = pg({ body: '## Summary\n\nOne.\n\n## Details\n\nTwo.\n' });
  const theirs = pg({ sources: [SRC_B], body: '## Summary\n\nOne.\n\n## Audience\n\nThree.\n' });

  it('passes for a combined page', async () => {
    const m = await merged({ ours, theirs });
    assert.equal(pageProvenance(m.text, ours, theirs), null);
  });

  it('rejects a body line that is in neither version', async () => {
    const m = await merged({ ours, theirs });
    assert.match(pageProvenance(m.text.replace('Three.', 'Three, reworded.'), ours, theirs), /neither version/);
    assert.match(pageProvenance(`${m.text}\nAn invented line.\n`, ours, theirs), /neither version/);
  });

  it('rejects a frontmatter value that is in neither version, including a source entry', async () => {
    const m = await merged({ ours, theirs });
    assert.match(pageProvenance(m.text.replace('confidence: medium', 'confidence: high'), ours, theirs), /confidence/);
    assert.match(pageProvenance(m.text.replace(SRC_A.sha256, 'd'.repeat(64)), ours, theirs), /sources/);
    assert.match(pageProvenance(m.text.replace('tags: []', 'tags:\n  - invented'), ours, theirs), /tags/);
  });

  it('rejects a combined page with no frontmatter or with conflict markers', async () => {
    assert.match(pageProvenance('just text', ours, theirs), /frontmatter/);
    const m = await merged({ ours, theirs });
    assert.match(pageProvenance(`${m.text}<<<<<<< ours\n`, ours, theirs), /neither version/);
  });

  it('mergePages itself returns a clash rather than a page that fails the check', async () => {
    // A frontmatter value the merge rules cannot produce from either side: a
    // date that is neither side's, which is what a buggy earlier/later pick would write.
    const r = await mergePages({ ours, theirs });
    assert.equal(r.ok, true);
    assert.equal(pageProvenance(r.text, ours, theirs), null);
  });
});

describe('page merge: the invariant, order and removals', () => {
  const ours = pg({ body: '## Summary\n\nAlpha.\nBeta.\n' });
  const theirs = pg({ sources: [SRC_B], body: '## Extra\n\nGamma.\n' });

  it('rejects a result that puts the lines of one side in another order', async () => {
    const m = await merged({ ours, theirs });
    assert.equal(pageProvenance(m.text, ours, theirs), null);
    assert.match(pageProvenance(m.text.replace('Alpha.\nBeta.', 'Beta.\nAlpha.'), ours, theirs), /order/);
  });

  it('accepts lines from the two sides interleaved, each side in its own order', async () => {
    const base = pg({ body: '## Summary\n\nA.\nK1.\nK2.\nK3.\nC.\n' });
    const o = pg({ body: '## Summary\n\nA.\nO1.\nK1.\nK2.\nK3.\nC.\n' });
    const t = pg({ body: '## Summary\n\nA.\nK1.\nK2.\nK3.\nT1.\nC.\n' });
    const m = await merged({ base, ours: o, theirs: t });
    assert.match(m.body, /A\.\nO1\.\nK1\.\nK2\.\nK3\.\nT1\.\nC\./);
    assert.equal(pageProvenance(m.text, o, t, base), null);
  });

  it('with the common version, rejects a list item that a side removed', async () => {
    const base = pg({ aliases: ['Old'], sources: [SRC_A, SRC_B] });
    const o = pg({ aliases: [], sources: [SRC_A] });
    const t = pg({ aliases: ['Old', 'New'], sources: [SRC_A, SRC_B] });
    const m = await merged({ base, ours: o, theirs: t });
    assert.equal(pageProvenance(m.text, o, t, base), null);
    const back = m.text.replace('aliases:', 'aliases:\n  - Old').replace(/aliases:\n  - Old\n  - New/, 'aliases:\n  - Old\n  - New');
    assert.match(pageProvenance(back, o, t, base), /removed/);
  });
});

describe('page merge: shape', () => {
  it('returns main\'s text byte for byte when the proposal adds nothing', async () => {
    const ours = pg({ body: '## Summary\n\nOne.\n\n## Details\n\nTwo.\n' });
    const theirs = pg({ body: '## Summary\n\nOne.\n' });
    assert.equal((await mergePages({ ours, theirs })).text, ours);
  });

  it('refuses a version it cannot read', async () => {
    assert.equal((await mergePages({ ours: 'no frontmatter', theirs: pg() })).ok, false);
  });
});
