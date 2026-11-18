/**
 * canonical.mjs — the one definition of "the canonical set".
 *
 * A page is canonical when its slug is in `canonical_pages` in
 * brain.config.yaml, or when its frontmatter says `tier: canonical`. Every
 * caller that needs the set (the audit, the ingest runner's guard, the merge
 * and its checks, the proposal builder, the suggestions list) builds it with
 * `canonicalSet`, so the two sources can never be read differently in two
 * places.
 *
 * Where the tiers come from is the caller's business: the audit has the pages
 * on disk, the service reads `main` out of git (server/src/governance/
 * canonical.mjs). Both hand `canonicalSet` a list of [slug, tier] pairs.
 *
 * Plain Node plus `yaml`, like config.mjs: the hooks and the audit import this
 * without the app.
 */
import YAML from 'yaml';

export const TIERS = ['evidence', 'curated', 'canonical'];

/** `[[beta]]`, `wiki/beta.md`, `beta.md` and `beta` all name the page `beta`. */
export function slugFromEntry(entry) {
  return String(entry).trim().replace(/^\[\[|\]\]$/g, '').replace(/^.*\//, '').replace(/\.md$/, '');
}

/** The frontmatter block of a page's text, or null when it has none. */
function frontmatterBlock(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * The frontmatter `tier` of a page's text, lower-cased, or '' when there is
 * none or the frontmatter does not parse. Parsed as YAML, so `tier: "canonical"`
 * and `tier: canonical # note` read the same.
 */
export function tierOfText(text) {
  const block = frontmatterBlock(text);
  if (block === null) return '';
  try {
    const data = YAML.parse(block);
    const tier = data && typeof data === 'object' ? data.tier : '';
    return tier == null ? '' : String(tier).trim().toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The canonical set: slugs in `configPages`, plus every slug whose tier in
 * `tiers` is `canonical`.
 *
 * @param {object} [input]
 * @param {Iterable<string>} [input.configPages]            brain.config.yaml → canonical_pages
 * @param {Iterable<[string, string]>|Map<string,string>} [input.tiers]   [slug, tier] pairs, from the pages
 * @returns {Set<string>}
 */
export function canonicalSet({ configPages = [], tiers = [] } = {}) {
  const out = new Set();
  for (const entry of configPages) {
    const slug = slugFromEntry(entry);
    if (slug) out.add(slug);
  }
  for (const [slug, tier] of tiers) {
    if (String(tier ?? '').trim().toLowerCase() === 'canonical') out.add(String(slug));
  }
  return out;
}

/** The canonical set of pages the wiki loader already read (the audit's view). */
export function canonicalSetOfPages(pages, configPages = []) {
  return canonicalSet({ configPages, tiers: pages.map((p) => [p.slug, p.tier]) });
}

/**
 * The page's text with its `tier:` line set to `tier`, and nothing else
 * changed: every other byte stays. Returns null when the frontmatter has no
 * single top-level `tier:` line to edit (so the caller refuses instead of
 * guessing).
 */
export function withTier(text, tier) {
  if (!TIERS.includes(tier)) throw new Error(`unknown tier "${tier}"`);
  const src = String(text ?? '');
  const open = /^﻿?---[ \t]*\r?\n/.exec(src);
  if (!open) return null;
  const lines = src.slice(open[0].length).split(/(?<=\n)/);
  let end = -1;
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^---[ \t]*\r?\n?$/.test(lines[i])) { end = i; break; }
    if (/^tier[ \t]*:/.test(lines[i])) {
      if (at !== -1) return null;
      at = i;
    }
  }
  if (end === -1 || at === -1) return null;
  // A value that goes on over the next line (a block scalar) is not one line to edit.
  if (at + 1 < end && /^[ \t]+\S/.test(lines[at + 1])) return null;
  const eol = /\r?\n$/.exec(lines[at])?.[0] ?? '';
  lines[at] = `tier: ${tier}${eol}`;
  return open[0] + lines.join('');
}

/**
 * Do `a` and `b` differ in nothing but the `tier:` line of their frontmatter?
 * True also when they are identical. The merge uses this to prove that a tier
 * proposal is exactly one line.
 */
export function differOnlyInTier(a, b) {
  const x = withTier(a, 'evidence');
  const y = withTier(b, 'evidence');
  return x !== null && y !== null && x === y;
}
