/**
 * brain.mjs — the read side every tool shares: main's snapshot, the search
 * index over it, the manifest and the answer rules, all rebuilt together
 * whenever the snapshot sha moves and never in between.
 */
import { loadManifest } from '../../../tools/lib/config.mjs';

import { answerRules } from './rules.mjs';
import { buildIndex, search as searchIndex } from './search.mjs';

export function createBrain(ctx, cfg) {
  let built = null;
  let lastLocalCheck = 0;
  // A remote deployment follows `<remote>/main` via fetch (interval + webhook);
  // re-pinning to the local `main` ref in between would move it backwards.
  const followLocal = !ctx.config.service.git.remote && cfg.local_refresh_seconds > 0;

  async function snapshot() {
    if (followLocal && Date.now() - lastLocalCheck >= cfg.local_refresh_seconds * 1000) {
      lastLocalCheck = Date.now();
      try { await ctx.snapshot.refresh(); }
      catch (err) { ctx.log.warn('snapshot refresh failed', { error: err.message }); }
    }
    return ctx.snapshot.load();
  }

  /** Index + manifest + rules for the current snapshot sha. */
  async function current() {
    const snap = await snapshot();
    if (built && built.sha === snap.sha) return built;
    // A source's title is written on whichever page cited it with one; share it with the rest.
    const sourceTitles = new Map();
    for (const p of snap.pages) for (const s of p.sources) if (s.id && s.title && !sourceTitles.has(s.id)) sourceTitles.set(s.id, s.title);
    built = {
      sha: snap.sha,
      sourceTitles,
      snap,
      index: buildIndex(snap.pages, snap.sha),
      manifest: loadManifest(snap.dir, ctx.config.v1.manifestPath),
      rules: answerRules(snap.dir),
    };
    ctx.log.debug('mcp index built', { sha: snap.sha.slice(0, 7), pages: snap.pages.length });
    return built;
  }

  async function search(query, options = {}) {
    const b = await current();
    return {
      sha: b.sha,
      ...searchIndex(b.index, query, {
        limit: cfg.search.limit,
        minScore: cfg.search.min_score,
        minCoverage: cfg.search.min_coverage,
        ...options,
      }),
    };
  }

  /** Slug, prefixed id, alias or exact title → page, or null. */
  async function resolvePage(ref) {
    const b = await current();
    const want = String(ref).trim().replace(/^\[\[|\]\]$/g, '').replace(/^almagest:\/\/page\//, '');
    if (b.snap.byId.has(want)) return b.snap.byId.get(want);
    const lower = want.toLowerCase();
    return b.snap.pages.find((p) => p.slug === want)
      || b.snap.pages.find((p) => p.aliases.some((a) => a.toLowerCase() === lower) || p.title.toLowerCase() === lower)
      || null;
  }

  return { current, search, resolvePage };
}
