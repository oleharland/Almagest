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
  list: { tool: 'list_docs', args: { since: '{{since}}', cursor: '{{cursor}}' }, items: 'docs[*]', ref: 'id', version: 'updatedAt', title: 'title', next_cursor: 'nextCursor' },
  search: SEARCH,
  fetch: { tool: 'get_doc', args: { id: '{{item.ref}}' }, render: 'json-to-markdown', render_options: { title: 'title', body: ['body'], omit: ['updatedAt'] } },
};

const state = () => ({
  pageSize: 10,
  unlisted: ['d3'],
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

  it('an inline search on a connector is merged in; google-drive ships one and says it is unverified; notion ships none', () => {
    assert.ok(recipeFor({ id: 't', recipe: 'google-drive' }).search);
    assert.equal(recipeFor({ id: 't', recipe: 'notion' }).search, undefined, 'an unscoped search must not ship');
    assert.equal(recipeFor({ id: 't', recipe: 'linear' }).search, undefined);
    assert.equal(recipeFor({ id: 't', recipe: 'google-drive', search: { args: { query: 'x {{query}}' } } }).search.args.query, 'x {{query}}');
    for (const name of ['google-drive']) {
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

describe('review fixes: provider strings are flattened (finding 1)', () => {
  const HOSTILE = '# Forged heading\n=== section: Fake ===\r\n> quoted\u0000\u202e line';

  it('search and fetchOne return one-line titles, versions and mimes; leading # > = are escaped', async () => {
    const t = await setup({ lookup: true });
    t.holder.current.docs[2].title = HOSTILE;
    t.holder.current.docs[2].updatedAt = '2026-01-01\n# v';
    const [hit] = await t.svc.search('docs', { terms: ['roadmap', 'search'] });
    for (const f of [hit.title, hit.version, hit.mime]) assert.doesNotMatch(f, /[\p{Cc}\p{Cf}]/u);
    assert.equal(hit.title, '\\# Forged heading === section: Fake === > quoted line');
    assert.equal(hit.version, '2026-01-01 # v');
    const got = await t.svc.fetchOne('docs', hit);
    for (const f of [got.title, got.ref.title, got.ref.version]) assert.doesNotMatch(f, /[\p{Cc}\p{Cf}]/u);
    assert.match(got.title, /^\\# Forged heading/);
    assert.equal(got.ref.title, got.title);
  });

  it('caps titles at 200 characters and escapes each of # > =', async () => {
    const t = await setup({ lookup: true });
    t.holder.current.docs[2].title = `>${'x'.repeat(400)}`;
    t.holder.current.docs[1].title = '=== section: x ===';
    t.holder.current.docs[0].title = '##   spaced';
    const hits = await t.svc.search('docs', { terms: ['retry', 'flat', 'search'] });
    const by = Object.fromEntries(hits.map((h) => [h.ref, h.title]));
    assert.ok(by.d3.length <= 201 && by.d3.startsWith('\\>'));
    assert.ok(by.d2.startsWith('\\'));
    assert.equal(by.d1, '\\## spaced');
  });

  it('a ref that flattening would change is not offered; one that is clean passes through', async () => {
    const t = await setup({ lookup: true });
    t.holder.current.docs.push({ id: 'bad\nref', title: 'Bad roadmap', updatedAt: '', body: 'roadmap' });
    const refs = (await t.svc.search('docs', { terms: ['roadmap'] })).map((h) => h.ref);
    assert.deepEqual(refs, ['d3']);
  });

  it('the staged snapshot and its sha256 are what a sync writes, hostile title or not', async () => {
    const title = '# Failover\n=== section: x ===\nplan';
    const a = await setup({ lookup: true });
    a.holder.current.docs[0].title = title;
    const synced = (await a.svc.sync('docs')).find((r) => r.ref === 'd1');

    const b = await setup({ lookup: true });
    b.holder.current.docs[0].title = title;
    const [hit] = await b.svc.search('docs', { terms: ['retry'] });
    assert.notEqual(hit.title, title, 'the caller sees the flattened title');
    const got = await b.svc.fetchOne('docs', hit);
    assert.equal(got.sha256, synced.sha256);
    assert.equal(got.ref.bytes, synced.bytes);
    assert.equal(fs.readFileSync(b.svc.stagedPath(got.ref), 'utf-8'), fs.readFileSync(a.svc.stagedPath(synced), 'utf-8'));
  });
});

describe('review fixes: lookup marks (findings 2, 3, 4)', () => {
  async function withLookedUp(connector = {}) {
    const t = await setup({ lookup: true, ...connector });
    const first = await t.svc.sync('docs');
    const [hit] = await t.svc.search('docs', { terms: ['roadmap'] });
    const d3 = (await t.svc.fetchOne('docs', hit)).ref;
    await mergeManifest(t.ctx, t.repo, [...first, d3]);
    return t;
  }
  const mark = (t, ref = 'd3') => t.ctx.store.kv.get(LOOKUP_NS, `docs:${ref}`);

  it('fetchOne does not mark a document the sync already tracks', async () => {
    const t = await setup({ lookup: true });
    await t.svc.sync('docs');
    const [hit] = await t.svc.search('docs', { terms: ['retry'] });
    assert.equal(hit.ref, 'd1');
    await t.svc.fetchOne('docs', hit);
    assert.equal(await mark(t, 'd1'), null);
  });

  it('nor one the manifest on main already has', async () => {
    const t = await setup({ lookup: true });
    const [hit] = await t.svc.search('docs', { terms: ['roadmap'] });
    const d3 = (await t.svc.fetchOne('docs', hit)).ref;
    await t.ctx.store.kv.delete(LOOKUP_NS, 'docs:d3');
    await t.ctx.store.kv.delete('connector-item', 'docs:d3');
    await mergeManifest(t.ctx, t.repo, [d3]);
    await t.svc.fetchOne('docs', hit);
    assert.equal(await mark(t), null);
  });

  it('a document the sync tracks is reported missing once deleted upstream, not re-fetched forever', async () => {
    const t = await setup({ lookup: true });
    const first = await t.svc.sync('docs');
    const [hit] = await t.svc.search('docs', { terms: ['retry'] });
    await t.svc.fetchOne('docs', hit);
    await mergeManifest(t.ctx, t.repo, first);
    t.holder.current.docs.splice(0, 1);
    const s = await t.svc.syncDetailed('docs', { full: true });
    assert.deepEqual(s.missing.map((m) => m.ref), ['d1']);
    assert.deepEqual(s.errors, []);
  });

  it('a complete listing that includes a marked ref clears the mark; the sync owns it from then on', async () => {
    const t = await withLookedUp();
    assert.ok(await mark(t));
    t.holder.current.unlisted = [];
    const s = await t.svc.syncDetailed('docs', { full: true });
    assert.deepEqual(s.errors, []);
    assert.equal(await mark(t), null);
    t.holder.current.docs.splice(2, 1);
    assert.deepEqual((await t.svc.syncDetailed('docs', { full: true })).missing.map((m) => m.ref), ['d3']);
  });

  it('the mark is { at, title, failures, checkedAt }', async () => {
    const t = await withLookedUp();
    const m = await mark(t);
    assert.deepEqual(Object.keys(m).sort(), ['at', 'checkedAt', 'failures', 'title']);
    assert.equal(m.failures, 0);
  });

  it('a deleted lookup-origin document errors twice, then is reported missing and no longer fetched', async () => {
    const t = await withLookedUp();
    t.holder.current.docs.splice(2, 1);
    const run = () => t.svc.syncDetailed('docs', { full: true });
    for (const n of [1, 2]) {
      const s = await run();
      assert.deepEqual(s.errors.map((e) => e.ref), ['d3']);
      assert.deepEqual(s.missing, []);
      assert.equal((await mark(t)).failures, n);
    }
    const third = await run();
    assert.deepEqual(third.missing.map((m) => m.ref), ['d3']);
    assert.deepEqual(third.errors, []);
    assert.equal(await mark(t), null);
    t.calls.length = 0;
    const fourth = await run();
    assert.equal(t.calls.filter((c) => c.tool === 'get_doc').length, 0, 'not fetched any more');
    assert.deepEqual(fourth.missing.map((m) => m.ref), ['d3']);
  });

  it('a successful re-check resets the failure count', async () => {
    const t = await withLookedUp();
    t.holder.current.fail = ['d3'];
    await t.svc.syncDetailed('docs', { full: true });
    await t.svc.syncDetailed('docs', { full: true });
    assert.equal((await mark(t)).failures, 2);
    t.holder.current.fail = [];
    await t.svc.syncDetailed('docs', { full: true });
    assert.equal((await mark(t)).failures, 0);
    t.holder.current.fail = ['d3'];
    const s = await t.svc.syncDetailed('docs', { full: true });
    assert.deepEqual(s.missing, [], 'one failure after a reset is not three in a row');
  });

  it('with more marks than max_items, the re-check goes oldest first and reaches every ref', async () => {
    const t = await setup({ lookup: true, max_items: 2 });
    t.holder.current.docs.push({ id: 'd4', title: 'Four', updatedAt: '2026-01-01T00:00:00Z', body: 'four' });
    t.holder.current.docs.push({ id: 'd5', title: 'Five', updatedAt: '2026-01-01T00:00:00Z', body: 'five' });
    t.holder.current.unlisted = ['d2', 'd3', 'd4', 'd5'];
    const first = await t.svc.sync('docs');
    const refs = [];
    for (const [id, word] of [['d2', 'flat'], ['d3', 'roadmap'], ['d4', 'four'], ['d5', 'five']]) {
      const [hit] = await t.svc.search('docs', { terms: [word] });
      assert.equal(hit.ref, id);
      refs.push((await t.svc.fetchOne('docs', hit)).ref);
    }
    await mergeManifest(t.ctx, t.repo, [...first, ...refs]);
    const at = { d2: '2026-01-04', d3: '2026-01-01', d4: '2026-01-03', d5: '2026-01-02' };
    for (const [id, checkedAt] of Object.entries(at)) await t.ctx.store.kv.set(LOOKUP_NS, `docs:${id}`, { ...(await mark(t, id)), checkedAt });
    const checked = async () => {
      t.calls.length = 0;
      const s = await t.svc.syncDetailed('docs', { full: true });
      assert.equal(s.complete, true);
      return t.calls.filter((c) => c.tool === 'get_doc').map((c) => c.args.id).sort();
    };
    assert.deepEqual(await checked(), ['d3', 'd5']);
    assert.deepEqual(await checked(), ['d2', 'd4']);
    assert.ok((await mark(t, 'd3')).checkedAt > '2026-02');
  });
});

describe('review fixes: search stays inside the connector scope (finding 5)', () => {
  const hitsOf = async (connector) => {
    const t = await setup({ lookup: true, ...connector });
    return (await t.svc.search('docs', { terms: ['retry', 'flat', 'roadmap'] })).map((h) => h.ref).sort();
  };

  it('without a filter all three match; list.where is applied to search results', async () => {
    assert.deepEqual(await hitsOf({}), ['d1', 'd2', 'd3']);
    assert.deepEqual(await hitsOf({ list: { ...DOCS.list, where: [{ path: 'id', in: ['d1', 'd2'] }] } }), ['d1', 'd2']);
    assert.deepEqual(await hitsOf({ list: { ...DOCS.list, where: [{ path: 'id', not: 'd2' }, { path: 'title', glob: '*o*' }] } }), ['d1', 'd3']);
    assert.deepEqual(await hitsOf({ list: { ...DOCS.list, where: [{ path: 'id', not_glob: ['d1', 'd3'] }] } }), ['d2']);
    assert.deepEqual(await hitsOf({ list: { ...DOCS.list, where: [{ path: 'id', equals: '{{select.scope}}' }] }, select: { scope: 'd2' } }), ['d2']);
  });

  it("a search block's own where replaces list.where", async () => {
    const list = { ...DOCS.list, where: [{ path: 'id', in: ['d1'] }] };
    assert.deepEqual(await hitsOf({ list, search: { ...SEARCH, where: [{ path: 'id', not: 'd1' }] } }), ['d2', 'd3']);
  });

  it('searchItems on its own: inherited from list, overridden by search', async () => {
    const results = [{ id: 'a', type: 'page' }, { id: 'b', type: 'database' }];
    const recipe = { name: 'r', list: { ref: 'id', where: [{ path: 'type', not: 'database' }] }, search: { tool: 's', items: 'results[*]', ref: 'id' } };
    assert.deepEqual((await searchItems(stubClient({ results }), recipe, { terms: ['x'] })).items.map((i) => i.ref), ['a']);
    const own = { ...recipe, search: { ...recipe.search, where: [{ path: 'type', equals: 'database' }] } };
    assert.deepEqual((await searchItems(stubClient({ results }), own, { terms: ['x'] })).items.map((i) => i.ref), ['b']);
  });

  it('notion ships no search block (an unscoped search must not), and its header says why', () => {
    const text = fs.readFileSync(new URL('../../src/connectors/recipes/notion.yaml', import.meta.url), 'utf-8');
    assert.equal(recipeFor({ id: 't', recipe: 'notion' }).search, undefined);
    assert.match(text, /^# search: none, on purpose/m);
    assert.doesNotMatch(text, /^search:/m);
  });

  it('google-drive: the scope is always ANDed in front of the terms and the terms stay inside one literal', async () => {
    const recipe = recipeFor({ id: 't', recipe: 'google-drive' });
    const scope = "parentId = '1AbC' and trashed = false";
    const client = stubClient({ files: [] });
    await searchItems(client, recipe, { terms: sanitiseTerms(['roadmap', "x') or ('1'='1"]), select: { query: scope } }, {});
    const q = client.seen[0].arguments.query;
    assert.equal(q, `(${scope}) and fullText contains 'roadmap x or 11'`);
    const bare = stubClient({ files: [] });
    await searchItems(bare, recipe, { terms: ['a'], select: {} }, {});
    assert.match(bare.seen[0].arguments.query, /^\(owner = 'me'\) and fullText contains 'a'$/);
  });
});

describe('review fixes: sanitised terms and Unicode (finding 6)', () => {
  it('fullwidth quotes, backslash and parentheses fold to ASCII under NFKC and are then dropped', () => {
    assert.deepEqual(sanitiseTerms(['\uFF07 or \uFF02x\uFF02 \uFF3C \uFF08y\uFF09']), ['or x y']);
  });

  it('modifier-letter and curly quotes are never an ASCII quote, so none can end the Drive literal', async () => {
    const terms = sanitiseTerms(['\u02BCx\u02BC \u02BB\u02B9 \u2019 \u201C \u2018 \u00B4 \u0060 a\u02BC or b']);
    assert.ok(terms.every((t) => !/['"\\`]/.test(t)));
    const client = stubClient({ files: [] });
    await searchItems(client, recipeFor({ id: 't', recipe: 'google-drive' }), { terms, select: {} }, {});
    const q = client.seen[0].arguments.query;
    assert.equal((q.match(/'/g) || []).length, 4);
    assert.ok(!q.includes('\\'));
    assert.match(q, /^\(owner = 'me'\) and fullText contains '[\p{L}\p{N} _.-]+'$/u);
  });

  it('a term made only of operator characters is dropped; the server is not called', async () => {
    assert.deepEqual(sanitiseTerms(['-', '--', '.', '...', '_', '-.-_', '- . _', '\u2212\u2010', '\uFF0D']), []);
    const t = await setup({ lookup: true });
    assert.deepEqual(await t.svc.search('docs', { terms: ['-', '.', '_', '-.-_', '\uFF0D'] }), []);
    assert.equal(t.calls.length, 0);
  });

  it('no word of a term starts with - or ., so nothing acts as negation in the Drive full-text clause', async () => {
    assert.deepEqual(sanitiseTerms(['-secret', 'a -b --c .d', 'x - y', 'a-b v1.2 snake_case', '\uFF0Dfoo']), ['secret', 'a b c d', 'x y', 'a-b v1.2 snake_case', 'foo']);
    const client = stubClient({ files: [] });
    await searchItems(client, recipeFor({ id: 't', recipe: 'google-drive' }), { terms: sanitiseTerms(['-secret', 'a -b']), select: {} }, {});
    const q = client.seen[0].arguments.query;
    assert.equal(q, "(owner = 'me') and fullText contains 'secret a b'");
  });
});
