/**
 * hints.mjs — pages worth fixing as canonical.
 *
 * The signal is mechanical and always shown with its numbers:
 *
 *   documents   distinct sources in brain/manifest.yaml whose `pages` include
 *               the slug (a source that was superseded or skipped does not count)
 *   backlinks   other pages that link to it (the shared parser computes them)
 *   hot         the page is among the most read, when telemetry is on
 *
 * A page is suggested when documents reach `min_sources` or backlinks reach
 * `min_backlinks`; for a hot page both thresholds are multiplied by
 * `hot_factor` and rounded up. A page that is already canonical, a `claim`
 * page and a template page (slug starting with `_`) are never suggested.
 *
 * A dismissal is remembered in the store with the document count at the time.
 * The page comes back only when its documents have grown to at least 1.5
 * times that number (and it still meets a threshold).
 *
 * suggest() and the counting helpers are pure; createHints() reads main.
 */
import { loadManifest } from '../../../tools/lib/config.mjs';
import { slugFromEntry } from '../../../tools/lib/canonical.mjs';
import { BASE } from '../core/config.mjs';
import { canonicalAt } from './canonical.mjs';

/** The defaults live with the other governance defaults (core/config.mjs). */
export const HINT_DEFAULTS = BASE.governance.canonical_hint;
/** A dismissed page returns when its document count is this many times what it was. */
export const REGROWTH = 1.5;
export const DISMISSED_NS = 'canonical-hints.dismissed';
const NOT_COUNTED = new Set(['superseded', 'skipped']);

const num = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== '' && v !== null ? Number(v) : fallback);

/** `governance.canonical_hint` with every default filled in and bad values replaced. */
export function hintSettings(configured = {}) {
  const c = configured && typeof configured === 'object' ? configured : {};
  return {
    enabled: c.enabled === undefined ? HINT_DEFAULTS.enabled : c.enabled !== false,
    minSources: num(c.min_sources, HINT_DEFAULTS.min_sources),
    minBacklinks: num(c.min_backlinks, HINT_DEFAULTS.min_backlinks),
    hotFactor: num(c.hot_factor, HINT_DEFAULTS.hot_factor),
  };
}

/** Manifest entries → Map<slug, number of distinct sources that name the page>. */
export function documentCounts(entries = []) {
  const seen = new Map();   // slug → Set of source keys
  entries.forEach((e, i) => {
    if (!e || NOT_COUNTED.has(String(e.status || ''))) return;
    const key = e.id || e.path || `entry-${i}`;
    for (const page of e.pages || []) {
      const slug = slugFromEntry(page);
      if (!slug) continue;
      if (!seen.has(slug)) seen.set(slug, new Set());
      seen.get(slug).add(key);
    }
  });
  return new Map([...seen].map(([slug, keys]) => [slug, keys.size]));
}

/**
 * @param {object} input
 * @param {Array}  input.pages        wiki pages as wiki-core loads them ({ slug, title, type, backlinks })
 * @param {Map<string, number>} input.documents   documentCounts()
 * @param {Set<string>} [input.locked]            the canonical set on main
 * @param {Set<string>} [input.hot]               hot slugs from telemetry
 * @param {Map<string, { documents: number }>} [input.dismissed]
 * @param {object} [input.settings]               hintSettings()
 * @returns {Array<{ slug, title, documents, backlinks, hot, tier }>}  most documents first, then most backlinks
 */
export function suggest({ pages = [], documents = new Map(), locked = new Set(), hot = new Set(), dismissed = new Map(), settings = hintSettings() }) {
  if (!settings.enabled) return [];
  const out = [];
  for (const page of pages) {
    const slug = page.slug;
    if (locked.has(slug) || page.type === 'claim' || String(slug).startsWith('_')) continue;
    const isHot = hot.has(slug);
    const factor = isHot ? settings.hotFactor : 1;
    const needSources = Math.ceil(settings.minSources * factor);
    const needBacklinks = Math.ceil(settings.minBacklinks * factor);
    const docs = documents.get(slug) || 0;
    const links = (page.backlinks || []).length;
    if (!(docs >= needSources || links >= needBacklinks)) continue;
    const before = dismissed.get(slug);
    if (before && !(docs >= Math.max(1, Number(before.documents || 0) * REGROWTH))) continue;
    out.push({ slug, title: page.title || slug, documents: docs, backlinks: links, hot: isHot, tier: page.tier || 'curated' });
  }
  return out.sort((a, b) => b.documents - a.documents || b.backlinks - a.backlinks || a.slug.localeCompare(b.slug));
}

/** Plain words for one suggestion's counts, in the order they are shown. */
export function hintWords(h) {
  const words = [];
  if (h.documents > 0) words.push(`${h.documents} ${h.documents === 1 ? 'document' : 'documents'} contributed to this page`);
  if (h.backlinks > 0) words.push(`${h.backlinks} other ${h.backlinks === 1 ? 'page links' : 'pages link'} here`);
  if (h.hot) words.push('among the most read pages');
  return words;
}

/**
 * The suggestions for the brain as it is on main.
 *
 * @param {object} ctx  the composition-root ctx (config, store, git, snapshot, demand, log)
 */
export function createHints(ctx) {
  const { config, store, git, log } = ctx;
  const ttlMs = 5000;
  let memo = null;

  const settings = () => hintSettings(config.governance?.canonical_hint);

  async function hotSet() {
    try { return new Set((await ctx.demand?.hot?.()) || []); }
    catch (err) { log?.debug('hot pages unavailable for the suggestions', { error: err.message }); return new Set(); }
  }

  async function dismissals() {
    const rows = await store.kv.list(DISMISSED_NS);
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  async function compute() {
    const s = settings();
    if (!s.enabled) return [];
    const snap = await ctx.snapshot.load();
    const manifest = loadManifest(snap.dir, config.v1.manifestPath);
    return suggest({
      pages: snap.pages,
      documents: documentCounts(manifest.entries),
      locked: await canonicalAt(git, config),
      hot: await hotSet(),
      dismissed: await dismissals(),
      settings: s,
    });
  }

  async function list({ fresh = false } = {}) {
    if (!fresh && memo && Date.now() - memo.at < ttlMs) return memo.items;
    const items = await compute();
    memo = { at: Date.now(), items };
    return items;
  }

  return {
    settings,
    list,
    /** How many pages are suggested; 0 when anything goes wrong, so a page never fails to draw because of it. */
    async count() {
      try { return (await list()).length; }
      catch (err) { log?.debug('could not count the canonical suggestions', { error: err.message }); return 0; }
    },
    /** Remember that a person turned the suggestion down, with the document count it had. Returns the record. */
    async dismiss(slug, actor) {
      const item = (await list({ fresh: true })).find((h) => h.slug === slug);
      if (!item) return null;
      const record = { slug, documents: item.documents, at: new Date().toISOString(), by: actor.id, display: actor.display || actor.id };
      await store.kv.set(DISMISSED_NS, slug, record);
      memo = null;
      return record;
    },
    forget() { memo = null; },
  };
}
