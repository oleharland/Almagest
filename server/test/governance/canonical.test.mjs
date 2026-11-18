import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { canonicalSet, differOnlyInTier, tierOfText, withTier } from '../../../tools/lib/canonical.mjs';
import { canonicalAt } from '../../src/governance/canonical.mjs';
import { cleanup, git, govApp, page, repo } from './fixtures.mjs';

after(cleanup);

describe('the canonical set', () => {
  it('reads the config list, the tiers, or both', () => {
    assert.deepEqual([...canonicalSet({ configPages: ['[[a]]', 'wiki/b.md'] })].sort(), ['a', 'b']);
    assert.deepEqual([...canonicalSet({ tiers: new Map([['c', 'canonical'], ['d', 'curated'], ['e', 'Canonical']]) })].sort(), ['c', 'e']);
    assert.deepEqual([...canonicalSet({ configPages: ['a'], tiers: [['a', 'canonical'], ['c', 'canonical']] })].sort(), ['a', 'c']);
    assert.equal(canonicalSet().size, 0);
  });

  it('parses the tier as frontmatter and edits only that line', () => {
    const text = page({ title: 'T', body: 'Body tier: canonical', tier: 'curated' });
    assert.equal(tierOfText(text), 'curated');
    assert.equal(tierOfText('no frontmatter\ntier: canonical'), '');
    const next = withTier(text, 'canonical');
    assert.equal(tierOfText(next), 'canonical');
    assert.equal(text.split('\n').filter((l, i) => l !== next.split('\n')[i]).length, 1);
    assert.ok(differOnlyInTier(text, next));
    assert.ok(!differOnlyInTier(text, next.replace('Body', 'Other')));
    assert.equal(withTier('---\ntitle: x\n---\nbody', 'curated'), null);
  });

  it('reads main from git: config only, frontmatter only, both', async () => {
    const r = repo();
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    const { git: g, config } = app.ctx;
    assert.equal((await canonicalAt(g, config)).size, 0);
    const wt = await g.worktreeAdd('main');
    const fs = await import('node:fs');
    const f = `${wt}/brain/wiki/beta.md`;
    fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').replace('tier: curated', 'tier: "canonical"'));
    await g.commitAll(wt, { message: 'x', author: { name: 'H', email: 'h@h' } });
    await g.worktreeRemove(wt);
    assert.deepEqual([...(await canonicalAt(g, config))], ['beta']);
    const cfg = { ...config, v1: { ...config.v1, canonicalPages: ['alpha'] } };
    assert.deepEqual([...(await canonicalAt(g, cfg))].sort(), ['alpha', 'beta']);
    await app.stop();
  });
});
