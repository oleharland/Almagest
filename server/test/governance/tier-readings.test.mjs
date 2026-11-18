/**
 * Two parsers read a page's tier: tierOfText (the guard: a front matter block
 * cut out by a pattern and parsed with `yaml`) and gray-matter through
 * safeFrontmatter (what the audit and the site read). If they can disagree, an
 * agent could write a page one reads as canonical and the other does not.
 * The guard treats every page where they differ, or where either cannot read
 * the tier, as an attempt to set canonical.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import matter from 'gray-matter';

import { canonicalOrUnsure, tierOfText, tierReadings } from '../../../tools/lib/canonical.mjs';
import { safeFrontmatter } from '../../../tools/lib/wiki-core.mjs';
import { createMerger } from '../../src/governance/merge.mjs';
import { writableMatcher } from '../../src/governance/paths.mjs';
import { CLEAN_AUDIT, cleanup, DELTA, G, git, govApp, job, proposalBranch, repo } from './fixtures.mjs';

after(cleanup);

/** What the audit sees: gray-matter through safeFrontmatter, the tier as text, lower case; null when it will not parse. */
const parse = safeFrontmatter(matter);
function auditReading(text) {
  try {
    const d = parse(text).data;
    const v = d && typeof d === 'object' ? d.tier : '';
    return v == null ? '' : String(v).trim().toLowerCase();
  } catch { return null; }
}

// [name, text, true when the audit would read this page as canonical]
const INPUTS = [
  ['plain', '---\ntitle: x\ntier: canonical\n---\nbody\n'],
  ['byte order mark', '﻿---\ntier: canonical\n---\nbody\n'],
  ['Windows line endings', '---\r\ntier: canonical\r\n---\r\nbody\r\n'],
  ['---yaml opening', '---yaml\ntier: canonical\n---\nbody\n'],
  ['---yml opening', '---yml\ntier: canonical\n---\nbody\n'],
  ['--- yaml opening', '--- yaml\ntier: canonical\n---\nbody\n'],
  ['leading blank line', '\n---\ntier: canonical\n---\nbody\n'],
  ['duplicate tier, canonical first', '---\ntier: canonical\ntier: curated\n---\nbody\n'],
  ['duplicate tier, canonical last', '---\ntier: curated\ntier: canonical\n---\nbody\n'],
  ['capitalised', '---\ntier: Canonical\n---\nbody\n'],
  ['upper case', '---\ntier: CANONICAL\n---\nbody\n'],
  ['double quoted', '---\ntier: "canonical"\n---\nbody\n'],
  ['single quoted', "---\ntier: 'canonical'\n---\nbody\n"],
  ['flow list', '---\ntier: [canonical]\n---\nbody\n'],
  ['block list', '---\ntier:\n  - canonical\n---\nbody\n'],
  ['folded scalar', '---\ntier: >\n  canonical\n---\nbody\n'],
  ['literal scalar', '---\ntier: |\n  canonical\n---\nbody\n'],
  ['no closing delimiter', '---\ntitle: x\ntier: canonical\n'],
  ['a close that is not one', '---\ntitle: x\n---not-a-close\ntier: canonical\n---\nbody\n'],
  ['trailing space after the opening', '---  \ntier: canonical\n---\nbody\n'],
  ['trailing space after the closing', '---\ntier: canonical\n---  \nbody\n'],
  ['second block in the body', '---\ntitle: x\n---\nbody\n---\ntier: canonical\n---\n'],
  ['second block after a curated one', '---\ntier: curated\n---\nbody\n---\ntier: canonical\n---\n'],
  ['anchor and alias', '---\nbase: &t canonical\ntier: *t\n---\nbody\n'],
  ['tab indent', '---\ntitle: x\n\ttier: canonical\n---\nbody\n'],
  ['tab in a nested block', '---\nrelations:\n\tx: y\ntier: canonical\n---\n'],
  ['merge key', '---\n<<: {tier: canonical}\n---\n'],
  ['complex key', '---\n? tier\n: canonical\n---\n'],
  ['quoted key', '---\n"tier": canonical\n---\n'],
  ['trailing comment', '---\ntier: canonical # note\n---\n'],
  ['js block', '---js\n{ tier: "canonical" }\n---\nbody\n'],
  ['a block that does not parse', '---\ntier: canonical\nfoo: [unclosed\n---\nbody\n'],
  ['four dashes', '----\ntier: canonical\n----\n'],
  ['indented close', '---\ntier: canonical\n ---\nbody\n'],
  ['document end marker', '---\ntier: canonical\n...\nbody\n'],
  ['canonical in a comment only', '---\n# tier: canonical\n---\nbody\n'],
  ['null tier', '---\ntier: ~\n---\n'],
  ['empty tier', '---\ntier:\n---\n'],
  ['no front matter', 'just text\n'],
  ['empty front matter', '---\n---\nbody\n'],
  ['curated', '---\ntier: curated\n---\nbody\n'],
  ['evidence', '---\ntier: evidence\n---\nbody\n'],
  ['---yaml opening, evidence', '---yaml\ntier: evidence\n---\nbody\n'],
  ['Windows line endings, curated', '---\r\ntier: curated\r\n---\r\nbody\r\n'],
  ['byte order mark, curated', '﻿---\ntier: curated\n---\nbody\n'],
];

// Inputs that are plainly fine: both readings agree on a tier that is not canonical.
const BENIGN = new Set(['canonical in a comment only', 'null tier', 'empty tier', 'no front matter', 'empty front matter', 'curated', 'evidence', 'Windows line endings, curated', 'byte order mark, curated', 'leading blank line', 'second block in the body', 'second block after a curated one']);

describe('the two readings of a page\'s tier', () => {
  for (const [name, text] of INPUTS) {
    it(`${name}: the guard refuses whenever the audit could read canonical, or the two differ`, () => {
      const r = tierReadings(text);
      const audit = auditReading(text);
      assert.equal(r.matter, audit, 'tierReadings reads the way the audit does');
      const refuses = canonicalOrUnsure(text);
      if (audit === 'canonical' || r.yaml === 'canonical') assert.equal(refuses, true, 'a page that can be canonical is refused');
      if (r.yaml !== r.matter) assert.equal(refuses, true, 'a disagreement is refused');
      if (r.yaml === null || r.matter === null) assert.equal(refuses, true, 'a tier that cannot be read is refused');
      if (BENIGN.has(name)) assert.equal(refuses, false, `${name} is not an attempt`);
    });
  }

  it('the guard alone (tierOfText) read at least these pages as not canonical while the audit reads them as canonical', () => {
    // Recorded so the reason for tierReadings stays visible: each of these slipped past tierOfText.
    const slipped = INPUTS.filter(([, text]) => auditReading(text) === 'canonical' && tierOfText(text) !== 'canonical').map(([name]) => name);
    assert.deepEqual(slipped.sort(), ['---yaml opening', '---yml opening', '--- yaml opening', 'merge key', 'no closing delimiter', 'tab indent', 'tab in a nested block'].sort());
    for (const [name, text] of INPUTS) if (slipped.includes(name)) assert.equal(canonicalOrUnsure(text), true, name);
  });

  it('a tier that is not canonical and that both readings agree on is not refused', () => {
    for (const text of ['---\ntier: curated\n---\nb\n', '---\ntier: evidence\n---\nb\n', 'no front matter\n', '---\ntitle: x\n---\nb\n']) assert.equal(canonicalOrUnsure(text), false, text);
    assert.equal(canonicalOrUnsure(null), false);
  });
});

describe('the merge refuses a page the two readings disagree about', () => {
  const merger = (app) => {
    const { config, git: g, log } = app.ctx;
    return createMerger({ git: g, config, log, allowed: writableMatcher({ brainDir: config.v1.brainDir, manifestPath: config.v1.manifestPath, challengesPath: config.v1.challengesPath, indexDir: config.v1.indexDir }) });
  };

  for (const [name, edit] of [
    ['a ---yaml opening', (t) => t.replace(/^---\n/, '---yaml\n').replace('tier: curated', 'tier: canonical')],
    ['a tab in the front matter', (t) => t.replace('tier: curated', 'tier: canonical').replace('\ntype:', '\n\ttype:')],
  ]) {
    it(`${name} that says canonical never reaches main`, async () => {
      const r = repo();
      git(r, 'checkout', '-q', '--detach');
      const app = await govApp(r);
      const branch = 'ingest/q3-board-deck-abcdef1';
      const b = await proposalBranch(app, branch, { 'brain/wiki/delta.md': edit(DELTA) });
      const p = await G(app).createFromJob(job(branch), { ...b, audit: CLEAN_AUDIT, runReport: { source: { id: 'alpha-pdf' }, outcome: 'written', pages: [] } });
      assert.equal(p.changes[0].promotes, true, 'the inbox shows it as made canonical without a person choosing it');
      assert.ok((await G(app).evaluate(p.id)).evaluation.blockers.some((x) => x.code === 'canonical'));
      const before = git(r, 'rev-parse', 'main').trim();
      const out = await merger(app).merge(await G(app).getProposal(p.id), { approvers: [{ display: 'Ada', actorId: 'usr_ada', channel: 'web' }], author: { name: 'Ada', email: 'a@a' } });
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'canonical');
      assert.equal(git(r, 'rev-parse', 'main').trim(), before);
      await app.stop();
    });
  }
});
