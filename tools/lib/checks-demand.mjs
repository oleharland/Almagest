/**
 * checks-demand.mjs — the two checks `tools/audit.mjs --demand <file>` adds.
 *
 *   DEMAND-001  a hot page whose `last_verified` is older than
 *               `telemetry.stale_after_days_hot` (default 30), or never verified
 *   DEMAND-002  a hot page with `confidence: low | unknown`
 *
 * "Hot" is not decided here. The service computes it from the request log and
 * exports `.almagest/demand.tsv` (aggregates only — slug, score, rank, hot);
 * this file trusts that column and nothing else. Without `--demand` none of
 * this runs and the audit is exactly v1.
 *
 * Severity comes from `brain.config.yaml` → `audit.severity` like every other
 * ID; an ID the config does not list is a **warning**, so a v1 config that
 * predates these checks never starts failing builds because someone passed a
 * flag.
 *
 * Plain ESM, builtins only — the same constraint as the rest of tools/lib.
 * Spec: docs/v2/telemetry.md, docs/audit.md → Demand.
 */
import fs from 'node:fs';

export const DEMAND_IDS = ['DEMAND-001', 'DEMAND-002'];
export const DEMAND_CATEGORY = { key: 'demand', emoji: '🔥', label: 'Demand', prefixes: ['DEMAND-'] };
export const DEFAULT_STALE_AFTER_DAYS_HOT = 30;

const HEADER = ['slug', 'score', 'rank', 'hot'];
const LOW_CONFIDENCE = new Set(['low', 'unknown']);
const TRUE = new Set(['true', '1', 'yes']);
const FALSE = new Set(['false', '0', 'no']);

/**
 * Parse a demand TSV. Throws with the file and line on anything malformed —
 * the caller turns that into exit 2, because a demand file that cannot be read
 * must not quietly mean "nothing is hot".
 *
 * @returns {{ file, rows: Map<slug, { score, rank, hot }>, population: number }}
 */
export function loadDemand(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    throw new Error(`--demand: cannot read ${file} (${err.code || err.message})`);
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const head = (lines[0] || '').split('\t').map((c) => c.trim());
  if (HEADER.some((h, i) => head[i] !== h)) {
    throw new Error(`--demand: ${file} line 1 must be the header "${HEADER.join('\\t')}" (got "${lines[0] || ''}")`);
  }

  const rows = new Map();
  lines.slice(1).forEach((line, i) => {
    if (!line.trim()) return;
    const n = i + 2;
    const [slug, score, rank, hot] = line.split('\t').map((c) => (c ?? '').trim());
    const where = `${file} line ${n}`;
    if (!slug) throw new Error(`--demand: ${where} has no slug`);
    if (score === undefined || score === '' || !Number.isFinite(Number(score))) throw new Error(`--demand: ${where} score "${score ?? ''}" is not a number`);
    if (!/^\d+$/.test(rank ?? '')) throw new Error(`--demand: ${where} rank "${rank ?? ''}" is not a whole number`);
    const h = String(hot ?? '').toLowerCase();
    if (!TRUE.has(h) && !FALSE.has(h)) throw new Error(`--demand: ${where} hot "${hot ?? ''}" must be true or false`);
    if (rows.has(slug)) throw new Error(`--demand: ${where} repeats slug "${slug}"`);
    rows.set(slug, { score: Number(score), rank: Number(rank), hot: TRUE.has(h) });
  });
  return { file, rows, population: rows.size };
}

/** Same precedence as checks.mjs (warnings list first), with warning as the fallback instead of error. */
function severityOf(id, config) {
  if (config.severityWarnings?.has(id)) return 'warning';
  if (config.severityErrors?.has(id)) return 'error';
  return 'warning';
}

function staleAfterDaysHot(config) {
  const v = config.raw?.telemetry?.stale_after_days_hot;
  if (v === undefined || v === null || v === '') return DEFAULT_STALE_AFTER_DAYS_HOT;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`telemetry.stale_after_days_hot must be a non-negative number (got ${JSON.stringify(v)})`);
  return n;
}

function parseDay(stamp) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stamp || '')) return null;
  const d = new Date(`${stamp}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object} input
 * @param {object[]} input.pages    loadWiki() pages
 * @param {object}   input.config   tools/lib/config.mjs loadConfig() result
 * @param {object}   input.demand   loadDemand() result
 * @param {Date}     input.today
 * @returns {object[]} findings, in the shape checks.mjs produces
 */
export function checkDemand({ pages, config, demand, today }) {
  const threshold = staleAfterDaysHot(config);
  const out = [];
  const add = (id, page, message, hint) => out.push({
    id, severity: severityOf(id, config), page: page.id, file: page.relFile, line: null, count: 1, message, hint,
  });

  for (const page of pages) {
    const d = demand.rows.get(page.id) ?? demand.rows.get(page.slug);
    if (!d?.hot) continue;
    const hot = `hot page (score ${d.score}, rank ${d.rank})`;

    const verified = parseDay(page.lastVerified);
    if (!page.lastVerified) {
      add('DEMAND-001', page, `${hot} has never been verified`, 're-verify it against its sources and set `last_verified` — readers rely on this page');
    } else if (!verified) {
      add('DEMAND-001', page, `${hot} — \`last_verified: ${page.lastVerified}\` is not an ISO date`, 'set `last_verified` to the date it was last checked (YYYY-MM-DD)');
    } else {
      const age = Math.floor((today.getTime() - verified.getTime()) / 86_400_000);
      if (age > threshold) {
        add('DEMAND-001', page,
          `${hot} last verified ${page.lastVerified} — ${age} days, ${age - threshold} past the ${threshold}-day hot threshold`,
          're-verify it against its sources and update `last_verified`, or see `almagest reverify`');
      }
    }

    if (LOW_CONFIDENCE.has(page.confidence)) {
      add('DEMAND-002', page, `${hot} has \`confidence: ${page.confidence}\``,
        'corroborate it with a stronger source or route it to its owner — a hot page should not rest on weak evidence');
    }
  }

  out.sort((a, b) => a.id.localeCompare(b.id) || (a.page ?? '').localeCompare(b.page ?? ''));
  return out;
}
