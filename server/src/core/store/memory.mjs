/**
 * memory.mjs — the in-memory Store driver. Tests use it; so can a throwaway
 * `almagest serve` with `store.driver: memory`. Same semantics as sqlite.mjs,
 * enforced by server/test/core/store.test.mjs running one suite over both.
 */
import { applyOrderLimit, eventMatches, matches, NotFoundError } from './index.mjs';

const clone = (v) => (v === undefined ? v : structuredClone(v));

function collection(name) {
  const docs = new Map();
  return {
    docs,
    async create(doc) {
      if (!doc?.id) throw new Error(`${name}: document needs an id`);
      if (docs.has(doc.id)) throw new Error(`${name}: ${doc.id} already exists`);
      docs.set(doc.id, clone(doc));
      return clone(doc);
    },
    async get(id) {
      return clone(docs.get(id)) ?? null;
    },
    async update(id, patch) {
      const cur = docs.get(id);
      if (!cur) throw new NotFoundError(name, id);
      const next = { ...cur, ...clone(patch), id };
      docs.set(id, next);
      return clone(next);
    },
    async list(filter = {}) {
      return applyOrderLimit([...docs.values()].filter((d) => matches(d, filter)), filter).map(clone);
    },
  };
}

export function createMemoryStore() {
  const jobs = collection('jobs');
  const proposals = collection('proposals');
  const decisions = collection('decisions');
  const events = [];
  const audit = [];
  const kv = new Map();

  return {
    driver: 'memory',
    jobs: {
      enqueue: jobs.create,
      get: jobs.get,
      update: jobs.update,
      list: jobs.list,
      async claim(workerId) {
        const next = applyOrderLimit([...jobs.docs.values()].filter((j) => j.status === 'queued'))[0];
        if (!next) return null;
        return jobs.update(next.id, { status: 'running', workerId, startedAt: new Date().toISOString(), attempts: (next.attempts || 0) + 1 });
      },
    },
    proposals: {
      create: proposals.create,
      get: proposals.get,
      update: proposals.update,
      list: proposals.list,
      async getByBranch(branch) {
        return (await proposals.list({ branch, order: 'desc', limit: 1 }))[0] ?? null;
      },
    },
    decisions: {
      create: decisions.create,
      get: decisions.get,
      update: decisions.update,
      list: decisions.list,
      async listByProposal(proposalId) {
        return decisions.list({ proposalId });
      },
    },
    events: {
      async append(evt) { events.push(clone(evt)); return clone(evt); },
      async query(q = {}) {
        const hits = events.filter((e) => eventMatches(e, q));
        return (q.limit ? hits.slice(-q.limit) : hits).map(clone);
      },
      async prune(beforeTs) {
        const keep = events.filter((e) => e.ts >= beforeTs);
        const removed = events.length - keep.length;
        events.splice(0, events.length, ...keep);
        return removed;
      },
    },
    audit: {
      async append(entry) { audit.push(clone(entry)); return clone(entry); },
      async list(filter = {}) { return applyOrderLimit(audit.filter((a) => matches(a, filter)), filter).map(clone); },
    },
    kv: {
      async get(ns, key) { return clone(kv.get(`${ns}\0${key}`)) ?? null; },
      async set(ns, key, value) { kv.set(`${ns}\0${key}`, clone(value)); },
      async delete(ns, key) { kv.delete(`${ns}\0${key}`); },
      async list(ns) {
        return [...kv.entries()]
          .filter(([k]) => k.startsWith(`${ns}\0`))
          .map(([k, value]) => ({ key: k.slice(ns.length + 1), value: clone(value) }));
      },
    },
    async close() {},
  };
}
