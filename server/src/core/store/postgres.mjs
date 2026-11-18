/**
 * postgres.mjs — the Store driver for `store.driver: postgres` (the
 * enterprise profile default). Same interface and semantics as sqlite.mjs,
 * enforced by server/test/core/store-postgres.test.mjs running the shared
 * conformance suite against a real database.
 *
 * Shape mirrors sqlite.mjs on purpose: one table per collection, the document
 * whole in a JSONB `data` column, the id (and for events the timestamp) pulled
 * out into columns. Filters compare `data->'field'` against a JSONB parameter,
 * so `{ hot: true }` matches the boolean `true` and `{ attempts: 2 }` the
 * number 2 — typed equality, no string coercion.
 *
 * Ids and timestamps are TEXT COLLATE "C": byte order, which is the order the
 * memory and sqlite drivers sort in. A locale collation would order
 * `job_0…` / `job_a…` differently and break "oldest first".
 *
 * The schema is created on first connect, idempotently, under an advisory
 * lock so two service processes starting at once cannot race the DDL.
 *
 * `pg` is an optionalDependency and is imported only here, only when this
 * driver is selected.
 */
import { COLLECTIONS, NotFoundError } from './index.mjs';

const FILTER_META = new Set(['limit', 'order']);
const FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const SCHEMA_LOCK = 0x616c6d61;   // 'alma'

async function loadPg() {
  try {
    const mod = await import('pg');
    return mod.default ?? mod;
  } catch {
    throw new Error('store.driver: postgres needs the optional `pg` dependency — run `npm install` in server/');
  }
}

/** WHERE clause over `data` for a filter object. `$n` numbering starts after `offset`. */
function whereFor(filter = {}, offset = 0) {
  const clauses = [];
  const params = [];
  for (const [k, v] of Object.entries(filter)) {
    if (FILTER_META.has(k) || v === undefined) continue;
    if (!FIELD.test(k)) throw new Error(`invalid filter field "${k}"`);
    if (Array.isArray(v)) {
      if (v.length === 0) { clauses.push('FALSE'); continue; }
      params.push(v.map((x) => JSON.stringify(x)));
      clauses.push(`data->'${k}' = ANY($${offset + params.length}::jsonb[])`);
    } else if (v === null) {
      // sqlite's json_extract IS NULL: absent or explicitly null.
      clauses.push(`(data->'${k}' IS NULL OR data->'${k}' = 'null'::jsonb)`);
    } else {
      params.push(JSON.stringify(v));
      clauses.push(`data->'${k}' = $${offset + params.length}::jsonb`);
    }
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

function orderLimit(filter = {}) {
  const order = filter.order === 'desc' ? 'DESC' : 'ASC';
  const limit = filter.limit ? ` LIMIT ${Number(filter.limit) | 0}` : '';
  return ` ORDER BY id ${order}${limit}`;
}

function ddl() {
  const stmts = [];
  for (const name of COLLECTIONS) {
    stmts.push(`CREATE TABLE IF NOT EXISTS ${name} (id TEXT COLLATE "C" PRIMARY KEY, data JSONB NOT NULL)`);
  }
  stmts.push(
    'CREATE TABLE IF NOT EXISTS events (id TEXT COLLATE "C" PRIMARY KEY, ts TEXT COLLATE "C" NOT NULL, data JSONB NOT NULL)',
    'CREATE INDEX IF NOT EXISTS events_ts ON events (ts)',
    'CREATE TABLE IF NOT EXISTS audit (id TEXT COLLATE "C" PRIMARY KEY, data JSONB NOT NULL)',
    'CREATE TABLE IF NOT EXISTS kv (ns TEXT COLLATE "C" NOT NULL, key TEXT COLLATE "C" NOT NULL, value JSONB NOT NULL, PRIMARY KEY (ns, key))',
    "CREATE INDEX IF NOT EXISTS jobs_status ON jobs ((data->>'status'), id)",
    "CREATE INDEX IF NOT EXISTS proposals_branch ON proposals ((data->>'branch'))",
    "CREATE INDEX IF NOT EXISTS decisions_proposal ON decisions ((data->>'proposalId'))",
  );
  return stmts;
}

/**
 * @param {object} options
 * @param {string} options.url        postgres://… connection string
 * @param {string} [options.schema]   a schema to create and use instead of `public` (tests, or several brains on one database)
 * @param {number} [options.max]      pool size, default 10
 * @param {object} [options.pool]     an existing pg.Pool-compatible object (advanced)
 * @returns {Promise<Store>}
 */
export async function createPostgresStore({ url, schema = '', max = 10, pool: given } = {}) {
  if (!given && !url) throw new Error('store.driver: postgres needs service.store.url (e.g. ${DATABASE_URL})');
  if (schema && !SCHEMA_NAME.test(schema)) throw new Error(`invalid postgres schema name "${schema}"`);

  const pool = given || new (await loadPg()).Pool({
    connectionString: url,
    max,
    ...(schema ? { options: `-c search_path=${schema}` } : {}),
  });
  // An idle client erroring (server restart) must not crash the process; the
  // pool replaces it and the next query reconnects.
  pool.on?.('error', () => {});

  const query = (text, params) => pool.query(text, params);

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  try {
    await tx(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock($1)', [SCHEMA_LOCK]);
      if (schema) await c.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      for (const stmt of ddl()) await c.query(stmt);
    });
  } catch (err) {
    if (!given) await pool.end().catch(() => {});
    throw err;
  }

  const rowsData = (res) => res.rows.map((r) => r.data);

  function collection(name) {
    return {
      async create(doc) {
        if (!doc?.id) throw new Error(`${name}: document needs an id`);
        try {
          await query(`INSERT INTO ${name} (id, data) VALUES ($1, $2::jsonb)`, [doc.id, JSON.stringify(doc)]);
        } catch (err) {
          if (err.code === '23505') throw new Error(`${name}: ${doc.id} already exists`);
          throw err;
        }
        return structuredClone(doc);
      },
      async get(id) {
        const res = await query(`SELECT data FROM ${name} WHERE id = $1`, [id]);
        return res.rows[0]?.data ?? null;
      },
      async update(id, patch) {
        // Read-modify-write under a row lock: the same `{ ...cur, ...patch, id }`
        // the other drivers do, including a patch key set to undefined dropping
        // the field (JSON has no undefined), which jsonb `||` would not do.
        return tx(async (c) => {
          const res = await c.query(`SELECT data FROM ${name} WHERE id = $1 FOR UPDATE`, [id]);
          const cur = res.rows[0]?.data;
          if (!cur) throw new NotFoundError(name, id);
          const next = { ...cur, ...patch, id };
          await c.query(`UPDATE ${name} SET data = $1::jsonb WHERE id = $2`, [JSON.stringify(next), id]);
          return JSON.parse(JSON.stringify(next));
        });
      },
      async list(filter = {}) {
        const { sql, params } = whereFor(filter);
        return rowsData(await query(`SELECT data FROM ${name} ${sql}${orderLimit(filter)}`, params));
      },
    };
  }

  const jobs = collection('jobs');
  const proposals = collection('proposals');
  const decisions = collection('decisions');

  return {
    driver: 'postgres',
    pool,
    jobs: {
      enqueue: jobs.create,
      get: jobs.get,
      update: jobs.update,
      list: jobs.list,
      async claim(workerId) {
        // SKIP LOCKED: concurrent workers each take a different queued row
        // instead of queueing behind one another's lock, and never the same row.
        return tx(async (c) => {
          const res = await c.query(
            "SELECT data FROM jobs WHERE data->>'status' = 'queued' ORDER BY id ASC LIMIT 1 FOR UPDATE SKIP LOCKED",
          );
          const cur = res.rows[0]?.data;
          if (!cur) return null;
          const next = { ...cur, status: 'running', workerId, startedAt: new Date().toISOString(), attempts: (cur.attempts || 0) + 1 };
          await c.query('UPDATE jobs SET data = $1::jsonb WHERE id = $2', [JSON.stringify(next), cur.id]);
          return next;
        });
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
        await query('INSERT INTO events (id, ts, data) VALUES ($1, $2, $3::jsonb)', [evt.id, evt.ts, JSON.stringify(evt)]);
        return evt;
      },
      async query(q = {}) {
        const clauses = [];
        const params = [];
        const p = (v) => { params.push(v); return `$${params.length}`; };
        if (q.since) clauses.push(`ts >= ${p(q.since)}`);
        if (q.until) clauses.push(`ts < ${p(q.until)}`);
        if (q.tool) clauses.push(`data->>'tool' = ${p(q.tool)}`);
        if (q.slug) {
          const s = p(q.slug);
          clauses.push(`(data->'pagesRead' ? ${s} OR data->'results' @> jsonb_build_array(jsonb_build_object('slug', ${s}::text)))`);
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        if (q.limit) {
          // The latest `limit` hits, returned oldest-first — sqlite's slice(-limit).
          const res = await query(`SELECT data FROM events ${where} ORDER BY ts DESC, id DESC LIMIT ${Number(q.limit) | 0}`, params);
          return rowsData(res).reverse();
        }
        return rowsData(await query(`SELECT data FROM events ${where} ORDER BY ts ASC, id ASC`, params));
      },
      async prune(beforeTs) {
        return (await query('DELETE FROM events WHERE ts < $1', [beforeTs])).rowCount;
      },
    },
    audit: {
      async append(entry) {
        await query('INSERT INTO audit (id, data) VALUES ($1, $2::jsonb)', [entry.id, JSON.stringify(entry)]);
        return entry;
      },
      async list(filter = {}) {
        const { sql, params } = whereFor(filter);
        return rowsData(await query(`SELECT data FROM audit ${sql}${orderLimit(filter)}`, params));
      },
    },
    kv: {
      async get(ns, key) {
        const res = await query('SELECT value FROM kv WHERE ns = $1 AND key = $2', [ns, key]);
        return res.rows[0]?.value ?? null;
      },
      async set(ns, key, value) {
        await query(
          'INSERT INTO kv (ns, key, value) VALUES ($1, $2, $3::jsonb) ON CONFLICT (ns, key) DO UPDATE SET value = EXCLUDED.value',
          [ns, key, JSON.stringify(value)],
        );
      },
      async delete(ns, key) {
        await query('DELETE FROM kv WHERE ns = $1 AND key = $2', [ns, key]);
      },
      async list(ns) {
        const res = await query('SELECT key, value FROM kv WHERE ns = $1 ORDER BY key', [ns]);
        return res.rows.map((r) => ({ key: r.key, value: r.value }));
      },
    },
    async close() {
      if (!given) await pool.end();
    },
  };
}
