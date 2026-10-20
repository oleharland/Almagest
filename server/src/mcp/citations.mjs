/**
 * citations.mjs — turn a page's `[source: id, locator]` into something a
 * reader can check: the committed text the locator points into, the marker
 * line to look for, and the passage itself.
 *
 * Reads only from the snapshot directory (main's commit), never the checkout.
 * Locator grammar is CLAUDE.md's; sidecar markers are the ones ingest writes
 * (`=== page N ===`, `=== row N ===`, `=== slide N ===`, `=== t hh:mm:ss ===`,
 * `=== section: … ===`).
 */
import fs from 'node:fs';
import path from 'node:path';

import { findCitations } from '../../../tools/lib/wiki-core.mjs';

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|ya?ml|html?|xml|rst|adoc|org|vtt|srt)$/i;
const MARKER = /^===\s.*\s===$/;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** The file a citation should be verified against: the text sidecar for binaries, the file itself for text. */
export function verifyPathFor(source, manifest) {
  if (!source) return '';
  const entry = (source.id && manifest?.byId?.get(source.id)) || (source.path && manifest?.byPath?.get(source.path)) || null;
  if (source.path && TEXT_EXT.test(source.path)) return source.path;
  if (entry?.extracted && entry.extracted !== 'none') return entry.extracted;
  return source.path || entry?.path || '';
}

/** `p.3` → `=== page 3 ===`, etc. Returns '' for a locator that has no marker form (`line N`). */
export function markerFor(locator) {
  const l = String(locator).trim();
  let m;
  if ((m = l.match(/^p\.(\d+)$/))) return `=== page ${m[1]} ===`;
  if ((m = l.match(/^pp\.(\d+)-\d+$/))) return `=== page ${m[1]} ===`;
  if ((m = l.match(/^row (\d+)$/))) return `=== row ${m[1]} ===`;
  if ((m = l.match(/^slide (\d+)$/))) return `=== slide ${m[1]} ===`;
  if ((m = l.match(/^t (\d{1,2}:\d{2}:\d{2})$/))) return `=== t ${m[1]} ===`;
  if ((m = l.match(/^§(.+)$/))) return `=== section: ${m[1].trim()} ===`;
  return '';
}

function untilNextMarker(lines, from) {
  const out = [];
  for (let i = from; i < lines.length; i++) {
    if (MARKER.test(lines[i].trim())) break;
    out.push(lines[i]);
  }
  return out;
}

/**
 * Find the passage a locator lands on inside `text`.
 * @returns {{ found: boolean, excerpt: string, line: number }}
 */
export function locate(text, locator, maxChars = 400) {
  const lines = String(text).split('\n');
  const l = String(locator).trim();
  const clip = (s) => (s.length > maxChars ? s.slice(0, maxChars).trimEnd() + '…' : s);
  let m;

  if ((m = l.match(/^line (\d+)$/))) {
    const n = Number(m[1]);
    return n >= 1 && n <= lines.length ? { found: true, excerpt: clip(lines[n - 1].trim()), line: n } : { found: false, excerpt: '', line: 0 };
  }

  const range = l.match(/^pp\.(\d+)-(\d+)$/);
  const marker = markerFor(l);
  if (marker) {
    const idx = lines.findIndex((x) => x.trim().toLowerCase() === marker.toLowerCase());
    if (idx >= 0) {
      let body = untilNextMarker(lines, idx + 1);
      if (range) {
        const last = Number(range[2]);
        body = [];
        for (let i = idx + 1; i < lines.length; i++) {
          const pm = lines[i].trim().match(/^=== page (\d+) ===$/);
          if (pm && Number(pm[1]) > last) break;
          body.push(lines[i]);
        }
      }
      return { found: true, excerpt: clip(body.join('\n').trim()), line: idx + 1 };
    }
  }

  // §Section in a plain-text source: a markdown heading with that name.
  if ((m = l.match(/^§(.+)$/))) {
    const want = m[1].trim().toLowerCase();
    const idx = lines.findIndex((x) => {
      const h = x.trim().match(/^(#{1,6})\s+(.*)$/);
      return h && h[2].replace(/\s*#+\s*$/, '').trim().toLowerCase() === want;
    });
    if (idx >= 0) {
      const level = lines[idx].trim().match(/^#+/)[0].length;
      const body = [];
      for (let i = idx + 1; i < lines.length; i++) {
        const h = lines[i].trim().match(/^(#{1,6})\s/);
        if (h && h[1].length <= level) break;
        body.push(lines[i]);
      }
      return { found: true, excerpt: clip(body.join('\n').trim()), line: idx + 1 };
    }
  }
  return { found: false, excerpt: '', line: 0 };
}

function readInside(dir, rel, cache) {
  if (!rel) return null;
  if (cache.has(rel)) return cache.get(rel);
  const abs = path.resolve(dir, rel);
  let text = null;
  if (abs.startsWith(path.resolve(dir) + path.sep)) {
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= MAX_FILE_BYTES) text = fs.readFileSync(abs, 'utf-8');
    } catch { /* missing → null */ }
  }
  cache.set(rel, text);
  return text;
}

/**
 * Every citation on a page, parsed with wiki-core's `findCitations`, each with
 * its source resolved through the page's `sources` and a `verify` hint.
 */
export function resolveCitations(page, { dir, manifest, excerptChars = 400, withExcerpts = true } = {}) {
  const cache = new Map();
  const byId = new Map(page.sources.filter((s) => s.id).map((s) => [s.id, s]));
  return findCitations(page.body).map((c) => {
    const out = { raw: c.raw, line: c.line, ok: c.ok, id: c.id, locator: c.locator || '', date: c.date || '' };
    if (!c.ok) return { ...out, problem: c.reason };
    if (c.id === 'unknown') return { ...out, problem: 'unsourced — the page marks this claim [source: unknown]' };
    const source = byId.get(c.id);
    if (!source) return { ...out, problem: `id "${c.id}" is not in this page's sources (CITE-002)` };
    const entry = manifest?.byId?.get(c.id) || manifest?.byPath?.get(source.path) || null;
    const verifyPath = verifyPathFor(source, manifest);
    const verify = { path: verifyPath, locator: c.locator, marker: markerFor(c.locator) || null };
    const expected = entry ? (entry.extracted && verifyPath === entry.extracted ? entry.extractedSha256 : entry.sha256) : '';
    if (expected && source.sha256 && expected !== source.sha256) {
      verify.stale = 'the source changed since this page was written (CITE-005) — do not quote the locator as current';
    }
    if (withExcerpts) {
      const text = readInside(dir, verifyPath, cache);
      if (text == null) verify.note = 'source text is not in the repository (binary original without a committed sidecar?)';
      else {
        const hit = locate(text, c.locator, excerptChars);
        if (hit.found) { verify.excerpt = hit.excerpt; verify.atLine = hit.line; }
        else verify.note = 'locator not found in the source text';
      }
    }
    return { ...out, source: { id: source.id, title: source.title, path: source.path }, verify };
  });
}
