/**
 * sqlite.mjs — the default Store driver, on Node's built-in `node:sqlite`
 * (unflagged since Node 22.13). No native module to compile, which is what lets
 * `npx almagest serve` work on a fresh laptop.
 *
 * Documents are stored whole as JSON with the id and creation time pulled out
 * into columns. Filters use json_extract, so a new entity field needs no
 * migration. That trade suits the volumes here — thousands of proposals, not
 * millions — and keeps this driver and memory.mjs semantically identical.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { COLLECTIONS, eventMatches, NotFoundError } from './index.mjs';

const FILTER_META = new Set(['limit', 'order']);
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;

function encode(v) {
  // json_extract returns SQL values: booleans become 0/1, so compare against those.
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

function whereFor(filter = {}) {
  const clauses = [];
  const params = [];
  for (const [k, v] of Object.entries(filter)) {
    if (FILTER_META.has(k) || v === undefined) continue;
    if (!FIELD.test(k)) throw new Error(`invalid filter field "${k}"`);
    if (Array.isArray(v)) {
      if (v.length === 0) { clauses.push('0'); continue; }
      clauses.push(`json_extract(data, '$.${k}') IN (${v.map(() => '?').join(',')})`);
      params.push(...v.map(encode));
    } else if (v === null) {
      clauses.push(`json_extract(data, '$.${k}') IS NULL`);
    } else {
      clauses.push(`json_extract(data, '$.${k}') = ?`);
      params.push(encode(v));
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

export function createSqliteStore({ file }) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');

  for (const name of COLLECTIONS) {
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, ts TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
    CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (ns, key));
    CREATE INDEX IF NOT EXISTS jobs_status ON jobs (json_extract(data, '$.status'));
    CREATE INDEX IF NOT EXISTS proposals_branch ON proposals (json_extract(data, '$.branch'));
  `);

  const parse = (row) => (row ? JSON.parse(row.data) : null);

  function collection(name) {
    const insert = db.prepare(`INSERT INTO ${name} (id, data) VALUES (?, ?)`);
    const select = db.prepare(`SELECT data FROM ${name} WHERE id = ?`);
    const write = db.prepare(`UPDATE ${name} SET data = ? WHERE id = ?`);

    return {
      async create(doc) {
        if (!doc?.id) throw new Error(`${name}: document needs an id`);
        insert.run(doc.id, JSON.stringify(doc));
        return structuredClone(doc);
      },
      async get(id) {
        return parse(select.get(id));
      },
      async update(id, patch) {
        const cur = parse(select.get(id));
        if (!cur) throw new NotFoundError(name, id);
        const next = { ...cur, ...patch, id };
        write.run(JSON.stringify(next), id);
        return next;
      },
      async list(filter = {}) {
        const { sql, params } = whereFor(filter);
        const order = filter.order === 'desc' ? 'DESC' : 'ASC';
        const limit = filter.limit ? ` LIMIT ${Number(filter.limit) | 0}` : '';
        return db.prepare(`SELECT data FROM ${name} ${sql} ORDER BY id ${order}${limit}`).all(...params).map(parse);
      },
    };
  }

  const jobs = collection('jobs');
  const proposals = collection('proposals');
  const decisions = collection('decisions');

  const claimNext = db.prepare(
    `SELECT data FROM jobs WHERE json_extract(data, '$.status') = 'queued' ORDER BY id ASC LIMIT 1`,
  );
  const writeJob = db.prepare('UPDATE jobs SET data = ? WHERE id = ?');

  return {
    driver: 'sqlite',
    db,
    jobs: {
      enqueue: jobs.create,
      get: jobs.get,
      update: jobs.update,
      list: jobs.list,
      async claim(workerId) {
        // BEGIN IMMEDIATE takes the write lock up front, so two processes on one
        // database file cannot both claim the same job.
        db.exec('BEGIN IMMEDIATE');
        try {
          const cur = parse(claimNext.get());
          if (!cur) { db.exec('COMMIT'); return null; }
          const next = { ...cur, status: 'running', workerId, startedAt: new Date().toISOString(), attempts: (cur.attempts || 0) + 1 };
          writeJob.run(JSON.stringify(next), cur.id);
          db.exec('COMMIT');
          return next;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
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
      async append(evt) {
        db.prepare('INSERT INTO events (id, ts, data) VALUES (?, ?, ?)').run(evt.id, evt.ts, JSON.stringify(evt));
        return evt;
      },
      async query(q = {}) {
        const clauses = [];
        const params = [];
        if (q.since) { clauses.push('ts >= ?'); params.push(q.since); }
        if (q.until) { clauses.push('ts < ?'); params.push(q.until); }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        const rows = db.prepare(`SELECT data FROM events ${where} ORDER BY ts ASC, id ASC`).all(...params).map(parse);
        const hits = rows.filter((e) => eventMatches(e, { tool: q.tool, slug: q.slug }));
        return q.limit ? hits.slice(-q.limit) : hits;
      },
      async prune(beforeTs) {
        return Number(db.prepare('DELETE FROM events WHERE ts < ?').run(beforeTs).changes);
      },
    },
    audit: {
      async append(entry) {
        db.prepare('INSERT INTO audit (id, data) VALUES (?, ?)').run(entry.id, JSON.stringify(entry));
        return entry;
      },
      async list(filter = {}) {
        const { sql, params } = whereFor(filter);
        const order = filter.order === 'desc' ? 'DESC' : 'ASC';
        const limit = filter.limit ? ` LIMIT ${Number(filter.limit) | 0}` : '';
        return db.prepare(`SELECT data FROM audit ${sql} ORDER BY id ${order}${limit}`).all(...params).map(parse);
      },
    },
    kv: {
      async get(ns, key) {
        const row = db.prepare('SELECT value FROM kv WHERE ns = ? AND key = ?').get(ns, key);
        return row ? JSON.parse(row.value) : null;
      },
      async set(ns, key, value) {
        db.prepare('INSERT INTO kv (ns, key, value) VALUES (?, ?, ?) ON CONFLICT (ns, key) DO UPDATE SET value = excluded.value')
          .run(ns, key, JSON.stringify(value));
      },
      async delete(ns, key) {
        db.prepare('DELETE FROM kv WHERE ns = ? AND key = ?').run(ns, key);
      },
      async list(ns) {
        return db.prepare('SELECT key, value FROM kv WHERE ns = ? ORDER BY key').all(ns)
          .map((r) => ({ key: r.key, value: JSON.parse(r.value) }));
      },
    },
    async close() {
      db.close();
    },
  };
}
