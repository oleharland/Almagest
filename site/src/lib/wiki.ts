/**
 * Wiki loader — the site's typed view of `tools/lib/wiki-core.mjs`.
 *
 * The parsing lives in `tools/lib/wiki-core.mjs`, in plain JavaScript, because
 * `tools/audit.mjs` needs exactly the same loader and bare Node 22 will not
 * import a `.ts` file. This module adds the types, the site config, and the
 * build-time link gate; it does not reimplement anything. If you are looking
 * for how frontmatter or `[[wikilinks]]` are parsed, it is one file over.
 *
 * Runs at build time only. Nothing here ships to the browser.
 */
import matter from 'gray-matter';
import { marked } from 'marked';
import siteConfig from '../../site.config';
import {
  WIKI_DIRS as CORE_WIKI_DIRS,
  allTags as coreAllTags,
  groupPages as coreGroupPages,
  hrefFor as coreHrefFor,
  loadWiki,
} from '../../../tools/lib/wiki-core.mjs';

/** Injected by astro.config.mjs, which runs unbundled and so knows where it is. */
declare const __ALMAGEST_REPO_ROOT__: string;
const REPO_ROOT = __ALMAGEST_REPO_ROOT__;

/**
 * Which brain directories to read.
 *
 * Single brain (the default):
 *   [{ name: 'brain', prefix: '', dir: 'brain/wiki' }]
 *
 * Multiple brains — give each one a `prefix` so `[[research:foo]]` resolves.
 * Edit the array in `tools/lib/wiki-core.mjs`, not here: the audit reads the
 * same list, and two lists would disagree the first time you changed one.
 * See docs/multi-brain.md.
 */
export const WIKI_DIRS: { name: string; prefix: string; dir: string }[] = CORE_WIKI_DIRS;

/** One entry in a page's `sources` — schema v2. */
export interface WikiSource {
  /** Short kebab-case id. Inline `[source: <id>, …]` citations resolve against it. */
  id: string;
  /** Repo-root-relative path, or `<provider>:<owner>/<repo>/<path>@<commit>` for remote. */
  path: string;
  /** sha256 of whatever `path` names. Empty on a v1 string-form entry. */
  sha256: string;
  /** Optional human label. */
  title: string;
  /** True when the frontmatter still uses the retired v1 string form. */
  legacy: boolean;
}

/** Typed edges. Untyped "see also" stays in `related`. */
export interface WikiRelations {
  supports: string[];
  contradicts: string[];
  supersedes: string[];
  depends_on: string[];
}

export interface WikiPage {
  slug: string;
  /** Slug including the brain prefix, e.g. 'research:transformers'. Unique across brains. */
  id: string;
  brain: string;
  title: string;
  type: string;
  tier: string;
  /** `source` — derived from ingested material · `self` — the author's own conclusion. */
  origin: string;
  tags: string[];
  /** Alternative names. Base field in schema v2. */
  aliases: string[];
  status: string;
  confidence: string;
  owner: string;
  dateCreated: string;
  dateModified: string;
  lastVerified: string;
  sources: WikiSource[];
  /** Just the paths, for display and for counting distinct sources. */
  sourcePaths: string[];
  related: string[];
  relations: WikiRelations;
  /** Extra frontmatter keys not in the base schema (type_fields from brain.config.yaml). */
  extra: Record<string, unknown>;
  html: string;
  /** Ids this page links out to, resolved. */
  links: string[];
  /** Wikilink targets that do not exist. */
  brokenLinks: string[];
  backlinks: { id: string; title: string }[];
}

let cache: WikiPage[] | null = null;

/**
 * Broken wikilinks fail the production build.
 *
 * A published page whose link goes nowhere is a claim the site cannot support,
 * and `[...path].astro` rendering a grey non-link is a notice nobody reads. The
 * dev server still loads — you want to see the half-written page you are
 * writing — but `astro build` stops. Set ALMAGEST_ALLOW_BROKEN_LINKS=1 to
 * publish anyway; you have then chosen it.
 *
 * This is the LINK-001 check only. `tools/audit.mjs` is the full gate and CI
 * runs it: schema, citations, provenance and the rest are not the site's job.
 */
function gateBrokenLinks(pages: WikiPage[]): void {
  const offenders = pages.filter((p) => p.brokenLinks.length > 0);
  if (offenders.length === 0) return;

  const detail = offenders
    .map((p) => `  ${p.slug}.md → ${p.brokenLinks.map((t) => `[[${t}]]`).join(', ')}`)
    .join('\n');
  const total = offenders.reduce((n, p) => n + p.brokenLinks.length, 0);
  const banner =
    `\n${'━'.repeat(60)}\n` +
    `🔗 ${total} broken wikilink${total === 1 ? '' : 's'} on ${offenders.length} page${offenders.length === 1 ? '' : 's'} [LINK-001]\n` +
    `${'━'.repeat(60)}\n${detail}\n` +
    `→ create the missing pages, or fix the links. Full audit: tools/audit.mjs\n`;

  console.error(banner);

  const isProd = Boolean((import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD);
  if (isProd && !process.env.ALMAGEST_ALLOW_BROKEN_LINKS) {
    throw new Error(
      `[wiki] build stopped: ${total} broken wikilink${total === 1 ? '' : 's'}. ` +
        `Set ALMAGEST_ALLOW_BROKEN_LINKS=1 to publish anyway.`
    );
  }
}

/** All wiki pages, fully resolved. Cached for the lifetime of the build. */
export function getPages(): WikiPage[] {
  if (cache) return cache;

  const { pages } = loadWiki({
    repoRoot: REPO_ROOT,
    matter,
    wikiDirs: WIKI_DIRS,
    showExamplePages: siteConfig.showExamplePages,
    render: (markdown: string) => marked.parse(markdown, { async: false }) as string,
    onWarn: (message: string) => console.warn(message),
  });

  cache = pages as WikiPage[];
  gateBrokenLinks(cache);
  return cache;
}

/** URL path for a page id. */
export function hrefFor(id: string): string {
  return coreHrefFor(id);
}

export function getPage(id: string): WikiPage | undefined {
  return getPages().find((p) => p.id === id);
}

/** Group pages by a frontmatter field, sorted with the largest group first. */
export function groupPages(
  pages: WikiPage[],
  key: 'type' | 'tier'
): { name: string; pages: WikiPage[] }[] {
  return coreGroupPages(pages, key);
}

export function allTags(pages: WikiPage[]): { tag: string; count: number }[] {
  return coreAllTags(pages);
}
