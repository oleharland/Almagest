import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { humanActor } from '../../src/core/auth.mjs';
import { buildSnapshot } from '../../src/connectors/snapshot-file.mjs';
import { createBrain } from '../../src/mcp/brain.mjs';
import { createLookup, INGEST_COUNT_NS, REJECTED_NS, roleRank } from '../../src/mcp/lookup.mjs';
import { FIXTURES, rmrf } from '../helpers.mjs';
import { call, connect, makeRepo, mcpApp, page } from './_util.mjs';

const repos = [];
const apps = [];
after(async () => {
  for (const a of apps) { await a.ctx.mcp.close(); await a.stop(); }
  repos.forEach(rmrf);
});

const owner = humanActor({ id: 'usr_ada', display: 'Ada', roles: ['owner'] });
const contributor = humanActor({ id: 'usr_cy', display: 'Cy', roles: ['contributor'] });
const viewer = humanActor({ id: 'usr_vic', display: 'Vic', roles: ['viewer'] });

const SOURCE_KW = ['zephyr', 'gateway', 'drains'];
const STAGED_KW = ['quasar', 'ledger', 'keys'];
const CONNECTOR_KW = ['nimbus', 'broker', 'retains'];

const MANIFEST = `version: 1

sources:
  - id: alpha-pdf
    kind: local
    path: brain/raw/processed/alpha.pdf
    sha256: 1111111111111111111111111111111111111111111111111111111111111111
    extracted: brain/raw/extracted/alpha.pdf.txt
    extracted_sha256: 3b50e003ca81fc8afceca1f8d8a259adfd2a3940144e429640ee160e4f8677d9
    bytes: 1024
    first_ingested: 2026-01-01
    last_ingested: 2026-01-01
    pages:
      - alpha
      - beta
    status: ingested
  - id: ops-pdf
    kind: local
    path: brain/raw/processed/ops.pdf
    sha256: 2222222222222222222222222222222222222222222222222222222222222222
    extracted: brain/raw/extracted/ops.pdf.txt
    extracted_sha256: 4444444444444444444444444444444444444444444444444444444444444444
    bytes: 2048
    first_ingested: 2026-01-01
    last_ingested: 2026-01-01
    pages: []
    status: ingested
`;

const FILES = {
  'brain/manifest.yaml': MANIFEST,
  'brain/raw/extracted/ops.pdf.txt': '=== page 1 ===\nOps runbook\n\n=== page 2 ===\nThe zephyr gateway drains connections for ninety seconds before a restart.\n',
};

const CANONICAL = page({ title: 'Message Retention Policy', body: '## Summary\n\nThe nimbus broker retention policy is fixed: messages are kept for seven days.\n' })
  .replace('tier: curated', 'tier: canonical');

function snapshotText(connector, ref, title, body) {
  return buildSnapshot({ connector, server: 'google-drive', ref, title, body });
}

const CONNECTOR_DOC = (n = 1) => ({
  ref: `doc${n}`, title: `Broker notes ${n}`,
  body: `=== section: Retention ===\nThe nimbus broker retains messages for eleven days (variant ${n}).`,
});

/**
 * An app with lookup on, a fake ingest and stubbed connectors. `docs` is what the
 * fake provider holds; `change` is the SourceRef change a fetch reports.
 */
async function setup({ files = {}, lookup = {}, overrides = {}, docs = [], change = 'new', searchResult } = {}) {
  const repoRoot = makeRepo({ ...FILES, ...files });
  repos.push(repoRoot);
  const t = await mcpApp({
    repoRoot,
    overrides: { ...overrides, mcp: { lookup: { enabled: true, rate: { per_caller_per_minute: 1000, per_connector_per_minute: 1000 }, ...lookup } } },
  });
  apps.push(t.app);
  const calls = { search: [], fetch: [], list: 0 };
  const provider = { docs, change, hang: new Set() };
  t.ctx.connectors = {
    async list() { calls.list += 1; return [{ id: 'team-drive', lookup: true, searchable: true }]; },
    async search(id, q) {
      calls.search.push({ id, ...q });
      if (searchResult) return searchResult(q);
      return provider.docs.map((d) => ({ ref: d.ref, title: d.title, version: 'v1' }));
    },
    async fetchOne(id, item) {
      calls.fetch.push(item.ref);
      if (provider.hang.has(item.ref)) return new Promise(() => {});
      const d = provider.docs.find((x) => x.ref === item.ref);
      const snap = snapshotText(id, d.ref, d.title, d.body);
      return {
        ref: { kind: 'connector', id: `${id}:${d.ref}`, connector: id, ref: d.ref, server: 'google-drive', path: `brain/raw/extracted/${id}/${d.ref}.txt`, sha256: snap.sha256, title: d.title, change: provider.change, fetchedAt: '2026-11-18T10:00:00.000Z', via: 'lookup' },
        text: snap.text, sha256: snap.sha256, title: d.title, truncated: false, reused: false,
      };
    },
  };
  const brain = createBrain(t.ctx, t.ctx.mcp.config);
  const lookupApi = createLookup(t.ctx, t.ctx.mcp.config, brain);
  const find = (args = {}) => lookupApi.find({ question: 'What does the thing do?', keywords: CONNECTOR_KW, human: contributor, transport: 'http', budget: 2500, ...args });
  return { ...t, calls, provider, find, repoRoot };
}

function stage(ctx, connector, ref, body, title = 'Staged ledger notes') {
  const snap = snapshotText(connector, ref, title, body);
  const file = path.join(ctx.config.paths.state, 'connector-snapshots', connector, `${ref}.txt`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, snap.text);
  return snap;
}

const STAGED_BODY = '=== section: Rotation ===\nThe quasar ledger rotates keys every fortnight.';

async function connectAs(ctx, human, transport) {
  const server = ctx.mcp.createServer({ human, ...(transport ? { transport } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

describe('live lookup — the ladder', () => {
  it('roleRank follows the codebase ordering', () => {
    assert.ok(roleRank(owner) > roleRank(contributor));
    assert.ok(roleRank(contributor) > roleRank(viewer));
    assert.equal(roleRank({ roles: ['viewer'], anonymous: true }), -1);
  });

  it('sources answers first, and the ladder stops there', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()] });
    stage(t.ctx, 'team-drive', 'doc9', STAGED_BODY);
    const r = await t.find({ keywords: SOURCE_KW });
    assert.equal(r.step, 'sources');
    assert.equal(r.kind, 'source');
    assert.equal(r.items[0].doc.meta.sourceId, 'ops-pdf');
    assert.equal(r.items[0].passages[0].locator, 'p.2');
    assert.deepEqual(r.stats.steps, ['sources']);
    assert.equal(t.calls.search.length, 0);
    assert.equal(t.calls.list, 0);
  });

  it('staged answers when sources do not, and no provider is called', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()] });
    stage(t.ctx, 'team-drive', 'doc9', STAGED_BODY);
    const r = await t.find({ keywords: STAGED_KW });
    assert.equal(r.step, 'staged');
    assert.equal(r.kind, 'unreviewed');
    assert.equal(r.items[0].doc.meta.connector, 'team-drive');
    assert.equal(r.items[0].passages[0].locator, '§Rotation');
    assert.deepEqual(r.stats.steps, ['sources', 'staged']);
    assert.equal(t.calls.search.length, 0);
  });

  it('staged skips a snapshot already on main, and one from a connector without lookup', async () => {
    const t = await setup({ docs: [] });
    const snap = stage(t.ctx, 'team-drive', 'doc9', STAGED_BODY);
    const other = stage(t.ctx, 'other-drive', 'doc8', '=== section: X ===\nThe quasar ledger rotates keys often.');
    assert.ok(other.sha256);
    assert.equal((await t.find({ keywords: STAGED_KW })).step, 'staged');
    // the same bytes committed on main: the sources step covers them, staged must not serve them again
    const onMain = MANIFEST.replace('4444444444444444444444444444444444444444444444444444444444444444', snap.sha256);
    const t2 = await setup({ files: { 'brain/manifest.yaml': onMain } });
    stage(t2.ctx, 'team-drive', 'doc9', STAGED_BODY);
    assert.equal((await t2.find({ keywords: STAGED_KW })).step, null);
  });

  it('connectors answers last, within max_fetch documents, and ranks only what it fetched', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC(1), CONNECTOR_DOC(2), CONNECTOR_DOC(3), CONNECTOR_DOC(4)], lookup: { max_fetch: 2 } });
    const r = await t.find();
    assert.equal(r.step, 'connectors');
    assert.deepEqual(t.calls.fetch, ['doc1', 'doc2']);
    assert.equal(r.stats.fetched, 2);
    assert.equal(r.stats.connectorsAsked, 1);
    assert.deepEqual(r.stats.steps, ['sources', 'staged', 'connectors']);
    assert.equal(r.items[0].doc.meta.sourceRef.change, 'new');
  });

  it('nothing found leaves an empty result and never throws', async () => {
    const t = await setup({ searchResult: () => { throw new Error('provider down'); } });
    const r = await t.find();
    assert.equal(r.step, null);
    assert.deepEqual(r.items, []);
  });

  it('a lookup started inside a lookup does nothing', async () => {
    let inner;
    const t = await setup({ docs: [CONNECTOR_DOC()] });
    const real = t.ctx.connectors.search;
    t.ctx.connectors.search = async (id, q) => { inner = await t.find({ keywords: SOURCE_KW }); return real(id, q); };
    const r = await t.find();
    assert.equal(r.step, 'connectors');
    assert.equal(inner.step, null);
    assert.equal(inner.skipped[0].reason, 'nested lookup');
  });
});

describe('live lookup — gates', () => {
  it('staged and connectors need min_role; sources is open to a viewer', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()] });
    stage(t.ctx, 'team-drive', 'doc9', STAGED_BODY);
    assert.equal((await t.find({ human: viewer, keywords: SOURCE_KW })).step, 'sources');
    assert.equal((await t.find({ human: viewer, keywords: STAGED_KW })).step, null);
    assert.equal((await t.find({ human: viewer, keywords: CONNECTOR_KW })).step, null);
    assert.equal(t.calls.search.length, 0);
    assert.equal((await t.find({ human: contributor, keywords: STAGED_KW })).step, 'staged');
    assert.equal((await t.find({ human: owner, keywords: CONNECTOR_KW })).step, 'connectors');
  });

  it('min_role: reviewer shuts a contributor out', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()], lookup: { min_role: 'reviewer' } });
    assert.equal((await t.find({ human: contributor })).step, null);
    assert.equal((await t.find({ human: owner })).step, 'connectors');
  });

  it('anonymization.enabled turns staged and connectors off, keeps sources, and logs why once', async () => {
    const config = `${fs.readFileSync(path.join(FIXTURES, 'clean', 'brain.config.yaml'), 'utf-8')}\nanonymization:\n  enabled: true\n`;
    const t = await setup({ files: { 'brain.config.yaml': config }, docs: [CONNECTOR_DOC()] });
    stage(t.ctx, 'team-drive', 'doc9', STAGED_BODY);
    assert.equal(t.ctx.config.v1.raw.anonymization.enabled, true);
    assert.equal((await t.find({ human: owner, keywords: STAGED_KW })).step, null);
    assert.equal((await t.find({ human: owner, keywords: CONNECTOR_KW })).step, null);
    assert.equal((await t.find({ human: owner, keywords: SOURCE_KW })).step, 'sources');
    assert.equal(t.calls.search.length, 0);
    const logged = t.app.log.lines.filter((l) => JSON.stringify(l).includes('anonymization.enabled'));
    assert.ok(logged.length >= 1, 'the reason is logged');
  });

  it('send_query: false turns connectors off but leaves staged', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()], lookup: { send_query: false } });
    stage(t.ctx, 'team-drive', 'doc9', STAGED_BODY);
    assert.equal((await t.find()).step, null);
    assert.equal(t.calls.search.length, 0);
    assert.equal((await t.find({ keywords: STAGED_KW })).step, 'staged');
  });

  it('stdio skips the connectors step', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()] });
    assert.equal((await t.find({ transport: 'stdio' })).step, null);
    assert.equal(t.calls.search.length, 0);
    assert.equal((await t.find({ transport: 'http' })).step, 'connectors');
  });

  it('the deadline returns what there is, incomplete, and does not throw', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC(1), CONNECTOR_DOC(2)], lookup: { timeout_ms: 150 } });
    t.provider.hang.add('doc2');
    const r = await t.find();
    assert.equal(r.incomplete, true);
    assert.equal(r.step, 'connectors', 'the document fetched before the deadline is still served');
    assert.equal(r.items.length, 1);

    const hung = await setup({ lookup: { timeout_ms: 100 }, searchResult: () => new Promise(() => {}) });
    const none = await hung.find();
    assert.equal(none.incomplete, true);
    assert.equal(none.step, null);
  });

  it('a negative result is cached per connector and terms, so the provider is asked once', async () => {
    const t = await setup({ searchResult: () => [] });
    await t.find({ keywords: ['aaa', 'bbb'] });
    const second = await t.find({ keywords: ['bbb', 'aaa'] });
    assert.equal(t.calls.search.length, 1);
    assert.equal(second.stats.cacheHits, 1);
    await t.find({ keywords: ['aaa', 'ccc'] });
    assert.equal(t.calls.search.length, 2, 'other terms are asked again');
  });

  it('negative_ttl_minutes: 0 does not cache', async () => {
    const t = await setup({ searchResult: () => [], lookup: { negative_ttl_minutes: 0 } });
    await t.find({ keywords: ['aaa'] });
    await t.find({ keywords: ['aaa'] });
    assert.equal(t.calls.search.length, 2);
  });

  it('per-connector rate limit skips the provider call and says so', async () => {
    const t = await setup({ searchResult: () => [], lookup: { rate: { per_caller_per_minute: 1000, per_connector_per_minute: 2 } } });
    await t.find({ keywords: ['aaa'] });
    await t.find({ keywords: ['bbb'] });
    const r = await t.find({ keywords: ['ccc'] });
    assert.equal(t.calls.search.length, 2);
    assert.match(r.skipped.map((s) => s.reason).join(), /rate limit for connector team-drive/);
  });

  it('per-caller rate limit skips the whole lookup, for that caller only', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()], lookup: { rate: { per_caller_per_minute: 2, per_connector_per_minute: 1000 } } });
    assert.equal((await t.find({ keywords: SOURCE_KW })).step, 'sources');
    assert.equal((await t.find({ keywords: SOURCE_KW })).step, 'sources');
    const third = await t.find({ keywords: SOURCE_KW });
    assert.equal(third.step, null);
    assert.equal(third.skipped[0].step, 'all');
    assert.match(third.skipped[0].reason, /rate limit/);
    assert.equal((await t.find({ human: owner, keywords: SOURCE_KW })).step, 'sources');
  });
});

describe('live lookup — rejected sources', () => {
  async function reject(t, sha) {
    t.ctx.bus.emit('proposal.rejected', { proposal: { id: 'prp_1', source: { kind: 'connector', connector: 'team-drive', sha256: sha } }, actor: owner });
    await t.ctx.bus.drain();
  }

  it('records the sha256 of a rejected connector source', async () => {
    const t = await setup();
    await reject(t, 'ABCDEF');
    assert.ok(await t.ctx.store.kv.get(REJECTED_NS, 'abcdef'));
    t.ctx.bus.emit('proposal.rejected', { proposal: { id: 'prp_2', source: { kind: 'local', sha256: 'zzz' } }, actor: owner });
    await t.ctx.bus.drain();
    assert.equal(await t.ctx.store.kv.get(REJECTED_NS, 'zzz'), null, 'a local source is not recorded');
  });

  it('staged and connectors skip a rejected sha256, and serve the document again once it changes', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC(1)] });
    const staged = stage(t.ctx, 'team-drive', 'doc9', STAGED_BODY);
    assert.equal((await t.find({ keywords: STAGED_KW })).step, 'staged');
    await reject(t, staged.sha256);
    assert.equal((await t.find({ keywords: STAGED_KW })).step, null);
    stage(t.ctx, 'team-drive', 'doc9', `${STAGED_BODY} Updated after review.`);
    assert.equal((await t.find({ keywords: STAGED_KW })).step, 'staged');

    const fetched = snapshotText('team-drive', 'doc1', 'Broker notes 1', CONNECTOR_DOC(1).body);
    await reject(t, fetched.sha256);
    assert.equal((await t.find()).step, null, 'the fetched document is skipped');
    t.provider.docs = [{ ...CONNECTOR_DOC(1), body: `${CONNECTOR_DOC(1).body} Edited.` }];
    assert.equal((await t.find({ keywords: ['nimbus', 'broker', 'retains', 'edited'] })).step, 'connectors');
  });
});

describe('live lookup — enrichment', () => {
  it('queues an ingest job with trigger lookup for a fetched document that contributed', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()] });
    const r = await t.find({ question: 'How long does the broker keep messages?' });
    assert.equal(t.jobs.length, 1);
    const job = t.jobs[0];
    assert.equal(job.kind, 'ingest');
    assert.equal(job.trigger, 'lookup');
    assert.equal(job.requestedBy, 'svc:lookup');
    assert.equal(job.onBehalfOf, 'usr_cy');
    assert.equal(job.source.ref, 'doc1');
    assert.equal(job.source.connector, 'team-drive');
    assert.match(job.instructions, /How long does the broker keep messages\?/);
    assert.deepEqual(r.queued.map((q) => q.jobId), [job.id]);
  });

  it('does not queue an unchanged document, a staged one or a source passage', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()], change: 'unchanged' });
    assert.equal((await t.find()).step, 'connectors');
    assert.equal(t.jobs.length, 0);
    stage(t.ctx, 'team-drive', 'doc9', STAGED_BODY);
    await t.find({ keywords: STAGED_KW });
    await t.find({ keywords: SOURCE_KW });
    assert.equal(t.jobs.length, 0);
  });

  it('ingest: off queues nothing', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()], lookup: { ingest: 'off' } });
    assert.equal((await t.find()).step, 'connectors');
    assert.equal(t.jobs.length, 0);
  });

  it('max_ingest_per_day caps the jobs and says so', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC(1), CONNECTOR_DOC(2)], lookup: { max_ingest_per_day: 1 } });
    const r = await t.find();
    assert.equal(t.jobs.length, 1);
    assert.match(r.skipped.map((s) => s.reason).join(), /daily limit/);
    const day = new Date().toISOString().slice(0, 10);
    assert.equal((await t.ctx.store.kv.get(INGEST_COUNT_NS, day)).n, 1);
    await t.find({ keywords: ['nimbus', 'broker', 'retains', 'again'] });
    assert.equal(t.jobs.length, 1, 'the cap holds across lookups');
  });

  it('leaves the question out of the instructions when queries are hashed', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()], overrides: { telemetry: { store_queries: 'hashed' } } });
    await t.find({ question: 'How long does the broker keep messages?' });
    assert.equal(t.jobs.length, 1);
    assert.doesNotMatch(t.jobs[0].instructions, /broker keep/);
    assert.match(t.jobs[0].instructions, /live lookup/);
  });

  it('a failed enqueue is logged and does not fail the lookup', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()] });
    t.ctx.ingest.enqueue = async () => { throw new Error('queue is full'); };
    const r = await t.find();
    assert.equal(r.step, 'connectors');
    assert.deepEqual(r.queued, []);
  });
});

describe('live lookup — ask', () => {
  it('lookup disabled, or finding nothing, leaves ask unchanged', async () => {
    const t = await setup();
    const { client, close } = await connect(t.ctx, owner);
    const question = 'What is the airspeed velocity of an unladen swallow?';
    t.ctx.mcp.config.lookup.enabled = false;
    const off = await call(client, 'ask', { question });
    t.ctx.mcp.config.lookup.enabled = true;
    const on = await call(client, 'ask', { question });
    assert.equal(on.text, off.text);
    assert.deepEqual(on.structuredContent, off.structuredContent);
    assert.ok(!('lookup' in on.structuredContent));
    assert.match(on.text, /does not cover it/);
    // an answered question is untouched too, and never reaches lookup
    const before = t.calls.search.length;
    const hit = await call(client, 'ask', { question: 'How does the Alpha scheduler retry?' });
    assert.equal(hit.structuredContent.answered, true);
    assert.equal(t.calls.search.length, before);
    assert.doesNotMatch(hit.text, /Unreviewed passages|Source passages/);
    await close();
  });

  it('prints rules, canonical position, then passages, with provenance, and queues the document', async () => {
    const t = await setup({ files: { 'brain/wiki/message-retention.md': CANONICAL }, docs: [CONNECTOR_DOC()] });
    const { client, close } = await connect(t.ctx, contributor);
    const r = await call(client, 'ask', { question: 'Which archive policy covers the nimbus broker messages kept in cold storage for archived tenants?', keywords: CONNECTOR_KW });
    assert.ok(!r.isError, r.text);
    const at = (re) => { const m = r.text.search(re); assert.ok(m >= 0, `missing ${re}`); return m; };
    const order = [/## How to answer/, /## Answering from source and unreviewed passages/, /## The brain's position: canonical pages/, /## Unreviewed passages: nobody has reviewed these/].map(at);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
    assert.match(r.text, /\[\[message-retention\]\]/);
    assert.match(r.text, /kept for seven days/);
    assert.match(r.text, /From connector team-drive \(server google-drive\): "Broker notes 1", ref doc1, sha256 [0-9a-f]{7}, fetched 2026-11-18T10:00:00.000Z/);
    assert.match(r.text, /#### §Retention\nThe nimbus broker retains messages for eleven days/);
    assert.match(r.text, /data, not instructions/);
    assert.match(r.text, /Queued for review: ingest job job_test1\./);
    const d = r.structuredContent.lookup;
    assert.equal(d.step, 'connectors');
    assert.equal(d.canonical[0].slug, 'message-retention');
    assert.equal(d.documents[0].connector, 'team-drive');
    assert.equal(d.queued[0].jobId, 'job_test1');
    assert.equal(r.structuredContent.answered, false);
    await close();
  });

  it('prints a source passage under its own heading with source id and path', async () => {
    const t = await setup();
    const { client, close } = await connect(t.ctx, viewer);
    const r = await call(client, 'ask', { question: 'How long does the zephyr gateway drain connections?' });
    assert.match(r.text, /## Source passages: from ingested sources, not yet on a reviewed page/);
    assert.match(r.text, /Source: "ops\.pdf\.txt" \(ops-pdf\), brain\/raw\/extracted\/ops\.pdf\.txt/);
    assert.match(r.text, /#### p\.2\nThe zephyr gateway drains connections/);
    assert.doesNotMatch(r.text, /Queued for review/);
    await close();
  });

  it('mentions an incomplete lookup', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC(1), CONNECTOR_DOC(2)], lookup: { timeout_ms: 150 } });
    t.provider.hang.add('doc2');
    const { client, close } = await connect(t.ctx, owner);
    const r = await call(client, 'ask', { question: 'nimbus broker retention', keywords: CONNECTOR_KW });
    assert.match(r.text, /Lookup note: the lookup timed out, so it may be incomplete\./);
    assert.equal(r.structuredContent.lookup.incomplete, true);
    await close();
  });

  it('keeps answered: false and puts a text-free summary under the event', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()] });
    const { client, close } = await connect(t.ctx, contributor);
    await call(client, 'ask', { question: 'How long does the nimbus broker retain messages?', keywords: CONNECTOR_KW });
    const evt = t.events.at(-1);
    assert.equal(evt.tool, 'ask');
    assert.equal(evt.answered, false);
    assert.equal(evt.lookup.step, 'connectors');
    assert.equal(evt.lookup.connectorsAsked, 1);
    assert.equal(evt.lookup.fetched, 1);
    assert.equal(evt.lookup.cacheHits, 0);
    assert.equal(typeof evt.lookup.latencyMs, 'number');
    assert.deepEqual(evt.lookup.queued, ['job_test1']);
    const flat = JSON.stringify(evt.lookup);
    assert.doesNotMatch(flat, /eleven days|retains|Broker notes/);
    await close();
  });

  it('uses the chat keywords in place of the question tokens', async () => {
    const t = await setup({ searchResult: () => [] });
    const { client, close } = await connect(t.ctx, owner);
    await call(client, 'ask', { question: 'What is the retention thing about?', keywords: ['nimbus', 'broker retention'] });
    assert.deepEqual(t.calls.search[0].terms, ['nimbus', 'broker retention']);
    await call(client, 'ask', { question: 'Where is the quasar rotation schedule?' });
    assert.deepEqual(t.calls.search[1].terms, ['quasar', 'rotation', 'schedule']);
    const tooMany = await call(client, 'ask', { question: 'x y', keywords: Array.from({ length: 13 }, (_, i) => `k${i}`) });
    assert.equal(tooMany.isError, true);
    const tooLong = await call(client, 'ask', { question: 'x y', keywords: ['k'.repeat(65)] });
    assert.equal(tooLong.isError, true);
    await close();
  });

  it('over stdio the connectors step is skipped', async () => {
    const t = await setup({ docs: [CONNECTOR_DOC()] });
    const { client, close } = await connectAs(t.ctx, owner, 'stdio');
    const r = await call(client, 'ask', { question: 'nimbus broker retention', keywords: CONNECTOR_KW });
    assert.doesNotMatch(r.text, /Unreviewed passages/);
    assert.equal(t.calls.search.length, 0);
    await close();
  });
});
