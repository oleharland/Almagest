import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { commands, createConnectors, LOOKUP_NS, MAX_QUERY_CHARS, MAX_SEARCH_TERMS, sanitiseTerms } from '../../src/connectors/index.mjs';
import { searchItems } from '../../src/connectors/execute.mjs';
import { recipeFor, validateRecipe } from '../../src/connectors/recipes.mjs';
import { git, makeApp, makeTempRepo, rmrf } from '../helpers.mjs';
import { manifestYaml, memoryConnect } from './helpers.mjs';

const repos = [];
const apps = [];
after(async () => {
  for (const a of apps) await a.stop().catch(() => {});
  repos.forEach(rmrf);
});

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const SEARCH = { tool: 'lookup_docs', args: { query: '{{query}}', scope: '{{select.scope}}' }, items: 'results[*]', ref: 'id', version: 'updatedAt', title: 'title' };
const DOCS = {
  recipe: 'custom',
  mcp: { command: 'fake' },
  // The listing deliberately leaves out d3: only lookup can reach it.
  list: { tool: 'list_docs', args: { since: '{{since}}', cursor: '{{cursor}}' }, items: 'docs[*]', ref: 'id', version: 'updatedAt', title: 'title', next_cursor: 'nextCursor', where: [{ path: 'id', in: ['d1', 'd2'] }] },
  search: SEARCH,
  fetch: { tool: 'get_doc', args: { id: '{{item.ref}}' }, render: 'json-to-markdown', render_options: { title: 'title', body: ['body'], omit: ['updatedAt'] } },
};

const state = () => ({
  pageSize: 10,
  docs: [
    { id: 'd1', title: 'Failover', updatedAt: '2026-01-01T00:00:00Z', body: 'Retry every 30 seconds.' },
    { id: 'd2', title: 'Pricing', updatedAt: '2026-01-01T00:00:00Z', body: 'Flat fee.' },
    { id: 'd3', title: 'Roadmap', updatedAt: '2026-01-01T00:00:00Z', body: 'Q3: search ships.' },
  ],
});

async function setup(connector = {}) {
  const repo = makeTempRepo();
  repos.push(repo);
  const app = await makeApp({ repoRoot: repo, overrides: { connectors: [{ id: 'docs', ...DOCS, ...connector }] } });
  apps.push(app);
  const holder = { current: state() };
  const calls = [];
  const svc = createConnectors(app.ctx, { connect: memoryConnect(holder, calls) });
  return { repo, app, svc, holder, calls, ctx: app.ctx };
}

async function mergeManifest(ctx, repo, refs) {
  fs.writeFileSync(path.join(repo, 'brain', 'manifest.yaml'), manifestYaml(refs));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'ingest');
  await ctx.snapshot.refresh();
}

/** A client that records the arguments of the one tool call and answers with `body`. */
function stubClient(body) {
  const seen = [];
  return { seen, callTool: async (req) => { seen.push(req); return { content: [{ type: 'text', text: JSON.stringify(body) }] }; } };
}

describe('recipes: the search block', () => {
  const base = () => ({ name: 'x', list: { tool: 'a', ref: 'id' }, fetch: { tool: 'b' } });

  it('a recipe without search stays valid; with search it is checked like list', () => {
    assert.doesNotThrow(() => validateRecipe(base()));
    assert.doesNotThrow(() => validateRecipe({ ...base(), search: { tool: 's', args: { q: '{{query}}' }, items: 'r[*]', ref: 'id' } }));
    assert.doesNotThrow(() => validateRecipe({ ...base(), search: { method: 'resources/list', ref: 'uri' } }));
    assert.throws(() => validateRecipe({ ...base(), search: { tool: 's' } }), /search\.ref is required/);
    assert.throws(() => validateRecipe({ ...base(), search: { ref: 'id' } }), /search needs one of tool \| method/);
    assert.throws(() => validateRecipe({ ...base(), search: { tool: 's', ref: 'id', method: 'resources/list' } }), /more than one/);
    assert.throws(() => validateRecipe({ ...base(), search: { static: ['a'], ref: 'id' } }), /search cannot be `static`/);
    assert.throws(() => validateRecipe({ ...base(), search: { tool: 's', ref: 'id', items: 'a[' } }), /search\.items/);
    assert.throws(() => validateRecipe({ ...base(), search: 'nope' }), /`search` must be a mapping/);
  });

  it('an inline search on a connector is merged in; google-drive and notion ship one, and say it is unverified', () => {
    assert.ok(recipeFor({ id: 't', recipe: 'google-drive' }).search);
    assert.ok(recipeFor({ id: 't', recipe: 'notion' }).search);
    assert.equal(recipeFor({ id: 't', recipe: 'linear' }).search, undefined);
    assert.equal(recipeFor({ id: 't', recipe: 'notion', search: { args: { query: 'x {{query}}' } } }).search.args.query, 'x {{query}}');
    for (const name of ['google-drive', 'notion']) {
      const text = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src', 'connectors', 'recipes', `${name}.yaml`), 'utf-8');
      assert.match(text, /^# search: .*NOT verified/m, name);
    }
  });
});

describe('searchItems', () => {
  const recipe = { name: 'r', search: { tool: 's', args: { q: '{{query}}', all: '{{terms}}' }, items: 'results[*]', ref: 'id', title: 'name', version: 'v', mime: 'm' } };

  it('templates {{query}} (terms joined by a space) and {{terms}} (the list)', async () => {
    const client = stubClient({ results: [{ id: 'a', name: 'A', v: '1', m: 'text/plain' }] });
    const { items } = await searchItems(client, recipe, { terms: ['alpha', 'beta'] }, {});
    assert.deepEqual(client.seen[0].arguments, { q: 'alpha beta', all: ['alpha', 'beta'] });
    assert.deepEqual(items.map(({ raw, ...i }) => i), [{ ref: 'a', version: '1', title: 'A', commit: '', mime: 'text/plain' }]);
  });

  it('first page only, capped by limit (default 10)', async () => {
    const results = Array.from({ length: 30 }, (_, i) => ({ id: `i${i}`, name: `n${i}` }));
    const client = stubClient({ results, next: 'more' });
    assert.equal((await searchItems(client, recipe, { terms: ['x'] }, {})).items.length, 10);
    assert.equal((await searchItems(client, recipe, { terms: ['x'] }, { limit: 3 })).items.length, 3);
    assert.equal(client.seen.length, 2, 'one call each, no paging');
  });

  it('throws when the recipe has no search block', async () => {
    await assert.rejects(() => searchItems(stubClient({}), { name: 'r' }, { terms: ['x'] }), /no search block/);
  });
});

describe('sanitiseTerms', () => {
  it('drops quotes, backslashes, control characters and operators; keeps Unicode letters, digits, - _ .', () => {
    assert.deepEqual(sanitiseTerms(['it\'s', 'say "hi"', 'a\\b', 'tab\tbed\u0000x', 'Größe', '日本語', 'v1.2-rc_3', '(a) or {b} & c;']), ['its', 'say hi', 'ab', 'tab bedx', 'Größe', '日本語', 'v1.2-rc_3', 'a or b c']);
  });

  it('collapses whitespace, drops empty terms, caps the count and the total length', () => {
    assert.deepEqual(sanitiseTerms(['  a   b  ', '"', '', '   ', '--', 7, null, {}]), ['a b', '7']);
    assert.equal(sanitiseTerms(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, MAX_SEARCH_TERMS);
    const long = sanitiseTerms(Array.from({ length: 6 }, () => 'x'.repeat(60)));
    assert.ok(long.join(' ').length <= MAX_QUERY_CHARS);
    assert.ok(long.every((t) => t.length <= 64));
    assert.deepEqual(sanitiseTerms('one'), ['one']);
    assert.deepEqual(sanitiseTerms(undefined), []);
  });

  it('an injection attempt cannot leave the quotes of the Drive template', async () => {
    const recipe = recipeFor({ id: 't', recipe: 'google-drive' });
    const client = stubClient({ files: [] });
    const terms = sanitiseTerms(["x' or trashed = false or name contains '", 'a\\\' or \'b']);
    await searchItems(client, recipe, { terms, select: {} }, {});
    const q = client.seen[0].arguments.query;
    assert.equal(q, "(owner = 'me') and fullText contains 'x or trashed false or name contains a or b'");
    assert.equal((q.match(/'/g) || []).length, 4, 'only the template quotes remain');
  });
});

describe('connectors.search', () => {
  it('refuses without lookup: true and without a search block', async () => {
    const off = await setup({ lookup: false });
    await assert.rejects(() => off.svc.search('docs', { terms: ['roadmap'] }), /not enabled for live lookup/);
    await assert.rejects(() => off.svc.fetchOne('docs', { ref: 'd3' }), /not enabled for live lookup/);
    assert.equal(off.calls.length, 0);

    const bare = await setup({ lookup: true });
    delete bare.ctx.config.sources.connectors[0].search;
    const svc = createConnectors(bare.ctx, { connect: memoryConnect(bare.holder, bare.calls) });
    await assert.rejects(() => svc.search('docs', { terms: ['roadmap'] }), /no `search` block/);
  });

  it('returns candidates, sends the sanitised query, uses lookup_select over select', async () => {
    const t = await setup({ lookup: true, select: { scope: 'narrow' }, lookup_select: { scope: 'wide' } });
    const found = await t.svc.search('docs', { terms: ['"roadmap"', "ship's"], limit: 5 });
    assert.deepEqual(found, [{ ref: 'd3', title: 'Roadmap', version: '2026-01-01T00:00:00Z', mime: '' }]);
    const call = t.calls.find((c) => c.tool === 'lookup_docs');
    assert.deepEqual(call.args, { query: 'roadmap ships', scope: 'wide' });
  });

  it('with select only, uses select; with no usable terms, never calls the server', async () => {
    const t = await setup({ lookup: true, select: { scope: 'narrow' } });
    await t.svc.search('docs', { terms: ['roadmap'] });
    assert.equal(t.calls.find((c) => c.tool === 'lookup_docs').args.scope, 'narrow');
    t.calls.length = 0;
    assert.deepEqual(await t.svc.search('docs', { terms: ['"', '\\', ''] }), []);
    assert.deepEqual(await t.svc.search('docs', {}), []);
    assert.equal(t.calls.length, 0);
  });

  it('list() reports lookup and searchable', async () => {
    const t = await setup({ lookup: true });
    assert.deepEqual((await t.svc.list()).map((r) => [r.lookup, r.searchable]), [[true, true]]);
    const u = await setup({});
    assert.deepEqual((await u.svc.list()).map((r) => [r.lookup, r.searchable]), [[false, true]]);
  });
});

describe('connectors.fetchOne', () => {
  it('stages the snapshot, fingerprints its bytes, tags the ref via: lookup, records it', async () => {
    const t = await setup({ lookup: true, label: 'ops' });
    const [hit] = await t.svc.search('docs', { terms: ['roadmap'] });
    const got = await t.svc.fetchOne('docs', hit);

    assert.equal(got.reused, false);
    assert.equal(got.ref.via, 'lookup');
    assert.equal(got.ref.kind, 'connector');
    assert.equal(got.ref.id, 'docs:d3');
    assert.equal(got.ref.change, 'new');
    assert.equal(got.ref.label, 'ops');
    assert.equal(got.sha256, got.ref.sha256);
    assert.equal(got.title, 'Roadmap');
    assert.equal(got.truncated, false);
    const staged = fs.readFileSync(t.svc.stagedPath(got.ref), 'utf-8');
    assert.equal(staged, got.text);
    assert.equal(sha(staged), got.sha256);
    assert.ok(got.text.includes('Q3: search ships.'));
    const mark = await t.ctx.store.kv.get(LOOKUP_NS, 'docs:d3');
    assert.equal(mark.title, 'Roadmap');
    assert.ok(mark.at);
  });

  it('a second call with the same version reuses the staged bytes and does not fetch again', async () => {
    const t = await setup({ lookup: true });
    const [hit] = await t.svc.search('docs', { terms: ['roadmap'] });
    const one = await t.svc.fetchOne('docs', hit);
    t.calls.length = 0;
    const two = await t.svc.fetchOne('docs', hit);
    assert.equal(two.reused, true);
    assert.equal(t.calls.filter((c) => c.tool === 'get_doc').length, 0);
    assert.equal(two.sha256, one.sha256);
    assert.equal(two.text, one.text);
  });

  it('compares with main: unchanged once the manifest records it, changed after an edit', async () => {
    const t = await setup({ lookup: true });
    const [hit] = await t.svc.search('docs', { terms: ['roadmap'] });
    const one = await t.svc.fetchOne('docs', hit);
    await mergeManifest(t.ctx, t.repo, [one.ref]);
    assert.equal((await t.svc.fetchOne('docs', hit)).ref.change, 'unchanged');
    t.holder.current.docs[2].body = 'Q4: search slips.';
    t.holder.current.docs[2].updatedAt = '2026-02-01T00:00:00Z';
    const [hit2] = await t.svc.search('docs', { terms: ['roadmap'] });
    const edited = await t.svc.fetchOne('docs', hit2);
    assert.equal(edited.ref.change, 'changed');
    assert.equal(edited.reused, false);
  });

  it('rejects an item with no ref', async () => {
    const t = await setup({ lookup: true });
    await assert.rejects(() => t.svc.fetchOne('docs', {}), /needs an item/);
  });
});

describe('sync and looked-up refs', () => {
  async function withLookedUp() {
    const t = await setup({ lookup: true });
    const first = await t.svc.sync('docs');
    assert.deepEqual(first.map((r) => r.ref), ['d1', 'd2'], 'd3 is outside the listing');
    const [hit] = await t.svc.search('docs', { terms: ['roadmap'] });
    const d3 = (await t.svc.fetchOne('docs', hit)).ref;
    await mergeManifest(t.ctx, t.repo, [...first, d3]);
    return t;
  }

  it('does not report a lookup-origin ref as missing, and counts it unchanged', async () => {
    const t = await withLookedUp();
    const s = await t.svc.syncDetailed('docs', { full: true });
    assert.deepEqual(s.missing, []);
    assert.deepEqual(s.refs, []);
    assert.ok(s.unchanged.includes('docs:d3'));
    assert.deepEqual(s.errors, []);
  });

  it('without the lookup mark the same entry is still reported missing', async () => {
    const t = await withLookedUp();
    await t.ctx.store.kv.delete(LOOKUP_NS, 'docs:d3');
    const s = await t.svc.syncDetailed('docs', { full: true });
    assert.deepEqual(s.missing.map((m) => m.ref), ['d3']);
  });

  it('picks up a change to a lookup-origin ref, and a failed fetch goes to errors', async () => {
    const t = await withLookedUp();
    t.holder.current.docs[2].body = 'Q4: search slips.';
    t.holder.current.docs[2].updatedAt = '2026-02-01T00:00:00Z';
    const s = await t.svc.syncDetailed('docs', { full: true });
    assert.deepEqual(s.refs.map((r) => [r.ref, r.change]), [['d3', 'changed']]);
    assert.deepEqual(s.missing, []);

    t.holder.current.fail = ['d3'];
    const bad = await t.svc.syncDetailed('docs', { full: true });
    assert.deepEqual(bad.errors.map((e) => e.ref), ['d3']);
    assert.deepEqual(bad.missing, []);
  });

  it('an incomplete (incremental) listing re-fetches nothing and reports nothing missing', async () => {
    const t = await withLookedUp();
    t.calls.length = 0;
    const s = await t.svc.syncDetailed('docs', { since: '2026-06-01T00:00:00Z' });
    assert.equal(s.complete, false);
    assert.deepEqual(s.missing, []);
    assert.equal(t.calls.filter((c) => c.tool === 'get_doc').length, 0);
  });
});

describe('almagest connectors search', () => {
  async function run(t, argv) {
    const out = [];
    const err = [];
    const wo = process.stdout.write.bind(process.stdout);
    const we = process.stderr.write.bind(process.stderr);
    process.stdout.write = (s) => { out.push(String(s)); return true; };
    process.stderr.write = (s) => { err.push(String(s)); return true; };
    try {
      const code = await commands.connectors.run(argv, { ctx: { ...t.ctx, connectors: t.svc }, repoRoot: t.repo });
      return { code, out: out.join(''), err: err.join('') };
    } finally {
      process.stdout.write = wo;
      process.stderr.write = we;
    }
  }

  it('prints candidates and fetches nothing', async () => {
    const t = await setup({ lookup: true });
    const r = await run(t, ['search', 'docs', 'roadmap', '--limit', '3']);
    assert.equal(r.code, 0);
    assert.match(r.out, /docs: 1 candidate\(s\) for "roadmap"/);
    assert.match(r.out, /d3 {2}\[2026-01-01T00:00:00Z\] Roadmap/);
    assert.equal(t.calls.filter((c) => c.tool === 'get_doc').length, 0);
    assert.equal(await t.ctx.store.kv.get(LOOKUP_NS, 'docs:d3'), null);
  });

  it('--json prints the list; a missing query or a bad limit exits 2; a disabled connector throws', async () => {
    const t = await setup({ lookup: true });
    const j = await run(t, ['search', 'docs', 'roadmap', '--json']);
    assert.deepEqual(JSON.parse(j.out).map((i) => i.ref), ['d3']);
    assert.equal((await run(t, ['search', 'docs'])).code, 2);
    assert.equal((await run(t, ['search', 'docs', 'x', '--limit', '0'])).code, 2);
    assert.match((await run(t, ['help'])).out, /search <id> <query/);
    const off = await setup({});
    await assert.rejects(() => run(off, ['search', 'docs', 'roadmap']), /not enabled for live lookup/);
  });
});
