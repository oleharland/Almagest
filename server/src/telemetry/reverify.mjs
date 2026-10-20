/**
 * reverify.mjs — which hot pages are due a human re-check, most urgent first.
 * Pure: takes the ranked demand and main's pages, returns the queue.
 *
 * A hot page is due when its `last_verified` is older than
 * `telemetry.stale_after_days_hot` (default 30 — a third of the 90-day tier
 * threshold STALE-001 uses), when it was never verified, or when its
 * `confidence` is `low` or `unknown`. These are the same two conditions the
 * audit reports as DEMAND-001 and DEMAND-002 when run with `--demand`.
 *
 * Priority = score × max(overdue_days, 1): a page many people read that is a
 * month overdue outranks a page a few people read that is a year overdue only
 * when its score is more than twelve times higher. The number is in the
 * output, so the order is never a mystery.
 */
import { DAY_MS, round } from './score.mjs';

export const LOW_CONFIDENCE = new Set(['low', 'unknown']);

function parseDay(stamp) {
  if (!stamp || !/^\d{4}-\d{2}-\d{2}/.test(stamp)) return null;
  const d = new Date(`${stamp.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {object} input
 * @param {Array<{slug, score, rank, hot}>} input.entries   ranked demand
 * @param {object[]} input.pages     loadWiki() pages from main
 * @param {number}   input.now       epoch ms
 * @param {number}   [input.staleAfterDays]
 * @returns {Array<{ slug, title, score, rank, lastVerified, overdueDays, confidence, tier, reason, reasons, priority }>}
 */
export function buildReverifyQueue({ entries, pages, now, staleAfterDays = 30 }) {
  const byKey = new Map();
  for (const p of pages || []) {
    if (!byKey.has(p.slug)) byKey.set(p.slug, p);
    byKey.set(p.id, p);
  }

  const queue = [];
  for (const e of entries || []) {
    if (!e.hot) continue;
    const page = byKey.get(e.slug);
    if (!page) continue;                       // hot in the event log, gone from main

    const reasons = [];
    const lastVerified = page.lastVerified || '';
    const verified = parseDay(lastVerified);
    let overdueDays;
    if (verified) {
      overdueDays = Math.floor((now - verified.getTime()) / DAY_MS) - staleAfterDays;
      if (overdueDays > 0) reasons.push(`last verified ${lastVerified} — ${overdueDays} days past the ${staleAfterDays}-day hot threshold`);
    } else {
      const created = parseDay(page.dateCreated);
      overdueDays = created ? Math.floor((now - created.getTime()) / DAY_MS) - staleAfterDays : staleAfterDays;
      overdueDays = Math.max(overdueDays, 1);
      reasons.push(lastVerified ? `last_verified "${lastVerified}" is not an ISO date` : 'never verified');
    }
    if (LOW_CONFIDENCE.has(page.confidence)) reasons.push(`confidence: ${page.confidence}`);
    if (reasons.length === 0) continue;

    queue.push({
      slug: e.slug,
      title: page.title,
      score: e.score,
      rank: e.rank,
      lastVerified: lastVerified || null,
      overdueDays,
      confidence: page.confidence || null,
      tier: page.tier,
      reason: reasons.join('; '),
      reasons,
      priority: round(e.score * Math.max(overdueDays, 1), 2),
    });
  }
  queue.sort((a, b) => b.priority - a.priority || b.score - a.score || (a.slug < b.slug ? -1 : 1));
  return queue;
}
