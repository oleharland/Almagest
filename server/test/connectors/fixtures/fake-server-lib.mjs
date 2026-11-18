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
 *     repo: { commit, files: [{ path, sha, content }], full_name?, commits?, branches? },
 *     others: [{ full_name, files: [{ path, sha, content }] }]   (other repositories search_code can reach when the query has no `repo:` qualifier)
 *     fail: ['<doc id>'],
 *     unlisted: ['<doc id>']   (docs list_docs leaves out; lookup_docs and get_doc still reach them) }
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
  { name: 'lookup_docs', description: 'Docs whose title or body contains any word of the query (live-lookup tests)', inputSchema: { type: 'object', properties: { query: { type: 'string' }, scope: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'get_doc', description: 'Get one doc', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'get_transcript', description: 'Transcript segments of a doc', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'get_rows', description: 'Rows of a doc', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'delete_doc', description: 'A write tool init must never pick', inputSchema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'list_commits', description: 'github-shaped', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, sha: { type: 'string' }, perPage: { type: 'number' } }, required: ['owner', 'repo'] } },
  { name: 'get_repository_tree', description: 'github-shaped', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, tree_sha: { type: 'string' }, recursive: { type: 'boolean' } }, required: ['owner', 'repo'] } },
  { name: 'search_code', description: 'github-shaped: GitHub code search; `repo:owner/name` restricts it', inputSchema: { type: 'object', properties: { query: { type: 'string' }, perPage: { type: 'number' }, page: { type: 'number' } }, required: ['query'] } },
  { name: 'list_branches', description: 'github-shaped', inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, perPage: { type: 'number' }, page: { type: 'number' } }, required: ['owner', 'repo'] } },
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
        const all = (s.docs || []).filter((d) => !(s.unlisted || []).includes(d.id) && (!a.since || d.updatedAt > a.since));
        const start = a.cursor ? Number(a.cursor) : 0;
        const page = all.slice(start, start + size).map(({ id, title, updatedAt }) => ({ id, title, updatedAt }));
        return json({ docs: page, nextCursor: start + size < all.length ? String(start + size) : null });
      }
      case 'lookup_docs': {
        const words = String(a.query || '').toLowerCase().split(/\s+/).filter(Boolean);
        const hits = (s.docs || []).filter((d) => words.some((w) => `${d.title} ${d.body}`.toLowerCase().includes(w)));
        const size = a.limit || 100;
        return json({ results: hits.slice(0, size).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })) });
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
        // `repo.commits` is the REST shape the GitHub server passes through: { sha, commit: { message, author: { name, email, date } }, author: { login } }.
        if (s.repo.commits) return json(s.repo.commits.slice(0, a.perPage || 30));
        return json([{ sha: s.repo.commit }]);
      case 'list_branches':
        return json((s.repo.branches || []).slice(0, a.perPage || 30));
      case 'search_code': {
        // `{ total_count, incomplete_results, items: [{ name, path, sha, html_url, repository: { full_name } }] }`
        const query = String(a.query || '');
        const scope = [...query.matchAll(/\brepo:(\S+)/g)].map((m) => m[1]);
        const words = query.replace(/\brepo:\S+/g, ' ').replace(/[()]/g, ' ').split(/\s+/).filter((w) => w && !['OR', 'AND', 'NOT'].includes(w)).map((w) => w.toLowerCase());
        const repos = [{ full_name: s.repo.full_name || 'acme/docs', files: s.repo.files }, ...(s.others || [])].filter((r) => !scope.length || scope.includes(r.full_name));
        const items = repos.flatMap((r) => r.files
          .filter((f) => words.some((w) => `${f.path} ${f.content}`.toLowerCase().includes(w)))
          .map((f) => ({ name: f.path.split('/').pop(), path: f.path, sha: f.sha, html_url: `https://github.com/${r.full_name}/blob/main/${f.path}`, repository: { full_name: r.full_name } })));
        return json({ total_count: items.length, incomplete_results: false, items: items.slice(0, a.perPage || 30) });
      }
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
