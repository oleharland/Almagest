/**
 * fake-server-lib.mjs — an MCP server built with the SDK's low-level Server,
 * exposing both tools and resources, whose "upstream" is a JSON state object
 * the test can change between syncs.
 *
 *   buildFakeServer(getState, onCall) → Server   (connect it to any transport)
 *
 * State shape:
 *   { docs: [{ id, title, updatedAt, body, segments?, rows? }],
 *     resources: [{ uri, name, mimeType, text? , blob? }],
 *     pageSize: 2,
 *     repo: { commit, files: [{ path, sha, content }] },
 *     fail: ['<doc id>'] }
 *
 * No zod: the low-level Server takes plain JSON Schema, so the fixture adds no
 * dependency the server package does not already have.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const TOOLS = [
  { name: 'list_docs', description: 'List docs changed since a time', inputSchema: { type: 'object', properties: { since: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'get_doc', description: 'Get one doc', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'get_transcript', description: 'Transcript segments of a doc', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'get_rows', description: 'Rows of a doc', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'delete_doc', description: 'A write tool init must never pick', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'list_commits', description: 'github-shaped', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, sha: { type: 'string' }, perPage: { type: 'number' } }, required: ['owner', 'repo'] } },
  { name: 'get_repository_tree', description: 'github-shaped', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, tree_sha: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['owner', 'repo'] } },
  { name: 'get_file_contents', description: 'github-shaped', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, path: { type: 'string' }, ref: { type: 'string' } }, required: ['owner', 'repo', 'path'] } },
];

const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

export function buildFakeServer(getState, onCall = () => {}) {
  const server = new Server({ name: 'fake', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const s = getState();
    const { name, arguments: a = {} } = req.params;
    onCall({ tool: name, args: a });
    const doc = (id) => (s.docs || []).find((d) => d.id === id);
    if ((s.fail || []).includes(a.id)) return { isError: true, content: [{ type: 'text', text: `upstream failure for ${a.id}` }] };
    switch (name) {
      case 'list_docs': {
        const size = a.limit || s.pageSize || 100;
        const all = (s.docs || []).filter((d) => !a.since || d.updatedAt > a.since);
        const start = a.cursor ? Number(a.cursor) : 0;
        const page = all.slice(start, start + size).map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
        return json({ docs: page, nextCursor: start + size < all.length ? String(start + size) : null });
      }
      case 'get_doc': {
        const d = doc(a.id);
        if (!d) return { isError: true, content: [{ type: 'text', text: 'not found' }] };
        return json({ id: d.id, title: d.title, updatedAt: d.updatedAt, owner: 'ops', body: d.body });
      }
      case 'get_transcript':
        return { content: [{ type: 'text', text: 'structured' }], structuredContent: { segments: doc(a.id)?.segments || [] } };
      case 'get_rows':
        return json({ rows: doc(a.id)?.rows || [] });
      case 'list_commits':
        return json([{ sha: s.repo.commit }]);
      case 'get_repository_tree':
        if (a.tree_sha !== s.repo.commit) return { isError: true, content: [{ type: 'text', text: 'unknown tree' }] };
        return json({ sha: s.repo.commit, tree: [{ path: 'docs', type: 'tree', sha: 't1' }, ...s.repo.files.map((f) => ({ path: f.path, type: 'blob', sha: f.sha }))] });
      case 'get_file_contents': {
        const f = s.repo.files.find((x) => x.path === a.path);
        return {
          content: [
            { type: 'text', text: `successfully downloaded text file (SHA: ${f.sha})` },
            { type: 'resource', resource: { uri: `repo://${a.repo}/${f.path}`, mimeType: 'text/plain', text: f.content } },
          ],
        };
      }
      default:
        return { isError: true, content: [{ type: 'text', text: `unknown tool ${name}` }] };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (req) => {
    const s = getState();
    onCall({ method: 'resources/list', args: req.params || {} });
    const size = s.pageSize || 100;
    const start = req.params?.cursor ? Number(req.params.cursor) : 0;
    const all = s.resources || [];
    const resources = all.slice(start, start + size).map(({ uri, name, mimeType }) => ({ uri, name, mimeType }));
    return { resources, ...(start + size < all.length ? { nextCursor: String(start + size) } : {}) };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const s = getState();
    onCall({ method: 'resources/read', args: req.params });
    const r = (s.resources || []).find((x) => x.uri === req.params.uri);
    if (!r) throw new Error(`no resource ${req.params.uri}`);
    return { contents: [r.blob ? { uri: r.uri, mimeType: r.mimeType, blob: r.blob } : { uri: r.uri, mimeType: r.mimeType, text: r.text }] };
  });

  return server;
}
