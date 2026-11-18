import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { cleanup, setup } from './_setup.mjs';

after(cleanup);
const DRIVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'canonical-driver.mjs');
const FIXTURE_BETA = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools/lib/__fixtures__/clean/brain/wiki/beta.md'), 'utf-8');
const asCanonical = (text) => text.replace('tier: curated', 'tier: canonical');

async function run(files, setupOpts = {}) {
  const plan = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-plan-')), 'plan.json');
  fs.writeFileSync(plan, JSON.stringify({ files, sourceId: 'x-md' }));
  process.env.CANON_PLAN = plan;
  const t = await setup({ ingest: { driver: 'shell', shell: { command: DRIVER }, max_attempts: 1 }, ...setupOpts });
  await t.app.start({ http: false });
  const done = await t.finished(await t.drop('x.md'));
  return { t, done };
}

describe('runner: an agent never sets or changes canonical', () => {
  it('refuses a new page with tier: canonical', async () => {
    const { t, done } = await run({ 'brain/wiki/fresh.md': asCanonical(FIXTURE_BETA) });
    assert.equal(done.status, 'failed');
    assert.match(done.error, /agent set tier: canonical on brain\/wiki\/fresh\.md — only a person makes a page canonical, in the review inbox \(non-negotiable 4\)/);
    assert.equal(t.governance.calls.length, 0);
    await t.stop();
  });

  it('refuses an existing page that goes from curated to canonical', async () => {
    const { t, done } = await run({ 'brain/wiki/beta.md': asCanonical(FIXTURE_BETA) });
    assert.equal(done.status, 'failed');
    assert.match(done.error, /agent set tier: canonical on brain\/wiki\/beta\.md/);
    await t.stop();
  });

  for (const [name, edit] of [
    ['a ---yaml opening line', (t) => t.replace(/^---\n/, '---yaml\n')],
    ['a tab in the front matter', (t) => t.replace('\ntype:', '\n\ttype:')],
    ['a front matter block with no closing line', (t) => `${t.split('\n---\n')[0]}\n`],
  ]) {
    it(`refuses a canonical tier behind ${name}, which the guard and the audit read differently`, async () => {
      const { t, done } = await run({ 'brain/wiki/fresh.md': edit(asCanonical(FIXTURE_BETA)) });
      assert.equal(done.status, 'failed');
      assert.match(done.error, /agent set tier: canonical on brain\/wiki\/fresh\.md/);
      await t.stop();
    });
  }

  it('refuses a change to a page that is canonical by its frontmatter on main', async () => {
    const { t, done } = await run({ 'brain/wiki/beta.md': asCanonical(FIXTURE_BETA).replace('2U rack', '4U rack') }, { files: { 'brain/wiki/beta.md': asCanonical(FIXTURE_BETA) } });
    assert.equal(done.status, 'failed');
    assert.match(done.error, /agent changed canonical page\(s\) brain\/wiki\/beta\.md — canonical pages are guardrails \(non-negotiable 4\)/);
    await t.stop();
  });

  it('refuses a change to a page that is canonical by the config list', async () => {
    const cfg = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../tools/lib/__fixtures__/clean/brain.config.yaml'), 'utf-8').replace('canonical_pages: []', 'canonical_pages: [beta]');
    const { t, done } = await run({ 'brain/wiki/beta.md': FIXTURE_BETA.replace('2U rack', '4U rack') }, { files: { 'brain.config.yaml': cfg } });
    assert.equal(done.status, 'failed');
    assert.match(done.error, /agent changed canonical page\(s\)/);
    await t.stop();
  });
});
