import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { createConnectors } from '../../src/connectors/index.mjs';
import { snapshotSlug } from '../../src/connectors/snapshot-file.mjs';
import { FIXTURES, git, makeApp, makeTempRepo, rmrf } from '../helpers.mjs';
import { manifestYaml, memoryConnect, stdioServer } from './helpers.mjs';

const repos = [];
const apps = [];
after(async () => {
  for (const a of apps) await a.stop().catch(() => {});
  repos.forEach(rmrf);
});

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const DOCS_RECIPE = {
  recipe: 'custom',
  list: {
    tool: 'list_docs',
    args: { since: '{{since}}', cursor: '{{cursor}}' },
    items: 'docs[*]', ref: 'id', version: 'updatedAt', title: 'title', next_cursor: 'nextCursor',
  },
  fetch: { tool: 'get_doc', args: { id: '{{item.ref}}' }, render: 'json-to-markdown', render_options: { title: 'title', body: ['body'], omit: ['updatedAt'] } },
};

function docsState() {
  return {
    pageSize: 2,
    docs: [
      { id: 'd1', title: 'Failover', updatedAt: '2026-01-01T00:00:00Z', body: '## Policy\nRetry every 30 seconds.' },
      { id: 'd2', title: 'Pricing', updatedAt: '2026-01-01T00:00:00Z', body: 'Flat fee.' },
      { id: 'd3', title: 'Roadmap', updatedAt: '2026-01-01T00:00:00Z', body: 'Q3: search.' },
    ],
  };
}

async function setup({ connectors, state = docsState(), files = {} } = {}) {
  const repo = makeTempRepo({ files });
  repos.push(repo);
  const app = await makeApp({ repoRoot: repo, overrides: { connectors } });
  apps.push(app);
  const holder = { current: state };
  const calls = [];
  const svc = createConnectors(app.ctx, { connect: memoryConnect(holder, calls) });
  return { repo, app, svc, holder, calls, ctx: app.ctx };
}

/** What a merged ingest leaves on main: the manifest records these refs. */
async function mergeManifest(ctx, repo, refs, extra) {
  fs.writeFileSync(path.join(repo, 'brain', 'manifest.yaml'), manifestYaml(refs, extra));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'ingest');
  await ctx.snapshot.refresh();
}

describe('connectors.sync — fingerprint against main', () => {
  it('first sync: every item is new, paginated, staged, fingerprinted by its bytes', async () => {
    const { svc, ctx, calls } = await setup({ connectors: [{ id: 'docs', mcp: { command: 'fake' }, label: 'ops', ...DOCS_RECIPE }] });
    const synced = ctx.bus.waitFor('connector.synced');
    const refs = await svc.sync('docs');

    assert.equal(refs.length, 3);
    assert.equal(calls.filter((c) => c.tool === 'list_docs').length, 2, 'two pages');
    const r = refs.find((x) => x.ref === 'd1');
    assert.equal(r.kind, 'connector');
    assert.equal(r.id, 'docs:d1');
    assert.equal(r.change, 'new');
    assert.equal(r.label, 'ops');
    assert.equal(r.version, '2026-01-01T00:00:00Z');
    assert.equal(r.path, `brain/raw/extracted/docs/${snapshotSlug('d1')}.txt`);
    assert.equal(svc.snapshotPath(r), r.path);

    const staged = fs.readFileSync(svc.stagedPath(r), 'utf-8');
    assert.equal(sha(staged), r.sha256, 'the sha is of the staged bytes');
    assert.ok(staged.startsWith('--- almagest snapshot v1 ---\nconnector: docs\n'));
    assert.ok(staged.includes('=== section: body ===\n=== section: Policy ===\n## Policy\nRetry every 30 seconds.'));

    const evt = await synced;
    assert.equal(evt.connectorId, 'docs');
    assert.equal(evt.items.length, 3);
    const [listed] = await svc.list();
    assert.equal(listed.lastSync.changed, 3);
    assert.ok(listed.since);
  });

  it('unchanged on main → nothing returned, and a matching version skips the fetch', async () => {
    const { svc, ctx, repo, calls } = await setup({ connectors: [{ id: 'docs', mcp: { command: 'fake' }, ...DOCS_RECIPE }] });
    const first = await svc.sync('docs');
    await mergeManifest(ctx, repo, first);
    calls.length = 0;

    const s = await svc.syncDetailed('docs', { full: true });
    assert.equal(s.refs.length, 0);
    assert.deepEqual(s.unchanged, ['docs:d1', 'docs:d2', 'docs:d3']);
    assert.equal(s.reused, 3);
    assert.equal(calls.filter((c) => c.tool === 'get_doc').length, 0, 'version matched — no fetch');
  });

  it('changed bytes → changed; a bumped version with identical content → still unchanged', async () => {
    const { svc, ctx, repo, holder } = await setup({ connectors: [{ id: 'docs', mcp: { command: 'fake' }, ...DOCS_RECIPE }] });
    await mergeManifest(ctx, repo, await svc.sync('docs'));

    holder.current.docs[0].body = '## Policy\nRetry every 60 seconds.';
    holder.current.docs[0].updatedAt = '2026-02-01T00:00:00Z';
    holder.current.docs[1].updatedAt = '2026-02-01T00:00:00Z';   // touched, not edited
    const s = await svc.syncDetailed('docs', { full: true });
    assert.deepEqual(s.refs.map((r) => [r.ref, r.change]), [['d1', 'changed']]);
    assert.equal(s.fetched, 2, 'both re-fetched because their versions moved');
    assert.ok(s.unchanged.includes('docs:d2'), 'the version is an optimisation, never the verdict');
  });

  it('the cursor persists: the next sync passes {{since}} and is incremental', async () => {
    const { svc, calls } = await setup({ connectors: [{ id: 'docs', mcp: { command: 'fake' }, ...DOCS_RECIPE }] });
    const first = await svc.syncDetailed('docs');
    assert.equal(first.since, '');
    assert.ok(first.complete);
    calls.length = 0;
    const second = await svc.syncDetailed('docs');
    assert.equal(second.since, first.at);
    assert.equal(calls.find((c) => c.tool === 'list_docs').args.since, first.at);
    assert.equal(second.complete, false, 'an incremental listing cannot prove anything disappeared');
    assert.equal(second.listed, 0);
  });

  it('items gone upstream are reported missing on a full listing — nothing deleted', async () => {
    const { svc, ctx, repo, holder } = await setup({ connectors: [{ id: 'docs', mcp: { command: 'fake' }, ...DOCS_RECIPE }] });
    const first = await svc.sync('docs');
    await mergeManifest(ctx, repo, first);
    holder.current.docs = holder.current.docs.filter((d) => d.id !== 'd2');
    const s = await svc.syncDetailed('docs', { full: true });
    assert.deepEqual(s.missing.map((m) => m.id), ['docs:d2']);
    assert.ok(fs.existsSync(path.join(repo, first.find((r) => r.ref === 'd2').path)) === false, 'sync never touches the checkout');

    // A missing item that comes back with the same bytes is reported as reappeared.
    await mergeManifest(ctx, repo, first, { 'docs:d2': { status: 'missing' } });
    holder.current.docs = docsState().docs;
    const back = await svc.syncDetailed('docs', { full: true });
    assert.deepEqual(back.refs.map((r) => [r.ref, r.change]), [['d2', 'reappeared']]);
  });

  it('a failing item is reported, the rest still sync, and the cursor does not advance', async () => {
    const { svc, holder } = await setup({ connectors: [{ id: 'docs', mcp: { command: 'fake' }, ...DOCS_RECIPE }] });
    holder.current.fail = ['d3'];
    const s = await svc.syncDetailed('docs');
    assert.equal(s.refs.length, 2);
    assert.deepEqual(s.errors.map((e) => e.ref), ['d3']);
    assert.match(s.errors[0].error, /upstream failure/);
    assert.equal((await svc.list())[0].since, '');
  });

  it('dry run fetches and fingerprints but writes, stores and emits nothing', async () => {
    const { svc, ctx } = await setup({ connectors: [{ id: 'docs', mcp: { command: 'fake' }, ...DOCS_RECIPE }] });
    let emitted = false;
    ctx.bus.on('connector.synced', () => { emitted = true; });
    const s = await svc.syncDetailed('docs', { dryRun: true });
    assert.equal(s.refs.length, 3);
    assert.ok(!fs.existsSync(svc.stagedPath(s.refs[0])));
    assert.equal((await svc.list())[0].lastSync, null);
    await ctx.bus.drain();
    assert.equal(emitted, false);
  });

  it('materialize copies the staged snapshot into a worktree and refuses bytes nobody fingerprinted', async () => {
    const { svc, repo } = await setup({ connectors: [{ id: 'docs', mcp: { command: 'fake' }, ...DOCS_RECIPE }] });
    const [r] = await svc.sync('docs');
    const wt = fs.mkdtempSync(path.join(repo, '.almagest', 'wt-'));
    const rel = await svc.materialize(r, wt);
    assert.equal(rel, r.path);
    assert.equal(sha(fs.readFileSync(path.join(wt, rel))), r.sha256);
    fs.appendFileSync(svc.stagedPath(r), 'tampered\n');
    await assert.rejects(() => svc.materialize(r, wt), /re-sync/);
  });

  it('caps an item at max_bytes with a truncation marker', async () => {
    const state = docsState();
    state.docs[0].body = 'x'.repeat(5000);
    const { svc } = await setup({ state, connectors: [{ id: 'docs', mcp: { command: 'fake' }, max_bytes: 1000, ...DOCS_RECIPE }] });
    const refs = await svc.sync('docs');
    const r = refs.find((x) => x.ref === 'd1');
    assert.ok(r.truncated);
    assert.match(fs.readFileSync(svc.stagedPath(r), 'utf-8'), /=== truncated: kept \d+ of \d+ bytes ===\n$/);
  });
});

describe('connectors.sync — recipes', () => {
  it('mcp-resources works with zero mapping: pagination, filters, json, blobs', async () => {
    const state = {
      pageSize: 2,
      resources: [
        { uri: 'file:///docs/a.md', name: 'A', mimeType: 'text/markdown', text: '# A\n## Part\nalpha' },
        { uri: 'file:///docs/b.json', name: 'B', mimeType: 'application/json', text: '{"owner":"ops","note":"beta"}' },
        { uri: 'file:///img/c.png', name: 'C', mimeType: 'image/png', blob: 'iVBORw0KGgo=' },
        { uri: 'file:///docs/d.md', name: 'D', mimeType: 'text/markdown', text: 'delta' },
      ],
    };
    const { svc } = await setup({ state, connectors: [{ id: 'files', mcp: { command: 'fake' }, recipe: 'mcp-resources' }] });
    const all = await svc.sync('files');
    assert.equal(all.length, 4);
    const text = (ref) => fs.readFileSync(svc.stagedPath(all.find((r) => r.ref === ref)), 'utf-8');
    assert.ok(text('file:///docs/a.md').includes('=== section: Part ==='));
    assert.ok(text('file:///docs/b.json').includes('- owner: ops'));
    assert.ok(text('file:///img/c.png').includes('[binary content not captured: image/png'));

    const { svc: filtered } = await setup({ state, connectors: [{ id: 'files', mcp: { command: 'fake' }, recipe: 'mcp-resources', select: { include: ['file:///docs/**'], exclude: ['**/*.json'] } }] });
    assert.deepEqual((await filtered.sync('files')).map((r) => r.ref), ['file:///docs/a.md', 'file:///docs/d.md']);
  });

  it('transcript and rows recipes produce t / row markers', async () => {
    const state = docsState();
    state.docs[0].segments = [{ start: 0, speaker: 'Ada', text: 'Hello' }, { start: 754, speaker: 'Bo', text: 'Ship it' }];
    state.docs[0].rows = [{ ts: '1', text: 'a' }, { ts: '2', text: 'b' }];
    const base = { mcp: { command: 'fake' }, recipe: 'custom', list: { ...DOCS_RECIPE.list, where: [{ field: 'ref', equals: 'd1' }] } };
    const { svc } = await setup({
      state,
      connectors: [
        { id: 'calls', ...base, fetch: { tool: 'get_transcript', args: { id: '{{item.ref}}' }, render: 'transcript', render_options: { segments: 'segments[*]' } } },
        { id: 'sheet', ...base, fetch: { tool: 'get_rows', args: { id: '{{item.ref}}' }, render: 'rows', render_options: { rows: 'rows[*]' } } },
      ],
    });
    const [t] = await svc.sync('calls');
    assert.ok(fs.readFileSync(svc.stagedPath(t), 'utf-8').includes('=== t 00:12:34 ===\nBo: Ship it'));
    const [r] = await svc.sync('sheet');
    assert.ok(fs.readFileSync(svc.stagedPath(r), 'utf-8').includes('=== row 2 ===\nts: 2\ntext: b'));
  });

  it('v1 sources.remote runs through the github recipe: paths glob, blob version, commit, supersedes', async () => {
    const cfg = fs.readFileSync(path.join(FIXTURES, 'clean', 'brain.config.yaml'), 'utf-8')
      .replace(/^sources:\n/m, 'sources:\n  remote:\n    - provider: github\n      repo: acme/platform-docs\n      paths: ["docs/**/*.md"]\n      branch: main\n      label: platform\n');
    const manifest = [
      'version: 1', '', 'sources:',
      '  - id: "github:acme/platform-docs:docs/arch.md"', '    kind: remote', '    provider: github', '    repo: acme/platform-docs',
      '    branch: main', '    path: docs/arch.md', '    commit: 1111111111111111111111111111111111111111', '    bytes: 10',
      '    first_ingested: 2026-01-01', '    last_ingested: 2026-01-01', '    pages: []', '    status: ingested', '',
    ].join('\n');
    const state = {
      repo: {
        commit: 'c0ffee0000000000000000000000000000000000',
        files: [
          { path: 'docs/arch.md', sha: 'blob1', content: '# Architecture\n## Failover\nManual.' },
          { path: 'docs/deep/adr.md', sha: 'blob2', content: 'ADR' },
          { path: 'src/index.js', sha: 'blob3', content: 'code' },
        ],
      },
    };
    const { svc, calls } = await setup({
      state,
      files: {
        'brain.config.yaml': cfg,
        'brain/manifest.yaml': manifest,
        '.mcp.json': JSON.stringify({ mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN:-}' } } } }),
      },
    });
    const [c] = await svc.list();
    assert.equal(c.id, 'github-acme-platform-docs');
    assert.equal(c.fromV1Remote, true);

    const refs = await svc.sync(c.id);
    assert.deepEqual(refs.map((r) => r.ref), ['docs/arch.md', 'docs/deep/adr.md']);
    const arch = refs[0];
    assert.equal(arch.version, 'blob1');
    assert.equal(arch.commit, state.repo.commit);
    assert.equal(arch.change, 'changed');
    assert.equal(arch.supersedes, 'github:acme/platform-docs:docs/arch.md');
    assert.equal(arch.label, 'platform');
    assert.deepEqual(calls.find((x) => x.tool === 'list_commits').args, { owner: 'acme', repo: 'platform-docs', sha: 'main', perPage: 1 });
    assert.equal(calls.find((x) => x.tool === 'get_file_contents').args.ref, state.repo.commit);
    const text = fs.readFileSync(svc.stagedPath(arch), 'utf-8');
    assert.ok(text.includes('=== section: Failover ==='));
    assert.ok(!text.includes('successfully downloaded'));
  });
});

describe('connectors through the composition root', () => {
  it('real stdio transport: makeApp({ real: [connectors] }) syncs from a child-process server and stops cleanly', async () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const fake = stdioServer(fs.mkdtempSync(path.join(repo, '.almagest-fake-')), docsState());
    const app = await makeApp({ repoRoot: repo, real: ['connectors'], overrides: { connectors: [{ id: 'docs', mcp: fake.mcp, ...DOCS_RECIPE }] } });
    const refs = await app.ctx.connectors.sync('docs');
    assert.equal(refs.length, 3);
    assert.ok(fake.calls().some((c) => c.tool === 'get_doc'));
    const t = await app.ctx.connectors.test('docs', { fetch: true });
    assert.equal(t.transport, 'stdio');
    assert.equal(t.items.length, 2, 'first page only');
    assert.ok(t.snapshot.text.includes('connector: docs'));
    await app.stop();
  });

  it('rejects duplicate or path-unsafe connector ids at boot', async () => {
    const repo = makeTempRepo();
    repos.push(repo);
    await assert.rejects(() => makeApp({ repoRoot: repo, real: ['connectors'], overrides: { connectors: [{ id: 'a', mcp: 'x' }, { id: 'a', mcp: 'y' }] } }), /defined twice/);
    await assert.rejects(() => makeApp({ repoRoot: repo, real: ['connectors'], overrides: { connectors: [{ id: '../evil', mcp: 'x' }] } }), /kebab-case/);
  });
});
