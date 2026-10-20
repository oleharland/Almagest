/**
 * execute.mjs — run a recipe against a connected MCP client.
 *
 *   resolveVars(client, recipe, vars)        → vars + { vars: { … } } from `resolve:` steps
 *   listItems(client, recipe, vars)          → { items, complete }
 *   fetchItem(client, recipe, item, vars)    → { body, title }
 *
 * No state, no files, no store — sync.mjs owns all of that. Everything here
 * is a pure function of (recipe, vars, what the server answered), which is
 * what lets the tests drive it against an in-memory server.
 */
import { DEFAULT_TIMEOUT_MS, toolResultValue } from './mcp-client.mjs';
import { mapField, matchesGlob, renderArgs, renderTemplate, select, selectAll, templateVars } from './mapping.mjs';
import { render } from './render.mjs';

export const DEFAULT_MAX_PAGES = 50;
export const DEFAULT_MAX_ITEMS = 1000;

/** One call: an MCP method, a tool, or (list only) a static list from config. */
export async function runCall(client, call, vars, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const args = renderArgs(call.args || {}, vars);
  const options = { timeout: timeoutMs };
  if (call.static !== undefined) {
    const v = renderTemplate(call.static, vars);
    return Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v];
  }
  if (call.method === 'resources/list') return client.listResources(args, options);
  if (call.method === 'resources/read') return client.readResource(args, options);
  if (call.tool) return toolResultValue(await client.callTool({ name: call.tool, arguments: args }, undefined, options));
  return undefined;
}

export async function resolveVars(client, recipe, vars, opts) {
  const resolved = { ...(vars.vars || {}) };
  for (const step of recipe.resolve || []) {
    const value = await runCall(client, step, { ...vars, vars: resolved }, opts);
    for (const [name, p] of Object.entries(step.set || {})) resolved[name] = mapField(p, value, { ...vars, vars: resolved });
  }
  return { ...vars, vars: resolved };
}

function rawItems(value, list) {
  if (list.items_regex && typeof value === 'string') {
    const re = new RegExp(list.items_regex, 'g');
    return [...value.matchAll(re)].map((m) => ({ ...(m.groups || {}), match: m[0] }));
  }
  if (list.items) return selectAll(value, list.items);
  if (Array.isArray(value)) return value;
  return [];
}

function passesWhere(raw, mapped, where, vars) {
  for (const w of where || []) {
    const v = w.field ? mapped[w.field] : select(raw, w.path);
    if (w.equals !== undefined && String(v) !== String(renderTemplate(w.equals, vars))) return false;
    if (w.not !== undefined && String(v) === String(renderTemplate(w.not, vars))) return false;
    if (w.in !== undefined) {
      const allowed = [].concat(renderTemplate(w.in, vars) ?? []).filter((x) => x !== '' && x != null);
      if (allowed.length && !allowed.map(String).includes(String(v))) return false;
    }
    if (w.glob !== undefined && !matchesGlob(v, renderTemplate(w.glob, vars))) return false;
    if (w.not_glob !== undefined) {
      const globs = [].concat(renderTemplate(w.not_glob, vars) ?? []).filter((g) => g !== '' && g != null);
      if (globs.length && matchesGlob(v, globs)) return false;
    }
  }
  return true;
}

/**
 * Lists every item, following `next_cursor` until it is empty or repeats.
 * `complete` is false when the listing was incremental (`{{since}}` was
 * passed) or capped — only a complete listing can say an item disappeared.
 */
export async function listItems(client, recipe, vars, { maxPages = DEFAULT_MAX_PAGES, maxItems = DEFAULT_MAX_ITEMS, firstPageOnly = false, ...opts } = {}) {
  const list = recipe.list;
  const items = [];
  const seen = new Set();
  let cursor;
  let capped = false;
  for (let page = 0; page < (list.max_pages || maxPages); page++) {
    const pageVars = { ...vars, cursor };
    const value = await runCall(client, list, pageVars, opts);
    for (const raw of rawItems(value, list)) {
      const mapped = {
        ref: mapField(list.ref, raw, pageVars),
        version: mapField(list.version, raw, pageVars),
        title: mapField(list.title, raw, pageVars),
        commit: mapField(list.commit, raw, pageVars),
        mime: mapField(list.mime, raw, pageVars),
      };
      if (mapped.ref === undefined || mapped.ref === null || mapped.ref === '' || typeof mapped.ref === 'object') continue;
      mapped.ref = String(mapped.ref);
      if (seen.has(mapped.ref)) continue;          // providers repeat items across page boundaries
      if (!passesWhere(raw, mapped, list.where, pageVars)) continue;
      seen.add(mapped.ref);
      items.push({
        ref: mapped.ref,
        version: mapped.version == null || typeof mapped.version === 'object' ? '' : String(mapped.version),
        title: mapped.title == null || typeof mapped.title === 'object' ? mapped.ref : String(mapped.title),
        commit: mapped.commit == null ? '' : String(mapped.commit),
        mime: mapped.mime == null ? '' : String(mapped.mime),
        raw,
      });
      if (items.length >= maxItems) { capped = true; break; }
    }
    if (capped || firstPageOnly || !list.next_cursor || list.static !== undefined) break;
    if (list.has_more && !select(value, list.has_more)) break;
    const next = select(value, list.next_cursor);
    if (next === undefined || next === null || next === '' || next === cursor) break;
    cursor = String(next);
    if (page === (list.max_pages || maxPages) - 1) capped = true;
  }
  const incremental = templateVars(list.args).has('since') && Boolean(vars.since);
  return { items, complete: !capped && !incremental && !firstPageOnly };
}

/** Fetch one item and render it to marked-up text. */
export async function fetchItem(client, recipe, item, vars, opts = {}) {
  const fetch = recipe.fetch;
  const itemVars = { ...vars, item: { ref: item.ref, version: item.version, title: item.title, commit: item.commit, raw: item.raw } };
  const hasCall = fetch.tool !== undefined || fetch.method !== undefined;
  const value = hasCall ? await runCall(client, fetch, itemVars, opts) : item.raw;
  const text = fetch.text ? (fetch.text.includes('[*]') ? selectAll(value, fetch.text) : select(value, fetch.text)) : value;
  const title = fetch.title ? select(value, fetch.title) : undefined;
  const mime = (fetch.mime ? select(value, fetch.mime) : undefined) || item.mime || undefined;
  const body = render(fetch.render || 'auto', text === undefined ? '' : text, fetch.render_options || {}, { mimeType: mime });
  return { body, title: title === undefined || typeof title === 'object' ? item.title : String(title) };
}
