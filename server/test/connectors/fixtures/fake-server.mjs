#!/usr/bin/env node
/**
 * fake-server.mjs — the fake MCP server over stdio, so tests exercise the
 * real StdioClientTransport path end to end.
 *
 *   FAKE_MCP_STATE=<state.json>   re-read on every request — tests edit it between syncs
 *   FAKE_MCP_LOG=<calls.jsonl>    one line per tool call / method, appended
 */
import fs from 'node:fs';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { buildFakeServer } from './fake-server-lib.mjs';

const stateFile = process.env.FAKE_MCP_STATE;
const logFile = process.env.FAKE_MCP_LOG;

const server = buildFakeServer(
  () => JSON.parse(fs.readFileSync(stateFile, 'utf-8')),
  (call) => { if (logFile) fs.appendFileSync(logFile, JSON.stringify(call) + '\n'); },
);
await server.connect(new StdioServerTransport());
