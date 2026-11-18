import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import matter from 'gray-matter';

import { loadWiki, safeFrontmatter } from '../../../tools/lib/wiki-core.mjs';
import { buildChanges } from '../../src/governance/builder.mjs';

const FLAG = '__almagest_frontmatter_ran__';
const evil = (opening) => `${opening}\n{ title: (globalThis.${FLAG} = true, "x") }\n---\nbody\n`;
const parse = safeFrontmatter(matter);

describe('front matter is YAML and nothing else', () => {
  it('gray-matter alone would run the block (the reason this wrapper exists)', () => {
    delete globalThis[FLAG];
    matter(evil('---js'));
    assert.equal(globalThis[FLAG], true);
    delete globalThis[FLAG];
  });

  for (const opening of ['---js', '---javascript', '--- js', '---js ', '---JS', '﻿---js', '---coffee', '---json', '---toml', '---cson', '---anything']) {
    it(`refuses ${JSON.stringify(opening)} without running it`, () => {
      delete globalThis[FLAG];
      assert.throws(() => parse(evil(opening)), /front matter must be YAML/);
      assert.equal(globalThis[FLAG], undefined);
    });
  }

  it('refuses a js block with Windows line endings', () => {
    delete globalThis[FLAG];
    assert.throws(() => parse(evil('---js').replace(/\n/g, '\r\n')), /front matter must be YAML/);
    assert.equal(globalThis[FLAG], undefined);
  });

  it('parses plain and explicitly named YAML as before', () => {
    assert.deepEqual(parse('---\ntitle: A\ntags: [x, y]\n---\nbody\n').data, { title: 'A', tags: ['x', 'y'] });
    assert.deepEqual(parse('---yaml\ntitle: A\n---\nbody\n').data, { title: 'A' });
    assert.equal(parse('no front matter at all\n').content, 'no front matter at all\n');
    assert.deepEqual(parse('').data, {});
  });

  it('loadWiki refuses a page with a js block and runs nothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-fm-'));
    try {
      fs.mkdirSync(path.join(dir, 'brain', 'wiki'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'brain', 'wiki', 'evil.md'), evil('---js'));
      delete globalThis[FLAG];
      assert.throws(() => loadWiki({ repoRoot: dir, matter, onWarn: () => {} }), /front matter must be YAML/);
      assert.equal(globalThis[FLAG], undefined);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the proposal builder reads an agent-written page', () => {
  it('does not run a js block when it builds the changes of a proposal', async () => {
    delete globalThis[FLAG];
    const git = {
      diffNames: async () => [{ status: 'A', path: 'brain/wiki/evil.md' }],
      show: async () => evil('---js'),
    };
    const out = await buildChanges({ git, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40) });
    assert.equal(globalThis[FLAG], undefined);
    assert.ok(out);
  });
});
