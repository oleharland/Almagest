/**
 * init.mjs — draft a recipe for an MCP server nobody has written one for.
 *
 * `almagest connectors init <mcp>` connects, reads `tools/list` and
 * `resources/list`, and writes a recipe *draft* for a human to finish. It
 * never calls a tool: a server's tool list is the only thing read, so drafting
 * cannot change anything upstream. The draft is deliberately loud about what
 * it guessed — every guessed line carries `# TODO` — and it is saved as
 * `<name>.draft.yaml`, which the loader refuses by name. Promoting it is a
 * rename, and the rename is the review.
 *
 * Heuristics, in order of trust:
 *   1. resources present           → recommend `mcp-resources`; zero mapping needed
 *   2. list tool                   → name starts list / search / query / find
 *   3. fetch tool                  → name starts get / read / fetch / retrieve / view,
 *                                    preferring one that shares the list tool's noun
 *   4. argument roles from the tool's inputSchema property names
 */
import fs from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { RECIPES_DIR } from './recipes.mjs';

function shippedResourcesRecipe() {
  return YAML.parse(fs.readFileSync(path.join(RECIPES_DIR, 'mcp-resources.yaml'), 'utf-8'));
}

const LIST_RE = /^(list|search|query|find|browse)[_-]?/i;
const FETCH_RE = /^(get|read|fetch|retrieve|view|download|load)[_-]?/i;
const ROLE = {
  since: /^(since|updated_?(at|after|since)?|modified_?(after|since|time)?|changed_?since|after_date|from|start_date|created_?after)$/i,
  cursor: /^(cursor|page_?token|next_?(page_?)?token|after|starting_?after|offset_?token)$/i,
  limit: /^(limit|page_?size|per_?page|max_?results|first|count)$/i,
  id: /(^|_)(id|uri|url|key|path|slug|identifier)s?$/i,
};

/** `list_issues` → `issue`, `searchDocuments` → `document`. */
export function nounOf(name) {
  const stripped = String(name).replace(LIST_RE, '').replace(FETCH_RE, '').replace(/^[-_]+/, '');
  const snake = stripped.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
  return snake.replace(/ies$/, 'y').replace(/(ss)$/, '$1').replace(/s$/, '');
}

function props(tool) {
  return Object.keys(tool?.inputSchema?.properties || {});
}

function required(tool) {
  return new Set(tool?.inputSchema?.required || []);
}

function score(tool, re) {
  const n = tool.name;
  if (!re.test(n)) return -1;
  let s = 1;
  if (/^list/i.test(n) || /^get/i.test(n)) s += 2;
  if (/s$/.test(n) && re === LIST_RE) s += 1;
  if (/(create|update|delete|save|write|send|post|remove|archive|share)/i.test(n)) s -= 10;   // never a write tool
  return s;
}

/** Pick list/fetch candidates from a tools/list result. Exported for tests. */
export function pickTools(tools) {
  const lists = tools.filter((t) => score(t, LIST_RE) > 0).sort((a, b) => score(b, LIST_RE) - score(a, LIST_RE));
  const fetches = tools.filter((t) => score(t, FETCH_RE) > 0).sort((a, b) => score(b, FETCH_RE) - score(a, FETCH_RE));
  const list = lists[0] || null;
  const noun = list ? nounOf(list.name) : '';
  const fetch = fetches.find((t) => noun && nounOf(t.name) === noun) || fetches[0] || null;
  return { list, fetch, lists, fetches };
}

/** A recipe args block for a tool, with a role guessed per input property. */
export function draftArgs(tool, { forFetch = false } = {}) {
  const args = {};
  const req = required(tool);
  for (const p of props(tool)) {
    if (forFetch && ROLE.id.test(p) && (req.has(p) || !Object.keys(args).some((k) => args[k] === '{{item.ref}}'))) {
      args[p] = '{{item.ref}}';
    } else if (!forFetch && ROLE.since.test(p)) args[p] = '{{since}}';
    else if (!forFetch && ROLE.cursor.test(p)) args[p] = '{{cursor}}';
    else if (!forFetch && ROLE.limit.test(p)) args[p] = 50;
    else if (req.has(p)) args[p] = `{{select.${p}}}`;
  }
  return args;
}

/**
 * @param {object} o
 * @param {string} o.name        recipe name
 * @param {string} o.server      the mcp name/url it was drafted from
 * @param {Array}  o.tools       tools/list → tools
 * @param {Array}  [o.resources] resources/list → resources
 * @returns {{ yaml: string, recipe: object, suggestion: 'mcp-resources' | 'tools' | 'none' }}
 */
export function draftRecipe({ name, server, tools = [], resources = [], date = new Date().toISOString().slice(0, 10) }) {
  const { list, fetch, lists, fetches } = pickTools(tools);
  const head = [
    `# DRAFT recipe "${name}" — drafted by \`almagest connectors init\` from ${server} on ${date}.`,
    '# verified: no — every mapping below is a guess from tool names and input schemas.',
    '# Review it, run `almagest connectors test <connector-id>` against it, then rename',
    `# this file to ${name}.yaml. A *.draft.yaml is never loaded.`,
    '#',
    `# tools offered by the server (${tools.length}):`,
    ...tools.map((t) => `#   - ${t.name}${t.description ? ` — ${String(t.description).split('\n')[0].slice(0, 90)}` : ''}`),
    `# resources listed: ${resources.length}`,
  ];

  if (resources.length > 0) {
    const yaml = [
      ...head,
      '#',
      '# This server exposes MCP resources, so it needs no recipe at all:',
      '#',
      '#   sources:',
      '#     connectors:',
      `#       - id: ${name}`,
      `#         mcp: ${server}`,
      '#         recipe: mcp-resources',
      '#',
      '# The block below is a tools-based alternative, only if resources are not what you want.',
      '',
    ];
    const body = tools.length && list ? toolsRecipe(name, list, fetch) : { ...shippedResourcesRecipe(), name };
    return { yaml: yaml.join('\n') + YAML.stringify(body), recipe: body, suggestion: 'mcp-resources' };
  }

  if (!list) {
    const yaml = [...head, '#', '# No tool looks like a lister (list* / search* / query* / find*). Write `list:` by hand,', '# or use `list: { static: "{{select.refs}}" }` and name the items in config.', '', `name: ${name}`, 'list:', '  tool: TODO', '  ref: id', 'fetch:', '  tool: TODO', ''];
    return { yaml: yaml.join('\n'), recipe: null, suggestion: 'none' };
  }

  const recipe = toolsRecipe(name, list, fetch);
  const notes = [
    '#',
    `# list candidates: ${lists.map((t) => t.name).join(', ') || 'none'}`,
    `# fetch candidates: ${fetches.map((t) => t.name).join(', ') || 'none — the list item itself is rendered'}`,
    '',
  ];
  let yaml = [...head, ...notes].join('\n') + YAML.stringify(recipe);
  yaml = yaml
    .replace(/^(\s+items: .*)$/m, '$1   # TODO: path to the array of items in the list result')
    .replace(/^(\s+ref: .*)$/m, '$1   # TODO: the stable provider id')
    .replace(/^(\s+version: .*)$/m, '$1   # TODO: updatedAt / etag / revision — optional, only skips fetches')
    .replace(/^(\s+next_cursor: .*)$/m, '$1   # TODO: where the next-page token is, if any')
    .replace(/^(\s+render: .*)$/m, '$1   # markdown | json-to-markdown | transcript | rows');
  return { yaml, recipe, suggestion: 'tools' };
}

function toolsRecipe(name, list, fetch) {
  const noun = nounOf(list.name) || 'item';
  const listArgs = draftArgs(list);
  const recipe = {
    name,
    description: `Drafted from ${list.name}${fetch ? ` + ${fetch.name}` : ''}`,
    list: {
      tool: list.name,
      ...(Object.keys(listArgs).length ? { args: listArgs } : {}),
      items: `${noun}s[*] | items[*] | results[*] | data[*] | $[*]`,
      ref: 'id | uri | key | path',
      version: 'updatedAt | updated_at | modifiedTime | last_edited_time | etag',
      title: 'title | name | subject',
      ...(Object.values(listArgs).includes('{{cursor}}') ? { next_cursor: 'nextCursor | next_cursor | cursor | pageInfo.endCursor | next_page_token' } : {}),
    },
    fetch: fetch
      ? { tool: fetch.name, args: draftArgs(fetch, { forFetch: true }), render: 'json-to-markdown' }
      : { render: 'json-to-markdown' },
  };
  return recipe;
}
