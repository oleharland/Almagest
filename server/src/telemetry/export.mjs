/**
 * export.mjs — `.almagest/demand.tsv`, the file `tools/audit.mjs --demand`
 * reads. Aggregates only: slug, score, rank, hot. Never query text, never an
 * actor, never an event — the file can be handed to CI without a privacy
 * review, and it is gitignored anyway (`.almagest/`).
 *
 * Format (frozen — tools/lib/checks-demand.mjs parses it):
 *
 *   slug	score	rank	hot
 *   grid-connection	12.41	1	true
 *
 * Rows are pages with a score above zero, in rank order. Scores carry two
 * decimals so a recompute that moves nothing material does not rewrite the
 * file (rule 6, write-if-changed).
 */
import fs from 'node:fs';
import path from 'node:path';

export const DEMAND_TSV_HEADER = 'slug\tscore\trank\thot';

export function renderDemandTsv(entries) {
  const rows = (entries || [])
    .filter((e) => e.score > 0)
    .sort((a, b) => a.rank - b.rank)
    .map((e) => [String(e.slug).replace(/\s+/g, '-'), e.score.toFixed(2), e.rank, e.hot ? 'true' : 'false'].join('\t'));
  return [DEMAND_TSV_HEADER, ...rows].join('\n') + '\n';
}

/** Writes only when the bytes differ. Returns true when it wrote. Atomic: temp file + rename. */
export function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file, 'utf-8') === content) return false;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
  return true;
}
