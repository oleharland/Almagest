/**
 * recipes.mjs — load, merge and check the declarative recipes.
 *
 * A recipe says, for one kind of MCP server, which call lists items and which
 * call fetches one, and how to map each result. The format is documented in
 * docs/v2/connectors.md → Recipe format; the short version:
 *
 *   resolve:  [{ tool, args, set: { name: <path> } }]   optional, run once per sync → {{vars.name}}
 *   list:     { tool | method | static, args, items, ref, version?, title?, commit?,
 *               next_cursor?, where?, items_regex?, max_pages? }
 *   fetch:    { tool | method, args, text?, title?, mime?, render, render_options? }
 *
 * Where a recipe comes from, in order:
 *   recipe: custom             → nothing; the connector's inline list/fetch is the recipe
 *   recipe: ./path/to/x.yaml   → that file, relative to the repo root
 *   recipe: <name>             → server/src/connectors/recipes/<name>.yaml
 * and any inline `list:` / `fetch:` / `resolve:` on the connector is merged on
 * top, so a shipped recipe whose tool name differs on your server is fixed in
 * config instead of forked. `<name>.draft.yaml` is never loaded by name — a
 * drafted recipe becomes live only when a human renames it after review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { deepMerge } from '../core/config.mjs';
import { parsePath } from './mapping.mjs';
import { RENDER_MODES } from './render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RECIPES_DIR = path.join(HERE, 'recipes');
export const METHODS = ['resources/list', 'resources/read'];

export function shippedRecipes(dir = RECIPES_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && !f.endsWith('.draft.yaml'))
    .map((f) => f.slice(0, -'.yaml'.length))
    .sort();
}

function readRecipeFile(file) {
  const doc = YAML.parse(fs.readFileSync(file, 'utf-8')) || {};
  if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file}: a recipe is a YAML mapping`);
  return doc;
}

/**
 * The effective recipe for a connector. Throws with every problem listed when
 * the result is not runnable.
 */
export function recipeFor(connector, { repoRoot, dir = RECIPES_DIR } = {}) {
  const name = String(connector.recipe || 'mcp-resources');
  let base = {};
  if (name === 'custom') {
    base = { name: 'custom' };
  } else if (/\.ya?ml$/.test(name)) {
    const file = path.resolve(repoRoot || process.cwd(), name);
    if (!fs.existsSync(file)) throw new Error(`connector "${connector.id}": recipe file ${name} not found`);
    base = readRecipeFile(file);
  } else {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`connector "${connector.id}": recipe "${name}" is not a recipe name`);
    const file = path.join(dir, `${name}.yaml`);
    if (!fs.existsSync(file)) {
      throw new Error(`connector "${connector.id}": no recipe "${name}" (shipped: ${shippedRecipes(dir).join(', ')}, or custom)`);
    }
    base = readRecipeFile(file);
  }
  const inline = {};
  for (const k of ['resolve', 'list', 'fetch']) if (connector[k] !== undefined) inline[k] = connector[k];
  const merged = deepMerge(base, inline);
  if (Array.isArray(inline.resolve)) merged.resolve = inline.resolve;
  merged.name = merged.name || name;
  validateRecipe(merged, connector.id);
  return merged;
}

function checkPath(problems, where, p) {
  if (p === undefined || p === null || p === '') return;
  if (typeof p !== 'string') { problems.push(`${where} must be a path string`); return; }
  if (p.includes('{{')) return;   // a template, checked when rendered
  try {
    for (const alt of p.split(/\s+\|\s+/)) parsePath(alt);
  } catch (err) {
    problems.push(`${where}: ${err.message}`);
  }
}

function checkCall(problems, where, call, { allowStatic = false, allowNone = false } = {}) {
  const sources = ['tool', 'method', ...(allowStatic ? ['static'] : [])].filter((k) => call[k] !== undefined);
  if (sources.length === 0 && !allowNone) problems.push(`${where} needs one of ${allowStatic ? 'tool | method | static' : 'tool | method'}`);
  if (sources.length > 1) problems.push(`${where} has more than one of tool / method / static`);
  if (call.method !== undefined && !METHODS.includes(call.method)) problems.push(`${where}.method must be one of ${METHODS.join(' | ')}`);
  if (call.args !== undefined && (typeof call.args !== 'object' || Array.isArray(call.args))) problems.push(`${where}.args must be a mapping`);
}

export function validateRecipe(recipe, connectorId = '?') {
  const problems = [];
  const list = recipe.list;
  const fetch = recipe.fetch;
  if (!list || typeof list !== 'object') problems.push('`list` is required');
  else {
    checkCall(problems, 'list', list, { allowStatic: true });
    if (!list.ref) problems.push('list.ref is required — the provider id of each item');
    for (const k of ['items', 'ref', 'version', 'title', 'commit', 'mime', 'next_cursor', 'has_more']) checkPath(problems, `list.${k}`, list[k]);
    for (const [i, w] of (list.where || []).entries()) {
      if (!w || (!w.path && !w.field)) problems.push(`list.where[${i}] needs a path or field`);
      if (w && !['equals', 'not', 'in', 'glob', 'not_glob'].some((op) => w[op] !== undefined)) problems.push(`list.where[${i}] needs equals | not | in | glob | not_glob`);
    }
    if (list.items_regex !== undefined) {
      try { new RegExp(list.items_regex, 'g'); } catch (err) { problems.push(`list.items_regex: ${err.message}`); }
    }
  }
  if (!fetch || typeof fetch !== 'object') problems.push('`fetch` is required (use `fetch: { text: <path into the list item> }` when the list already carries the content)');
  else {
    checkCall(problems, 'fetch', fetch, { allowNone: true });
    for (const k of ['text', 'title', 'mime']) checkPath(problems, `fetch.${k}`, fetch[k]);
    if (fetch.render !== undefined && !RENDER_MODES.includes(fetch.render)) problems.push(`fetch.render must be one of ${RENDER_MODES.join(' | ')}`);
  }
  for (const [i, step] of (recipe.resolve || []).entries()) {
    checkCall(problems, `resolve[${i}]`, step);
    if (!step.set || typeof step.set !== 'object') problems.push(`resolve[${i}].set is required`);
  }
  if (problems.length) throw new Error(`connector "${connectorId}": recipe "${recipe.name || '?'}" is invalid: ${problems.join('; ')}`);
  return recipe;
}
