import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import matter from 'gray-matter';

import { loadWiki, safeFrontmatter } from '../../../tools/lib/wiki-core.mjs';
import { buildChanges } from '../../src/governance/builder.mjs';
import { mergePages, parsePage } from '../../src/governance/page-merge.mjs';
import { ada, cleanup, G, govApp, repo, git } from '../governance/fixtures.mjs';

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

after(cleanup);

describe('nothing parses front matter except through safeFrontmatter', () => {
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const SKIP = new Set([path.join(ROOT, 'tools/lib/wiki-core.mjs')]);

  function* sources(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.') || entry.name === 'dist') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) yield* sources(full);
      else if (/\.(mjs|js|ts|astro)$/.test(entry.name)) yield full;
    }
  }
  const strip = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  /** Every way the gray-matter default export can be called: by the name it is imported under, or `require`d / imported dynamically. */
  function directCalls(text) {
    const code = strip(text);
    const names = new Set();
    for (const m of code.matchAll(/import\s+([\w$]+)\s*(?:,\s*\{[^}]*\})?\s+from\s+['"]gray-matter['"]/g)) names.add(m[1]);
    for (const m of code.matchAll(/import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]gray-matter['"]/g)) names.add(m[1]);
    for (const m of code.matchAll(/import\s*\{[^}]*\bdefault\s+as\s+([\w$]+)[^}]*\}\s*from\s*['"]gray-matter['"]/g)) names.add(m[1]);
    for (const m of code.matchAll(/(?:const|let|var)\s+([\w$]+)\s*=\s*(?:require\(\s*['"]gray-matter['"]\s*\)|await\s+import\(\s*['"]gray-matter['"]\s*\))/g)) names.add(m[1]);
    const found = [];
    for (const name of names) {
      const call = new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}\\s*(?:\\(|\\.\\s*[A-Za-z_]+\\s*\\()`, 'g');
      for (const m of code.matchAll(call)) found.push(`${name}${m[0].slice(name.length).trim()}`);
    }
    if (/\bimport\(\s*['"]gray-matter['"]\s*\)\s*\)?\s*\.\s*default\s*\(/.test(code)) found.push('import(gray-matter).default(');
    return found;
  }

  it('finds the calls it is meant to find (the scanner itself)', () => {
    assert.deepEqual(directCalls("import matter from 'gray-matter';\nconst f = matter(text, {});"), ['matter(']);
    assert.deepEqual(directCalls("import gm from 'gray-matter';\nconst d = gm.stringify(a, b);"), ['gm.stringify(']);
    assert.deepEqual(directCalls("import matter from 'gray-matter';\nconst parse = safeFrontmatter(matter);\nloadWiki({ matter, repoRoot });\n// matter(text)\n/* matter(x) */"), []);
    assert.deepEqual(directCalls("import matter from 'gray-matter';\nreuse.matter.replace(x); const o = { matter: 1 };"), []);
  });

  it('no file under server/src, tools or site/src calls gray-matter directly', () => {
    const offenders = [];
    for (const dir of ['server/src', 'tools', 'site/src']) {
      for (const file of sources(path.join(ROOT, dir))) {
        if (SKIP.has(file)) continue;
        const calls = directCalls(fs.readFileSync(file, 'utf-8'));
        if (calls.length) offenders.push(`${path.relative(ROOT, file)}: ${calls.join(', ')}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

describe('a page with a js front matter block, at every place on this branch that reads a page', () => {
  it('page-merge reads it as unreadable and runs nothing', async () => {
    delete globalThis[FLAG];
    assert.equal(parsePage(evil('---js')), null);
    const ok = '---\ntitle: A\ntype: topic\ntier: evidence\norigin: source\n---\n\n## One\n\nx\n';
    for (const [ours, theirs] of [[evil('---js'), ok], [ok, evil('---js')]]) {
      const r = await mergePages({ ours, theirs });
      assert.equal(r.ok, false);
    }
    assert.equal(globalThis[FLAG], undefined);
  });

  it('the service reads the title of a page it proposes a tier for without running it', async () => {
    delete globalThis[FLAG];
    const text = evil('---js');
    const r = repo({ files: { 'brain/wiki/beta.md': text } });
    git(r, 'checkout', '-q', '--detach');
    const app = await govApp(r);
    await assert.rejects(() => G(app).proposeTier('beta', 'canonical', ada, { confirm: true }), /./);
    assert.equal(globalThis[FLAG], undefined);
    await app.stop();
  });
});
