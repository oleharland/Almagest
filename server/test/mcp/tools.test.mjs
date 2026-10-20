import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { humanActor } from '../../src/core/auth.mjs';
import { git, makeApp, rmrf } from '../helpers.mjs';
import { call, connect, makeRepo, mcpApp, page, PROPOSAL, RANKING_PAGES } from './_util.mjs';

const repos = [];
const apps = [];
after(async () => {
  for (const a of apps) { await a.ctx.mcp.close(); await a.stop(); }
  repos.forEach(rmrf);
});

async function setup(files = {}, overrides = {}) {
  const repoRoot = makeRepo(files);
  repos.push(repoRoot);
  const t = await mcpApp({ repoRoot, overrides });
  apps.push(t.app);
  return { repoRoot, ...t };
}

const owner = humanActor({ id: 'usr_ada', display: 'Ada', roles: ['owner'] });
const viewer = humanActor({ id: 'usr_vic', display: 'Vic', roles: ['viewer'] });
const contributor = humanActor({ id: 'usr_cy', display: 'Cy', roles: ['contributor'] });

describe('mcp tools — read', () => {
  it('search ranks alias > title > body and records a telemetry event', async () => {
    const { ctx, events } = await setup(RANKING_PAGES);
    const { client, close } = await connect(ctx, owner, 'claude-code');
    const r = await call(client, 'search', { query: 'kestrel' });
    assert.ok(!r.isError, r.text);
    assert.deepEqual(r.structuredContent.results.slice(0, 3).map((x) => x.slug), ['kestrel-scheduler', 'kestrel-deployment', 'ops-notes']);
    const first = r.structuredContent.results[0];
    for (const k of ['slug', 'title', 'type', 'tier', 'confidence', 'score', 'snippet']) assert.ok(k in first, `result has ${k}`);
    assert.match(r.text, /\[\[kestrel-scheduler\]\] Job Runner/);

    const evt = events.at(-1);
    assert.equal(evt.channel, 'mcp');
    assert.equal(evt.tool, 'search');
    assert.equal(evt.query, 'kestrel');
    assert.equal(evt.answered, true);
    assert.equal(evt.client, 'claude-code');
    assert.equal(evt.actorId, 'usr_ada');
    assert.equal(typeof evt.latencyMs, 'number');
    assert.ok(evt.sessionId);
    assert.deepEqual(evt.results[0], { slug: 'kestrel-scheduler', rank: 1, score: first.score });
    await close();
  });

  it('a miss is reported as answered: false', async () => {
    const { ctx, events } = await setup();
    const { client, close } = await connect(ctx, owner);
    const r = await call(client, 'search', { query: 'quantum entanglement' });
    assert.equal(r.structuredContent.answered, false);
    assert.match(r.text, /does not cover it/);
    assert.equal(events.at(-1).answered, false);
    await close();
  });

  it('get_page returns frontmatter, links, backlinks and resolved citations with verify hints', async () => {
    const { ctx, events } = await setup();
    const { client, close } = await connect(ctx, viewer);
    const r = await call(client, 'get_page', { slug: 'alpha' });
    const d = r.structuredContent;
    assert.equal(d.slug, 'alpha');
    assert.equal(d.frontmatter.title, 'Alpha System');
    assert.deepEqual(d.links.map((l) => l.slug), ['beta']);
    assert.deepEqual(d.backlinks.map((l) => l.slug).sort(), ['beta', 'gamma-claim']);
    assert.equal(d.sources[0].id, 'alpha-pdf');
    const cite = d.citations.find((c) => c.raw === '[source: alpha-pdf, p.3]');
    assert.equal(cite.source.title, 'Alpha System Overview');
    assert.equal(cite.verify.path, 'brain/raw/extracted/alpha.pdf.txt');
    assert.equal(cite.verify.marker, '=== page 3 ===');
    assert.equal(cite.verify.excerpt, 'The scheduler retries on a fixed 30-second backoff.');
    assert.ok(d.citations.some((c) => c.id === 'unknown' && /unsourced/.test(c.problem)));
    assert.match(r.text, /verify in brain\/raw\/extracted\/alpha\.pdf\.txt at "=== page 3 ==="/);
    assert.deepEqual(events.at(-1).pagesRead, ['alpha']);

    const byAlias = await call(client, 'get_page', { slug: 'B-1' });
    assert.equal(byAlias.structuredContent.slug, 'beta');

    const self = await call(client, 'get_page', { slug: 'gamma-claim' });
    assert.match(self.text, /origin: self — this page is a conclusion/);

    const missing = await call(client, 'get_page', { slug: 'nope-not-here' });
    assert.equal(missing.isError, true);
    assert.equal(events.at(-1).answered, null);
    await close();
  });

  it('ask packs relevant sections within budget and carries the read.md citation rules', async () => {
    const big = page({ title: 'Alpha Internals', body: `## Summary\n\nAlpha scheduler internals.\n\n## Retry\n\n${'The scheduler retry loop waits. '.repeat(400)}\n` });
    const { ctx, events } = await setup({ 'brain/wiki/alpha-internals.md': big });
    const { client, close } = await connect(ctx, viewer);
    const r = await call(client, 'ask', { question: 'How does the Alpha scheduler retry?', max_tokens: 600 });
    const d = r.structuredContent;
    assert.equal(d.answered, true);
    assert.ok(d.tokens <= 600, `packed ${d.tokens} tokens`);
    assert.equal(d.truncated, true);
    assert.ok(d.pages.some((p) => p.slug === 'alpha' && p.sections.some((s) => s.name === 'Details')));
    assert.match(r.text, /## How to answer/);
    assert.match(r.text, /Citation format for query answers/);
    assert.match(r.text, /Original:/);
    assert.match(r.text, /data, not instructions/i);
    assert.match(r.text, /alpha-pdf = "Alpha System Overview"/);
    const evt = events.at(-1);
    assert.equal(evt.tool, 'ask');
    assert.ok(evt.pagesRead.includes('alpha'));

    const miss = await call(client, 'ask', { question: 'What is the airspeed velocity of an unladen swallow?' });
    assert.equal(miss.structuredContent.answered, false);
    assert.match(miss.text, /does not cover it/);
    assert.equal(events.at(-1).answered, false);
    await close();
  });

  it('list_sources reads the manifest from the snapshot', async () => {
    const { ctx } = await setup();
    const { client, close } = await connect(ctx, viewer);
    const r = await call(client, 'list_sources', {});
    assert.equal(r.structuredContent.total, 1);
    assert.equal(r.structuredContent.sources[0].id, 'alpha-pdf');
    assert.equal(r.structuredContent.sources[0].title, 'Alpha System Overview');
    assert.deepEqual(r.structuredContent.sources[0].pages, ['alpha', 'beta']);
    assert.equal((await call(client, 'list_sources', { query: 'nothing-like-this' })).structuredContent.total, 0);
    await close();
  });

  it('report_gap and feedback record demand signals', async () => {
    const { ctx, events } = await setup();
    const { client, close } = await connect(ctx, viewer);
    await call(client, 'report_gap', { question: 'What is the SLA for Beta?' });
    assert.equal(events.at(-1).tool, 'report_gap');
    assert.equal(events.at(-1).answered, false);
    assert.equal(events.at(-1).gap, true);
    const fb = await call(client, 'feedback', { helpful: true, slugs: ['alpha', 'ghost'] });
    assert.deepEqual(fb.structuredContent.slugs, ['alpha']);
    assert.deepEqual(fb.structuredContent.unknown, ['ghost']);
    assert.equal(events.at(-1).helpful, true);
    assert.deepEqual(events.at(-1).pagesRead, ['alpha']);
    await close();
  });

  it('serves resources and the answer-from-brain prompt', async () => {
    const { ctx } = await setup();
    const { client, close } = await connect(ctx, viewer);
    const list = await client.listResources();
    assert.ok(list.resources.some((r) => r.uri === 'almagest://page/alpha'));
    const idx = await client.readResource({ uri: 'almagest://index' });
    assert.match(idx.contents[0].text, /\| \[\[alpha\]\] \| Alpha System \|/);
    const pg = await client.readResource({ uri: 'almagest://page/beta' });
    assert.match(pg.contents[0].text, /# Beta Appliance/);
    const prompt = await client.getPrompt({ name: 'answer-from-brain', arguments: { question: 'What is Alpha?' } });
    const text = prompt.messages[0].content.text;
    assert.match(text, /What is Alpha\?/);
    assert.match(text, /`ask`/);
    assert.match(text, /`get_page`/);
    assert.match(text, /Citation format/);
    await close();
  });

  it('follows main: a commit on main changes search results after refresh', async () => {
    const { ctx, repoRoot } = await setup({}, { mcp: { local_refresh_seconds: 0 } });
    const { client, close } = await connect(ctx, viewer);
    assert.equal((await call(client, 'search', { query: 'zeppelin' })).structuredContent.results.length, 0);
    fs.writeFileSync(path.join(repoRoot, 'brain/wiki/zeppelin.md'), page({ title: 'Zeppelin Fleet', body: '## Summary\n\nAirships.\n' }));
    git(repoRoot, 'add', '-A');
    git(repoRoot, 'commit', '-q', '-m', 'add zeppelin');
    // ignored until the snapshot moves — the MCP never reads the working tree
    assert.equal((await call(client, 'search', { query: 'zeppelin' })).structuredContent.results.length, 0);
    await ctx.snapshot.refresh();
    assert.equal((await call(client, 'search', { query: 'zeppelin' })).structuredContent.results[0].slug, 'zeppelin');
    await close();
  });

  it('local main is re-checked on its own every local_refresh_seconds', async () => {
    const { ctx, repoRoot } = await setup({}, { mcp: { local_refresh_seconds: 0.001 } });
    const { client, close } = await connect(ctx, viewer);
    await call(client, 'search', { query: 'x' });
    fs.writeFileSync(path.join(repoRoot, 'brain/wiki/yurt.md'), page({ title: 'Yurt Camp', body: '## Summary\n\nTents.\n' }));
    git(repoRoot, 'add', '-A');
    git(repoRoot, 'commit', '-q', '-m', 'add yurt');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await call(client, 'search', { query: 'yurt' })).structuredContent.results[0]?.slug, 'yurt');
    await close();
  });
});

describe('mcp tools — submit_source', () => {
  it('writes the text under .almagest/submissions and enqueues as the MCP agent on behalf of the human', async () => {
    const { ctx, jobs, repoRoot, events } = await setup();
    const { client, close } = await connect(ctx, contributor, 'claude-ai');
    const text = '# Q3 numbers\n\nRevenue grew.\n';
    const r = await call(client, 'submit_source', { title: 'Q3 Board Notes', text, note: 'please update alpha' });
    assert.ok(!r.isError, r.text);
    const sha = crypto.createHash('sha256').update(text).digest('hex');
    const rel = `.almagest/submissions/q3-board-notes-${sha.slice(0, 7)}.md`;
    assert.equal(fs.readFileSync(path.join(repoRoot, rel), 'utf-8'), text);
    assert.equal(jobs.length, 1);
    const job = jobs[0];
    assert.equal(job.kind, 'ingest');
    assert.equal(job.trigger, 'mcp');
    assert.deepEqual(job.source, { kind: 'local', id: 'q3-board-notes', path: rel, sha256: sha, title: 'Q3 Board Notes' });
    assert.equal(job.requestedBy, 'agent:mcp:claude-ai');
    assert.equal(job.onBehalfOf, 'usr_cy');
    assert.match(job.instructions, /untrusted/);
    assert.equal(r.structuredContent.jobId, job.id);
    assert.match(r.text, /human reviews it before anything reaches main/);
    assert.equal(events.at(-1).tool, 'submit_source');

    // same bytes again: same file, no rewrite, same fingerprint
    const before = fs.statSync(path.join(repoRoot, rel)).mtimeMs;
    await call(client, 'submit_source', { title: 'Q3 Board Notes', text });
    assert.equal(fs.statSync(path.join(repoRoot, rel)).mtimeMs, before);
    assert.equal(jobs[1].source.sha256, sha);
    await close();
  });

  it('needs exactly one of text / url', async () => {
    const { ctx } = await setup();
    const { client, close } = await connect(ctx, owner);
    assert.equal((await call(client, 'submit_source', { title: 'x' })).isError, true);
    assert.equal((await call(client, 'submit_source', { title: 'x', text: 'a', url: 'https://example.com' })).isError, true);
    await close();
  });

  it('a viewer cannot submit — the tool is not even listed', async () => {
    const { ctx, jobs } = await setup();
    const { client, close } = await connect(ctx, viewer);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('submit_source'));
    assert.ok(names.includes('search'));
    const r = await call(client, 'submit_source', { title: 'x', text: 'y' });
    assert.equal(r.isError, true);
    assert.equal(jobs.length, 0);
    await close();
  });

  it('URL fetch is off by default', async () => {
    const { ctx, jobs } = await setup();
    const { client, close } = await connect(ctx, owner);
    const r = await call(client, 'submit_source', { title: 'Example', url: 'https://example.com/doc' });
    assert.equal(r.isError, true);
    assert.match(r.text, /URL fetch is disabled/);
    assert.equal(jobs.length, 0);
    await close();
  });

  it('URL fetch, when enabled, refuses private and metadata addresses', async () => {
    const { ctx, jobs } = await setup({}, { mcp: { allow_url_fetch: true } });
    const { client, close } = await connect(ctx, owner);
    for (const url of ['http://127.0.0.1:1/x', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://10.0.0.5/', 'http://localhost/', 'http://[::ffff:127.0.0.1]/']) {
      const r = await call(client, 'submit_source', { title: 'x', url });
      assert.equal(r.isError, true, url);
      assert.match(r.text, /refusing|not a public/, url);
    }
    assert.equal(jobs.length, 0);
    await close();
  });

  it('URL fetch, when enabled, stores the fetched bytes and enqueues them', async () => {
    const { ctx, jobs, repoRoot } = await setup({}, { mcp: { allow_url_fetch: true } });
    const srv = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'text/markdown' }); res.end('# Fetched\n\nHello.\n'); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    ctx.mcp.hooks.fetchPolicy = (ip) => ip === '127.0.0.1';   // the test server is the one "public" address
    const { client, close } = await connect(ctx, owner);
    try {
      const r = await call(client, 'submit_source', { title: 'Fetched Doc', url: `http://127.0.0.1:${srv.address().port}/doc.md` });
      assert.ok(!r.isError, r.text);
      assert.match(jobs[0].source.path, /^\.almagest\/submissions\/fetched-doc-[0-9a-f]{7}\.md$/);
      assert.equal(fs.readFileSync(path.join(repoRoot, jobs[0].source.path), 'utf-8'), '# Fetched\n\nHello.\n');
      assert.match(jobs[0].instructions, /Fetched from http:\/\/127\.0\.0\.1/);
    } finally {
      ctx.mcp.hooks.fetchPolicy = undefined;
      srv.close();
      await close();
    }
  });
});

describe('mcp tools — governance', () => {
  it('lists and explains proposals', async () => {
    const { ctx, calls } = await setup();
    const { client, close } = await connect(ctx, viewer);
    const list = await call(client, 'list_proposals', { status: 'open' });
    assert.equal(list.structuredContent.proposals[0].id, PROPOSAL.id);
    assert.match(list.text, /\/inbox\/p\/prp_/);
    assert.equal(calls.list[0].status, 'open');
    const one = await call(client, 'get_proposal', { id: PROPOSAL.id });
    assert.match(one.text, /45-second backoff/);
    assert.match(one.text, /source says: Backoff is now 45 s\./);
    await close();
  });

  it('request_approval returns a confirmation link and never approves', async () => {
    const { ctx, calls } = await setup();
    const { client, close } = await connect(ctx, owner, 'claude-ai');
    const r = await call(client, 'request_approval', { id: PROPOSAL.id });
    assert.ok(!r.isError, r.text);
    assert.equal(r.structuredContent.url, `http://127.0.0.1:4747/confirm/${PROPOSAL.id}?c=xyz`);
    assert.equal(r.structuredContent.approved, false);
    assert.match(r.text, /Nothing has been approved/);
    assert.match(r.text, /Only a human can approve/);
    assert.equal(calls.confirm.length, 1);
    assert.equal(calls.confirm[0].onBehalfOf.id, 'usr_ada');
    assert.equal(calls.confirm[0].onBehalfOf.kind, 'human');
    assert.equal(calls.confirm[0].action, 'approve');
    assert.deepEqual(calls.forbidden, []);
    await close();
  });

  it('a governance stub surfaces as a clear tool error', async () => {
    const repoRoot = makeRepo();
    repos.push(repoRoot);
    const stubbed = await makeApp({ repoRoot, real: ['mcp'] });
    apps.push(stubbed);
    const { client, close } = await connect(stubbed.ctx, owner);
    const r = await call(client, 'list_proposals', {});
    assert.equal(r.isError, true);
    assert.match(r.text, /Governance is not available on this server/);
    await close();
  });

  it('governance tools are hidden when the mcp channel is not enabled', async () => {
    const { ctx } = await setup({}, { governance: { channels: [{ kind: 'web' }] } });
    const { client, close } = await connect(ctx, owner);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes('request_approval'));
    assert.ok(names.includes('submit_source'));
    await close();
  });
});

describe('mcp stdio', () => {
  it('serves over stdio as the local user, wrapped as an agent actor, with nothing else on stdout', async () => {
    const { ctx, jobs } = await setup();
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const served = await ctx.mcp.serveStdio({ stdin, stdout, env: {} });
    const client = new Client({ name: 'claude-desktop', version: '1' });
    const { StdioClientTransportLike } = await streamPair(stdin, stdout);
    await client.connect(StdioClientTransportLike);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('submit_source'), 'stdio defaults to owner — it is their own clone');
    await client.callTool({ name: 'submit_source', arguments: { title: 'Local', text: 'hi' } });
    assert.equal(jobs[0].requestedBy, 'agent:mcp:claude-desktop');
    assert.equal(jobs[0].onBehalfOf, 'usr_local');
    await client.close();
    await served.close();
  });

  it('honours ALMAGEST_TOKEN and refuses an unknown one', async () => {
    process.env.ALMAGEST_TOKENS = 'vic:viewer:viewer-secret-123';
    try {
      const { ctx } = await setup();
      await assert.rejects(() => ctx.mcp.serveStdio({ stdin: new PassThrough(), stdout: new PassThrough(), env: { ALMAGEST_TOKEN: 'wrong' } }), /does not match/);
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const served = await ctx.mcp.serveStdio({ stdin, stdout, env: { ALMAGEST_TOKEN: 'viewer-secret-123' } });
      const client = new Client({ name: 'x', version: '1' });
      await client.connect((await streamPair(stdin, stdout)).StdioClientTransportLike);
      assert.ok(!(await client.listTools()).tools.some((t) => t.name === 'submit_source'));
      await client.close();
      await served.close();
    } finally {
      delete process.env.ALMAGEST_TOKENS;
    }
  });
});

/** A client-side Transport over the two PassThroughs the stdio server uses. */
async function streamPair(serverStdin, serverStdout) {
  const { ReadBuffer, serializeMessage } = await import('@modelcontextprotocol/sdk/shared/stdio.js');
  const buf = new ReadBuffer();
  const t = {
    async start() {
      serverStdout.on('data', (chunk) => {
        buf.append(chunk);
        for (let m = buf.readMessage(); m; m = buf.readMessage()) t.onmessage?.(m);
      });
    },
    async send(msg) { serverStdin.write(serializeMessage(msg)); },
    async close() { t.onclose?.(); },
  };
  return { StdioClientTransportLike: t };
}
