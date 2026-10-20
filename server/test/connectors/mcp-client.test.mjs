import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { hasStaticAuth, missingEnv, resolveServer, toolResultValue } from '../../src/connectors/mcp-client.mjs';

// The two entries Almagest ships in .mcp.json, verbatim.
const MCP_JSON = {
  github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer ${GITHUB_TOKEN:-}' } },
  gitlab: { type: 'http', url: '${GITLAB_URL:-https://gitlab.com}/api/v4/mcp', headers: { 'PRIVATE-TOKEN': '${GITLAB_TOKEN:-}' } },
  legacy: { type: 'sse', url: 'https://legacy.example.com/sse' },
  local: { command: 'npx', args: ['-y', '@acme/mcp', '--root', '${ROOT:-/srv}'], env: { ACME_KEY: '${ACME_KEY}' } },
};

describe('.mcp.json resolution', () => {
  it('expands ${VAR} and ${VAR:-default} the way Claude Code does', () => {
    const gh = resolveServer('github', { mcpServers: MCP_JSON, env: { GITHUB_TOKEN: 'ghp_x' } });
    assert.equal(gh.type, 'http');
    assert.equal(gh.headers.Authorization, 'Bearer ghp_x');
    const gl = resolveServer('gitlab', { mcpServers: MCP_JSON, env: {} });
    assert.equal(gl.url, 'https://gitlab.com/api/v4/mcp');
    const self = resolveServer('gitlab', { mcpServers: MCP_JSON, env: { GITLAB_URL: 'https://git.acme.io' } });
    assert.equal(self.url, 'https://git.acme.io/api/v4/mcp');
  });

  it('picks the transport: http, sse, stdio', () => {
    assert.equal(resolveServer('legacy', { mcpServers: MCP_JSON }).type, 'sse');
    const local = resolveServer('local', { mcpServers: MCP_JSON, env: { ACME_KEY: 'k' }, cwd: '/repo' });
    assert.equal(local.type, 'stdio');
    assert.deepEqual(local.args, ['-y', '@acme/mcp', '--root', '/srv']);
    assert.deepEqual(local.env, { ACME_KEY: 'k' });
    assert.equal(local.cwd, '/repo');
  });

  it('accepts inline objects and bare urls', () => {
    const inline = resolveServer({ url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': '${K}' } }, { env: { K: 'v' } });
    assert.equal(inline.type, 'http');
    assert.equal(inline.key, 'https://mcp.example.com/mcp');
    assert.equal(resolveServer('https://mcp.notion.com/mcp').type, 'http');
  });

  it('labels a server for the record without any credential-bearing part', () => {
    assert.equal(resolveServer('github', { mcpServers: MCP_JSON }).label, 'github');
    const url = resolveServer({ url: 'https://mcp.acme.io/mcp?api_key=SECRET', headers: { Authorization: 'Bearer SECRET' } });
    assert.equal(url.label, 'https://mcp.acme.io/mcp');
    const stdio = resolveServer({ command: '/usr/local/bin/acme-mcp', args: ['--token', 'SECRET'], env: { K: 'SECRET' } });
    assert.equal(stdio.label, 'stdio:acme-mcp');
    assert.equal(resolveServer({ name: 'acme', command: 'x' }).label, 'acme');
    assert.notEqual(stdio.key, resolveServer({ command: '/usr/local/bin/acme-mcp', args: ['--token', 'SECRET'], env: { K: 'OTHER' } }).key, 'env differences are different servers');
  });

  it('reports a ${VAR} with no default and no value instead of hiding it', () => {
    assert.deepEqual(resolveServer('local', { mcpServers: MCP_JSON, env: {} }).missingEnv, ['ACME_KEY']);
    assert.deepEqual(missingEnv('${A:-} ${B}', {}), ['B']);
  });

  it('names the known servers when the key is unknown', () => {
    assert.throws(() => resolveServer('nope', { mcpServers: MCP_JSON }), /known: github, gitlab/);
    assert.throws(() => resolveServer({ type: 'weird' }), /cannot tell the transport/);
  });

  it('treats a non-empty credential header as static auth (no OAuth provider)', () => {
    assert.ok(hasStaticAuth({ headers: { Authorization: 'Bearer abc' } }));
    assert.ok(!hasStaticAuth({ headers: { Authorization: 'Bearer ' } }));
    assert.ok(hasStaticAuth({ headers: { 'PRIVATE-TOKEN': 'glpat' } }));
  });
});

describe('tool results', () => {
  it('prefers structuredContent, parses JSON text, keeps plain text', () => {
    assert.deepEqual(toolResultValue({ structuredContent: { a: 1 }, content: [] }), { a: 1 });
    assert.deepEqual(toolResultValue({ content: [{ type: 'text', text: '{"b":2}' }] }), { b: 2 });
    assert.equal(toolResultValue({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
  });

  it('takes an embedded text resource over the commentary beside it', () => {
    const v = toolResultValue({ content: [{ type: 'text', text: 'successfully downloaded' }, { type: 'resource', resource: { uri: 'x', text: '# Doc' } }] });
    assert.equal(v, '# Doc');
  });

  it('throws on isError', () => {
    assert.throws(() => toolResultValue({ isError: true, content: [{ type: 'text', text: 'boom' }] }), /boom/);
  });
});
