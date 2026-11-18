/**
 * learnings.mjs — what a learning is, read from a page, and what the service
 * remembers when a person turns one down.
 *
 * A learning is a `claim` page with `origin: self`, a `## Basis` of wikilinks,
 * and no inline citations (agent/rules/wiki.md). Three places need to read
 * one the same way: the runner, which refuses a synthesize run that wrote a
 * bad one; the proposal, which shows each learning's Basis as links; and the
 * memory below, which keeps the Basis set of a learning that was turned down.
 *
 * Pages are parsed through safeFrontmatter and the shared wiki-core helpers,
 * never through gray-matter directly.
 */
import crypto from 'node:crypto';

import matter from 'gray-matter';

import { asString, normalizeSources, resolveTarget, safeFrontmatter, sectionLines } from '../../../tools/lib/wiki-core.mjs';

const parseFrontmatter = safeFrontmatter(matter);

const count = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : fallback);

/** `config.synthesis` with every value checked, so no caller reads a raw string or a negative number. */
export function synthesisSettings(config) {
  const c = config.synthesis || {};
  return {
    enabled: c.enabled === true,
    minChangedPages: count(c.min_changed_pages, 5),
    maxRunsPerDay: count(c.max_runs_per_day, 1),
    maxClaims: count(c.max_claims, 5),
    schedule: String(c.schedule || '').trim(),
  };
}

/** Store namespace for learnings a person turned down. Key: hash of the sorted Basis slugs. */
export const REJECTED_NS = 'synthesis.rejected';

export const sha256Text = (text) => crypto.createHash('sha256').update(String(text)).digest('hex');

/**
 * What the checks need from one page's text. Throws when the front matter
 * cannot be read as YAML (the caller reports it).
 */
export function readPage(text) {
  const parsed = parseFrontmatter(text);
  const data = parsed.data || {};
  return {
    data,
    body: parsed.content,
    title: asString(data.title),
    type: asString(data.type),
    tier: asString(data.tier),
    origin: asString(data.origin) || 'source',
    aliases: Array.isArray(data.aliases) ? data.aliases.map(String) : [],
    sources: normalizeSources(data.sources),
  };
}

/**
 * The targets of the `## Basis` bullets, as the page wrote them (a bullet
 * that is not a wikilink adds nothing; the audit reports it as CITE-006).
 */
export function basisTargets(body) {
  const out = [];
  for (const line of sectionLines(body, 'Basis')) {
    const bullet = line.trim().match(/^(?:[-*+]|\d+[.)])\s+\[\[([^\]|#]+)/);
    if (bullet) out.push(bullet[1].trim());
  }
  return out;
}

/**
 * The Basis of a page as slugs of pages that exist (`known`: the page ids on
 * main), sorted and without repeats. `missing` lists targets that name no page.
 */
export function basisOf(body, known) {
  const slugs = new Set();
  const missing = [];
  for (const target of basisTargets(body)) {
    const id = resolveTarget(target, '', known);
    if (id) slugs.add(id);
    else if (!missing.includes(target)) missing.push(target);
  }
  return { slugs: [...slugs].sort(), missing };
}

/**
 * How many different sources a set of pages cites. Two source entries are the
 * same source when they share an id or a sha256, so a page that renames the
 * id of a document does not make it two.
 */
export function distinctSources(pages) {
  const groups = [];
  for (const page of pages) {
    for (const s of page.sources || []) {
      const keys = [s.id ? `id:${s.id}` : '', s.sha256 ? `sha:${s.sha256}` : ''].filter(Boolean);
      if (!keys.length) continue;
      const hit = groups.filter((g) => keys.some((k) => g.has(k)));
      const merged = new Set(keys);
      for (const g of hit) { for (const k of g) merged.add(k); groups.splice(groups.indexOf(g), 1); }
      groups.push(merged);
    }
  }
  return groups.length;
}

const keyOf = (slugs) => sha256Text([...new Set(slugs)].sort().join('\n'));

/**
 * The memory of learnings people turned down. A record names the sorted Basis
 * slugs, the title, and the content hash of every Basis page when it was
 * turned down. A new learning with the same Basis set is refused while every
 * one of those pages is unchanged.
 */
export function createRejectedMemory({ store, git, config }) {
  const main = () => config.service.git.main;
  const wikiDir = () => `${config.v1.brainDir.replace(/\/+$/, '')}/wiki`;

  async function hashOf(slug, ref = main()) {
    const text = await git.show(ref, `${wikiDir()}/${slug}.md`);
    return typeof text === 'string' ? sha256Text(text) : '';
  }

  return {
    hashOf,

    async remember({ basis, title }) {
      const slugs = [...new Set(basis)].sort();
      if (slugs.length === 0) return null;
      const hashes = {};
      for (const slug of slugs) hashes[slug] = await hashOf(slug);
      const record = { basis: slugs, title: String(title || '').slice(0, 300), hashes, at: new Date().toISOString() };
      await store.kv.set(REJECTED_NS, keyOf(slugs), record);
      return record;
    },

    async list() {
      const rows = await store.kv.list(REJECTED_NS);
      return (rows || []).map((r) => r.value ?? r).filter((r) => Array.isArray(r?.basis));
    },

    /** The record that forbids a learning resting on exactly `basis`, or null (none, or a Basis page changed since). */
    async blocking(basis) {
      const record = await store.kv.get(REJECTED_NS, keyOf(basis));
      if (!record?.hashes) return null;
      for (const slug of record.basis) {
        if ((await hashOf(slug)) !== record.hashes[slug]) return null;
      }
      return record;
    },

    /** Records whose Basis pages are all unchanged: what the next prompt lists. */
    async standing() {
      const out = [];
      for (const record of await this.list()) {
        let same = true;
        for (const slug of record.basis) if ((await hashOf(slug)) !== record.hashes?.[slug]) { same = false; break; }
        if (same) out.push(record);
      }
      return out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    },
  };
}
