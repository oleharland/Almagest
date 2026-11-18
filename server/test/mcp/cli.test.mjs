import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { makeTempRepo, rmrf, SERVICE_ROOT } from '../helpers.mjs';

const repos = [];
after(() => repos.forEach(rmrf));

describe('almagest mcp (real process, stdio)', () => {
  it('speaks MCP on stdout and nothing else, reading main of the given repo', async () => {
    const repo = makeTempRepo();
    repos.push(repo);
    const env = { ...process.env, ALMAGEST_LOG_LEVEL: 'debug' };
    delete env.ALMAGEST_TOKEN;
    delete env.ALMAGEST_TOKENS;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(SERVICE_ROOT, 'bin', 'almagest.mjs'), 'mcp', '--repo', repo],
      env,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (d) => { stderr += d; });
    const client = new Client({ name: 'claude-code', version: '1' });
    await client.connect(transport);
    try {
      const tools = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(tools.includes('ask') && tools.includes('submit_source'));
      const r = await client.callTool({ name: 'search', arguments: { query: 'B-1' } });
      assert.equal(r.structuredContent.results[0].slug, 'beta');
      assert.match(stderr, /mcp serving on stdio/, 'logs go to stderr');
    } finally {
      await client.close();
    }
  });
});
