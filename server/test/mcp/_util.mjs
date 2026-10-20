/**
 * _util.mjs — shared fixtures for the MCP tests: fake telemetry / ingest /
 * governance modules that record what they were asked, an extra-pages brain
 * for ranking tests, and an in-process MCP client.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { makeApp, makeTempRepo } from '../helpers.mjs';

export function page({ title, type = 'topic', aliases = [], tags = [], body, origin = 'source', sources = [] }) {
  const src = sources.length
    ? `sources:\n${sources.map((s) => `  - id: ${s.id}\n    path: ${s.path}\n    sha256: "${s.sha256 || ''}"\n    title: "${s.title || ''}"`).join('\n')}\n`
    : 'sources: []\n';
  return `---
title: "${title}"
type: ${type}
tier: curated
origin: ${origin}
status: draft
confidence: medium
tags: [${tags.join(', ')}]
aliases: [${aliases.map((a) => `"${a}"`).join(', ')}]
owner: ""
date_created: "2026-01-01"
date_modified: "2026-01-01"
last_verified: "2026-01-01"
${src}related: []
---

${body}
`;
}

/** The clean fixture plus three pages built to test ranking: alias vs title vs body. */
export const RANKING_PAGES = {
  'brain/wiki/kestrel-scheduler.md': page({
    title: 'Job Runner', aliases: ['Kestrel'], body: '## Summary\n\nThe job runner executes batch work on a queue.\n',
  }),
  'brain/wiki/kestrel-deployment.md': page({
    title: 'Kestrel Deployment Guide', body: '## Summary\n\nHow the runner is rolled out to production clusters.\n',
  }),
  'brain/wiki/ops-notes.md': page({
    title: 'Operations Notes', body: '## Summary\n\nAssorted notes. Somebody once mentioned kestrel in passing while discussing lunch.\n',
  }),
};

export function makeRepo(files = {}) {
  return makeTempRepo({ files });
}

export function fakeTelemetry(events) {
  return {
    commands: {},
    async create(ctx) {
      ctx.demand = { async get(slugs) { return new Map(slugs.map((s) => [s, { score: 0, rank: 0, hot: false }])); }, async hot() { return []; } };
      return { record: (evt) => { events.push(evt); }, async gaps() { return []; }, async reverifyQueue() { return []; } };
    },
  };
}

export function fakeIngest(jobs) {
  return {
    commands: {},
    async create() {
      return {
        async enqueue(spec) { const job = { id: `job_test${jobs.length + 1}`, status: 'queued', ...spec }; jobs.push(job); return job; },
        async get(id) { return jobs.find((j) => j.id === id) || null; },
        async list() { return jobs; },
        async start() {},
        async stop() {},
      };
    },
  };
}

export const PROPOSAL = {
  id: 'prp_0000000001abcdefabcdef', jobId: 'job_1', branch: 'ingest/q3-deck-abcdef1', baseSha: 'a', headSha: 'b',
  status: 'open', title: 'Ingest Q3 deck', summary: 'Adds the Q3 numbers', source: { kind: 'local', id: 'q3-deck' }, submittedBy: 'agent:mcp:x',
  audit: { exit: 0, errors: 0, warnings: 0, findings: [] },
  changes: [{ slug: 'alpha', path: 'brain/wiki/alpha.md', action: 'update', tier: 'curated', hot: false, demand: 0, pageStatus: 'pending',
    claims: [{ op: 'change', text: 'The scheduler retries on a 45-second backoff.', before: '30-second', citation: { id: 'q3-deck', locator: 'p.4' }, excerpt: 'Backoff is now 45 s.' }] }],
  decisions: [], required: { approvals: 1, perPage: false, roles: [], teams: [], reasons: [] }, approvals: [],
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
};

export function fakeGovernance(calls) {
  return {
    commands: {},
    async create() {
      const no = (name) => async () => { calls.forbidden.push(name); throw new Error(`${name} must never be called from MCP`); };
      return {
        async listProposals(filter) { calls.list.push(filter); return [PROPOSAL]; },
        async getProposal(id) { calls.get.push(id); return id === PROPOSAL.id ? PROPOSAL : null; },
        async createConfirmation(prpId, onBehalfOf, action) {
          calls.confirm.push({ prpId, onBehalfOf, action });
          return { url: `http://127.0.0.1:4747/confirm/${prpId}?c=xyz`, code: 'K7Q-2P9', expiresAt: '2026-10-20T12:10:00.000Z' };
        },
        approve: no('approve'), reject: no('reject'), rejectPage: no('rejectPage'), requestChanges: no('requestChanges'),
        resolveDecision: no('resolveDecision'), createFromJob: no('createFromJob'),
      };
    },
  };
}

export function newCalls() {
  return { list: [], get: [], confirm: [], forbidden: [] };
}

/** App with the real MCP module and recording fakes for its neighbours. */
export async function mcpApp({ repoRoot, overrides = {}, modules = {} } = {}) {
  const events = [];
  const jobs = [];
  const calls = newCalls();
  const app = await makeApp({
    repoRoot,
    real: ['mcp'],
    overrides,
    modules: { telemetry: fakeTelemetry(events), ingest: fakeIngest(jobs), governance: fakeGovernance(calls), ...modules },
  });
  return { app, ctx: app.ctx, events, jobs, calls };
}

/** An in-process client connected to a fresh server acting for `human`. */
export async function connect(ctx, human, clientName = 'test-client') {
  const server = ctx.mcp.createServer({ human });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: clientName, version: '1.0.0' });
  await client.connect(b);
  return { client, server, close: async () => { await client.close(); await server.close(); } };
}

export async function call(client, name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, text: r.content?.map((c) => c.text).join('\n') || '' };
}
