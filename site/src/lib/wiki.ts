/**
 * Wiki loader — reads flat markdown pages out of the brain directories,
 * parses frontmatter, resolves [[wikilinks]], and builds the backlink graph.
 *
 * Runs at build time only. Nothing here ships to the browser.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import matter from 'gray-matter';
import { marked } from 'marked';
import siteConfig from '../../site.config';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

/**
 * Which brain directories to read.
 *
 * Single brain (the default):
 *   [{ name: 'brain', prefix: '', dir: 'brain/wiki' }]
 *
 * Multiple brains — give each one a `prefix` so `[[research:foo]]` resolves.
 * See docs/multi-brain.md.
 *   [
 *     { name: 'research', prefix: 'research', dir: 'research-brain/wiki' },
 *     { name: 'projects', prefix: 'projects', dir: 'projects-brain/wiki' },
 *   ]
 */
export const WIKI_DIRS = [
  { name: 'brain', prefix: '', dir: 'brain/wiki' },
];

export interface WikiPage {
  slug: string;
  /** Slug including the brain prefix, e.g. 'research:transformers'. Unique across brains. */
  id: string;
  brain: string;
  title: string;
  type: string;
  tier: string;
  tags: string[];
  status: string;
  confidence: string;
  owner: string;
  dateCreated: string;
  dateModified: string;
  lastVerified: string;
  sources: string[];
  related: string[];
  /** Extra frontmatter keys not in the base schema (type_fields from brain.config.yaml). */
  extra: Record<string, unknown>;
  html: string;
  /** Ids this page links out to, resolved. */
  links: string[];
  /** Wikilink targets that do not exist. */
  brokenLinks: string[];
  backlinks: { id: string; title: string }[];
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g;

function asArray(v: unknown): string[] {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [String(v)].filter(Boolean);
}

function asString(v: unknown): string {
  return v == null ? '' : String(v);
}

/** Normalise a wikilink target into a page id. `[[foo]]` in brain 'x' -> 'foo' or 'x:foo'. */
function resolveTarget(raw: string, fromBrainPrefix: string, known: Set<string>): string | null {
  const target = raw.trim();
  if (!target) return null;

  // Explicit cross-brain link: [[projects:retrieval-pipeline]]
  if (target.includes(':')) {
    return known.has(target) ? target : null;
  }
  // Same-brain first, then any brain (unprefixed link in a multi-brain setup).
  const local = fromBrainPrefix ? `${fromBrainPrefix}:${target}` : target;
  if (known.has(local)) return local;
  if (known.has(target)) return target;
  for (const id of known) {
    if (id.endsWith(`:${target}`)) return id;
  }
  return null;
}

interface RawPage {
  id: string;
  slug: string;
  brain: string;
  prefix: string;
  data: Record<string, unknown>;
  body: string;
}

function readRawPages(): RawPage[] {
  const out: RawPage[] = [];

  for (const brain of WIKI_DIRS) {
    const dir = path.resolve(REPO_ROOT, brain.dir);
    if (!fs.existsSync(dir)) {
      console.warn(`[wiki] brain directory not found, skipping: ${brain.dir}`);
      continue;
    }

    for (const file of fs.readdirSync(dir).sort()) {
      if (!file.endsWith('.md')) continue;
      if (file.startsWith('.')) continue;

      const slug = file.slice(0, -3);
      if (slug.startsWith('_') && !siteConfig.showExamplePages) continue;

      const source = fs.readFileSync(path.join(dir, file), 'utf-8');
      let parsed;
      try {
        parsed = matter(source);
      } catch (err) {
        throw new Error(
          `[wiki] could not parse frontmatter in ${brain.dir}/${file}. ` +
            `Frontmatter must be the very first thing in the file — no blank lines ` +
            `or comments above the opening '---'.\n${(err as Error).message}`
        );
      }

      out.push({
        id: brain.prefix ? `${brain.prefix}:${slug}` : slug,
        slug,
        brain: brain.name,
        prefix: brain.prefix,
        data: parsed.data as Record<string, unknown>,
        body: parsed.content,
      });
    }
  }

  return out;
}

const BASE_KEYS = new Set([
  'title', 'type', 'tier', 'tags', 'status', 'confidence', 'owner',
  'date_created', 'date_modified', 'last_verified', 'sources', 'related',
]);

let cache: WikiPage[] | null = null;

/** All wiki pages, fully resolved. Cached for the lifetime of the build. */
export function getPages(): WikiPage[] {
  if (cache) return cache;

  const raw = readRawPages();
  const known = new Set(raw.map((p) => p.id));
  const titles = new Map(raw.map((p) => [p.id, asString(p.data.title) || p.slug]));
  const backlinks = new Map<string, { id: string; title: string }[]>();

  const pages: WikiPage[] = raw.map((p) => {
    const links: string[] = [];
    const brokenLinks: string[] = [];

    // Rewrite wikilinks into markdown links before rendering.
    const withLinks = p.body.replace(WIKILINK, (_m, target: string, label?: string) => {
      const text = (label ?? target).trim();
      const resolved = resolveTarget(target, p.prefix, known);
      if (!resolved) {
        brokenLinks.push(target.trim());
        return `<span class="wikilink is-broken" title="No page named &quot;${target.trim()}&quot;">${text}</span>`;
      }
      if (!links.includes(resolved)) links.push(resolved);
      return `<a class="wikilink" href="${hrefFor(resolved)}">${text}</a>`;
    });

    const title = asString(p.data.title) || p.slug;
    const extra: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(p.data)) {
      if (!BASE_KEYS.has(k)) extra[k] = v;
    }

    return {
      slug: p.slug,
      id: p.id,
      brain: p.brain,
      title,
      type: asString(p.data.type) || 'untyped',
      tier: asString(p.data.tier) || 'curated',
      tags: asArray(p.data.tags),
      status: asString(p.data.status),
      confidence: asString(p.data.confidence),
      owner: asString(p.data.owner),
      dateCreated: asString(p.data.date_created),
      dateModified: asString(p.data.date_modified),
      lastVerified: asString(p.data.last_verified),
      sources: asArray(p.data.sources),
      related: asArray(p.data.related).map((r) => r.replace(/^\[\[|\]\]$/g, '')),
      extra,
      html: marked.parse(withLinks, { async: false }) as string,
      links,
      brokenLinks,
      backlinks: [],
    };
  });

  // Second pass: invert the link graph.
  for (const page of pages) {
    for (const target of page.links) {
      if (!backlinks.has(target)) backlinks.set(target, []);
      backlinks.get(target)!.push({ id: page.id, title: page.title });
    }
  }
  for (const page of pages) {
    page.backlinks = (backlinks.get(page.id) ?? []).sort((a, b) =>
      a.title.localeCompare(b.title)
    );
  }

  cache = pages.sort((a, b) => a.title.localeCompare(b.title));
  return cache;
}

/** URL path for a page id. */
export function hrefFor(id: string): string {
  return '/' + id.replace(':', '/') + '/';
}

export function getPage(id: string): WikiPage | undefined {
  return getPages().find((p) => p.id === id);
}

/** Group pages by a frontmatter field, sorted with the largest group first. */
export function groupPages(
  pages: WikiPage[],
  key: 'type' | 'tier'
): { name: string; pages: WikiPage[] }[] {
  const groups = new Map<string, WikiPage[]>();
  for (const page of pages) {
    const name = page[key] || 'untyped';
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name)!.push(page);
  }
  return [...groups.entries()]
    .map(([name, ps]) => ({ name, pages: ps }))
    .sort((a, b) => b.pages.length - a.pages.length || a.name.localeCompare(b.name));
}

export function allTags(pages: WikiPage[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of pages) for (const t of p.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
