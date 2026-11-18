/**
 * store/index.mjs — the Store interface and driver selection.
 *
 * The store holds operational state only (jobs, proposals, decisions, events,
 * the governance audit log, connector cursors). Knowledge lives in git. If the
 * database is lost, the brain is intact; what is lost is the review queue and
 * the request history.
 *
 * Interface (every method async — see docs/v2/spec.md → Store interface):
 *
 *   jobs       enqueue(job) claim(workerId) update(id, patch) get(id) list(filter)
 *   proposals  create(p) update(id, patch) get(id) getByBranch(branch) list(filter)
 *   decisions  create(d) update(id, patch) get(id) listByProposal(id) list(filter)
 *   events     append(evt) query({ since, until, tool, slug, limit }) prune(beforeTs)
 *   audit      append(entry) list(filter)            — no update, no delete, ever
 *   kv         get(ns, key) set(ns, key, value) delete(ns, key) list(ns)
 *   close()
 *
 * `filter` is field equality on top-level fields, plus `limit` and
 * `order: 'asc' | 'desc'` (by id, which sorts by creation time). A filter value
 * that is an array matches any of its members.
 */
export const COLLECTIONS = ['jobs', 'proposals', 'decisions'];

const FILTER_META = new Set(['limit', 'order']);

export function matches(doc, filter = {}) {
  for (const [k, v] of Object.entries(filter)) {
    if (FILTER_META.has(k) || v === undefined) continue;
    if (Array.isArray(v) ? !v.includes(doc[k]) : doc[k] !== v) return false;
  }
  return true;
}

export function applyOrderLimit(docs, filter = {}) {
  const sorted = [...docs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (filter.order === 'desc') sorted.reverse();
  return filter.limit ? sorted.slice(0, filter.limit) : sorted;
}

export function eventMatches(evt, { since, until, tool, slug } = {}) {
  if (since && evt.ts < since) return false;
  if (until && evt.ts >= until) return false;
  if (tool && evt.tool !== tool) return false;
  if (slug && !(evt.results || []).some((r) => r.slug === slug) && !(evt.pagesRead || []).includes(slug)) return false;
  return true;
}

export class NotFoundError extends Error {
  constructor(what, id) {
    super(`${what} ${id} not found`);
    this.name = 'NotFoundError';
    this.status = 404;
  }
}

/**
 * @param {object} config  loadServiceConfig() result
 * @returns {Promise<Store>}
 */
export async function createStore(config) {
  const { driver } = config.service.store;
  switch (driver) {
    case 'memory': {
      const { createMemoryStore } = await import('./memory.mjs');
      return createMemoryStore();
    }
    case 'sqlite': {
      const { createSqliteStore } = await import('./sqlite.mjs');
      return createSqliteStore({ file: config.paths.store });
    }
    case 'postgres': {
      const { createPostgresStore } = await import('./postgres.mjs').catch(() => {
        throw new Error('store.driver: postgres needs server/src/core/store/postgres.mjs and the optional `pg` dependency');
      });
      return createPostgresStore({ url: config.service.store.url });
    }
    default:
      throw new Error(`unknown store driver "${driver}" — sqlite | postgres | memory`);
  }
}
