/**
 * helpers.mjs — connector-test scaffolding on top of ../helpers.mjs.
 *
 *   memoryConnect(state, calls)  an options.connect for createConnectors that links an
 *                                in-process fake server over InMemoryTransport
 *   stdioServer(dir, state)      { mcp, setState, calls } — the fake as a real stdio child
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { buildFakeServer } from './fixtures/fake-server-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FAKE_SERVER = path.join(HERE, 'fixtures', 'fake-server.mjs');

export function memoryConnect(state, calls = []) {
  return async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = buildFakeServer(() => state.current, (c) => calls.push(c));
    await server.connect(serverSide);
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(clientSide);
    return { client, close: async () => { await client.close(); await server.close(); } };
  };
}

export function stdioServer(dir, initial) {
  const stateFile = path.join(dir, 'fake-state.json');
  const logFile = path.join(dir, 'fake-calls.jsonl');
  fs.writeFileSync(stateFile, JSON.stringify(initial));
  return {
    mcp: { command: process.execPath, args: [FAKE_SERVER], env: { FAKE_MCP_STATE: stateFile, FAKE_MCP_LOG: logFile } },
    setState: (s) => fs.writeFileSync(stateFile, JSON.stringify(s)),
    calls: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
  };
}

/** Write a manifest entry for each ref onto main, as a merged ingest would. */
export function manifestYaml(refs, extra = {}) {
  const lines = ['version: 1', '', 'sources:'];
  for (const r of refs) {
    lines.push(
      `  - id: "${r.id}"`, '    kind: connector', `    connector: ${r.connector}`, `    server: "${r.server}"`,
      `    ref: "${r.ref}"`, `    version: "${r.version}"`, `    path: ${r.path}`, `    sha256: ${r.sha256}`,
      `    extracted: ${r.path}`, `    extracted_sha256: ${r.sha256}`, `    bytes: ${r.bytes}`,
      '    first_ingested: 2026-01-01', '    last_ingested: 2026-01-01', '    pages: []', `    status: ${extra[r.id]?.status || 'ingested'}`,
    );
  }
  return lines.join('\n') + '\n';
}
