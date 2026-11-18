/**
 * excerpt.mjs — the passage of a source a citation locator points at.
 *
 * Input is the text of a source file (usually a sidecar under
 * brain/raw/extracted/ with `=== page N ===` markers, or a connector snapshot
 * with `=== section: … ===` / `=== row n ===` / `=== t hh:mm:ss ===`); output
 * is a ~600-character passage for the reviewer to read next to the claim.
 *
 * Locator grammar (frozen, CLAUDE.md → Citations):
 *   §<section> · p.<n> · pp.<n>-<m> · row <n> · slide <n> · t <hh:mm:ss> · line <n>
 *
 * Pure: no I/O. When a locator cannot be found the result says so — the
 * reviewer is told to check by hand, never shown a guess as if it were the spot.
 */
import { tokens } from './claims.mjs';

export const EXCERPT_CHARS = 600;
const MARKER = /^===\s*(.+?)\s*===\s*$/;

/** `=== … ===` segments: [{ label, start, end, lines }] with 0-based line indexes. */
export function segments(text) {
  const lines = String(text).split('\n');
  const out = [];
  let cur = null;
  lines.forEach((line, i) => {
    const m = line.trim().match(MARKER);
    if (m) {
      if (cur) out.push(cur);
      cur = { label: m[1].trim(), start: i + 1, lines: [] };
      return;
    }
    if (cur) cur.lines.push(line);
  });
  if (cur) out.push(cur);
  return out.map((s) => ({ ...s, text: s.lines.join('\n').trim() }));
}

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

function seconds(hms) {
  const m = String(hms).match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function findMarker(segs, ...labels) {
  const want = labels.map(norm);
  return segs.find((s) => want.includes(norm(s.label))) || null;
}

function lineWindow(lines, from, to) {
  const a = Math.max(0, from);
  const b = Math.min(lines.length, to);
  return lines.slice(a, b).filter((l) => !MARKER.test(l.trim())).join('\n').trim();
}

/**
 * Cut `passage` to `max` characters around the part that best matches `hint`
 * (the claim text), so a long page shows the sentence the claim came from.
 */
export function focus(passage, hint = '', max = EXCERPT_CHARS) {
  const p = String(passage).trim();
  if (p.length <= max) return p;
  const want = new Set(tokens(hint));
  const parts = p.split(/(?<=[.!?])\s+|\n+/).filter(Boolean);
  let best = 0;
  let bestScore = -1;
  parts.forEach((s, i) => {
    const score = tokens(s).filter((t) => want.has(t)).length;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  let lo = best;
  let hi = best;
  let len = parts[best].length;
  while (true) {
    const canHi = hi + 1 < parts.length && len + parts[hi + 1].length + 1 <= max;
    const canLo = lo - 1 >= 0 && len + parts[lo - 1].length + 1 <= max;
    if (!canHi && !canLo) break;
    if (canHi) { hi++; len += parts[hi].length + 1; }
    if (canLo && len + parts[lo - 1].length + 1 <= max) { lo--; len += parts[lo].length + 1; }
  }
  let out = parts.slice(lo, hi + 1).join(' ');
  const cut = out.length > max;
  if (cut) out = out.slice(0, max - 1).trimEnd();
  return `${lo > 0 ? '… ' : ''}${out}${cut || hi < parts.length - 1 ? ' …' : ''}`;
}

/** `t 00:12:30` → the segment at that time, or the latest one starting before it. */
function byTime(segs, lines, target) {
  const want = seconds(target);
  if (want === null) return null;
  let best = null;
  for (const s of segs) {
    const m = s.label.match(/^t\s+(\d{1,2}:\d{2}:\d{2})$/i);
    const at = m ? seconds(m[1]) : null;
    if (at !== null && at <= want && (!best || at >= best.at)) best = { at, text: s.text };
  }
  if (best) return best.text;
  // Transcripts without markers: lines that start with a timestamp.
  let hit = -1;
  lines.forEach((line, i) => {
    const m = line.trim().match(/^\[?(\d{1,2}:\d{2}:\d{2})\]?/);
    if (m && seconds(m[1]) <= want) hit = i;
  });
  return hit >= 0 ? lineWindow(lines, hit, hit + 6) : null;
}

function bySection(segs, lines, name) {
  const want = norm(name.replace(/^§\s*/, ''));
  if (!want) return null;
  const marker = segs.find((s) => {
    const l = norm(s.label);
    return l === `section: ${want}` || l === `section:${want}` || l === want;
  });
  if (marker) return marker.text;
  // Markdown-ish headings inside the source.
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].trim().match(/^(#{1,6})\s+(.*)$/);
    if (!h) continue;
    const title = norm(h[2]);
    if (title === want || title.startsWith(`${want} `) || title.endsWith(` ${want}`)) {
      const level = h[1].length;
      let j = i + 1;
      while (j < lines.length) {
        const n = lines[j].trim().match(/^(#{1,6})\s+/);
        if ((n && n[1].length <= level) || MARKER.test(lines[j].trim())) break;
        j++;
      }
      return lineWindow(lines, i, j);
    }
  }
  // Last resort: the first line that names the section.
  const idx = lines.findIndex((l) => norm(l).includes(want) && !MARKER.test(l.trim()));
  if (idx < 0) return null;
  let end = idx + 1;
  while (end < lines.length && end < idx + 8 && !MARKER.test(lines[end].trim())) end++;
  return lineWindow(lines, idx, end);
}

/**
 * @param {string} text      full source text
 * @param {string} locator   e.g. `p.3`, `§Overview`, `t 00:12:30`
 * @param {object} [opts]
 * @param {string} [opts.hint]   claim text, to focus long passages
 * @param {number} [opts.max]
 * @returns {{ status: 'found' | 'not-found', passage: string, where: string }}
 */
export function locate(text, locator, { hint = '', max = EXCERPT_CHARS } = {}) {
  const src = String(text ?? '');
  const loc = String(locator ?? '').trim();
  const lines = src.split('\n');
  const segs = segments(src);
  let passage = null;
  let m;

  if ((m = loc.match(/^p\.(\d+)$/))) {
    passage = findMarker(segs, `page ${m[1]}`, `p.${m[1]}`)?.text ?? null;
    if (passage === null && segs.length === 0 && m[1] === '1') passage = src;   // single-page text without markers
  } else if ((m = loc.match(/^pp\.(\d+)-(\d+)$/))) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const parts = [];
    for (let n = a; n <= b && n - a < 50; n++) {
      const s = findMarker(segs, `page ${n}`);
      if (s) parts.push(s.text);
    }
    passage = parts.length ? parts.join('\n\n') : null;
  } else if (loc.startsWith('§')) {
    passage = bySection(segs, lines, loc);
  } else if ((m = loc.match(/^line (\d+)$/))) {
    const n = Number(m[1]);
    passage = n >= 1 && n <= lines.length ? lineWindow(lines, n - 3, n + 2) : null;
  } else if ((m = loc.match(/^row (\d+)$/))) {
    passage = findMarker(segs, `row ${m[1]}`)?.text ?? null;
    const n = Number(m[1]);
    if (passage === null && n >= 1 && n <= lines.length) passage = lineWindow(lines, n - 1, n);
  } else if ((m = loc.match(/^slide (\d+)$/))) {
    passage = findMarker(segs, `slide ${m[1]}`, `page ${m[1]}`)?.text ?? null;
  } else if ((m = loc.match(/^t (\d{1,2}:\d{2}:\d{2})$/))) {
    passage = byTime(segs, lines, m[1]);
  }

  if (passage === null || !passage.trim()) return { status: 'not-found', passage: '', where: loc };
  return { status: 'found', passage: focus(passage, hint, max), where: loc };
}

/** "p.3" → "page 3", for people. */
export function locatorWords(locator) {
  const loc = String(locator || '').trim();
  let m;
  if ((m = loc.match(/^p\.(\d+)$/))) return `page ${m[1]}`;
  if ((m = loc.match(/^pp\.(\d+)-(\d+)$/))) return `pages ${m[1]}–${m[2]}`;
  if (loc.startsWith('§')) return `section “${loc.slice(1).trim()}”`;
  if ((m = loc.match(/^t (.+)$/))) return `at ${m[1]}`;
  return loc;
}
