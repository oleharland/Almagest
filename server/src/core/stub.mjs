/**
 * stub.mjs — Phase 0 placeholders. Each module's index.mjs starts as a stub
 * whose methods throw, so the composition root runs end to end before any
 * workstream lands. Delete a module's use of this once it is implemented.
 */
const SURFACE = {
  ingest: ['enqueue', 'get', 'list', 'start', 'stop'],
  connectors: ['list', 'sync', 'snapshotPath'],
  governance: [
    'listProposals', 'getProposal', 'createFromJob', 'approve', 'reject', 'rejectPage',
    'requestChanges', 'resolveDecision', 'createConfirmation',
  ],
  mcp: ['serveStdio', 'handleHttp'],
  telemetry: ['record', 'gaps', 'reverifyQueue', 'explain'],
};

const LIFECYCLE = new Set(['start', 'stop']);

export function notImplemented(module, ctx) {
  const service = { stub: true };
  for (const name of SURFACE[module] || []) {
    service[name] = LIFECYCLE.has(name)
      ? async () => {}
      : async () => { throw new Error(`${module}.${name} is not implemented yet (Phase 0 stub)`); };
  }
  if (module === 'telemetry') {
    service.record = () => {};
    ctx.demand = { async get(slugs) { return new Map(slugs.map((s) => [s, { score: 0, rank: 0, hot: false }])); }, async hot() { return []; } };
  }
  return service;
}

export { SURFACE };
