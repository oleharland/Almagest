/**
 * builder.mjs — turn `baseSha..headSha` into the review surface.
 *
 * Reads both sides of every changed wiki page straight out of git (`git show`,
 * never a checkout an agent may still be writing to), parses them with
 * gray-matter + wiki-core, and produces ProposalChange[]: per page, the claims
 * that were added, changed or removed, each with the source passage its
 * citation points at.
 */
import path from 'node:path';

import matter from 'gray-matter';

import { asArray, asString, normalizeSources } from '../../../tools/lib/wiki-core.mjs';
import { diffClaims, extractClaims } from './claims.mjs';
import { locate } from './excerpt.mjs';

const ACTIONS = { A: 'create', M: 'update', D: 'delete', R: 'rename' };

/** Frontmatter fields worth telling a reviewer about when they change. */
const FIELD_WORDS = {
  title: 'Title', tier: 'Tier', status: 'Status', confidence: 'Confidence', owner: 'Owner team',
  tags: 'Tags', aliases: 'Also known as', origin: 'Origin', type: 'Page type',
};

function parsePage(text) {
  if (text === null || text === undefined) return null;
  try {
    const parsed = matter(text);
    return { data: parsed.data || {}, body: parsed.content, sources: normalizeSources(parsed.data?.sources) };
  } catch (err) {
    return { data: {}, body: text, sources: [], parseError: err.message };
  }
}

const fieldValue = (v) => (Array.isArray(v) ? asArray(v).join(', ') : asString(v));

function fieldChanges(before, after) {
  const out = [];
  for (const [key, label] of Object.entries(FIELD_WORDS)) {
    const a = fieldValue(before?.data?.[key]);
    const b = fieldValue(after?.data?.[key]);
    if (a !== b) out.push({ key, label, before: a, after: b });
  }
  const ids = (p) => (p?.sources || []).map((s) => s.title || s.id || s.path).join(', ');
  if (ids(before) !== ids(after)) out.push({ key: 'sources', label: 'Sources', before: ids(before), after: ids(after) });
  return out;
}

export function canonicalSet(canonicalPages = []) {
  return new Set(canonicalPages.map((s) => String(s).trim().replace(/^\[\[|\]\]$/g, '').replace(/^.*\//, '').replace(/\.md$/, '')));
}

/**
 * @param {object} input
 * @param {object} input.git            core git helpers
 * @param {string} input.baseSha
 * @param {string} input.headSha
 * @param {string} [input.wikiDir]      'brain/wiki'
 * @param {string[]} [input.canonicalPages]  config.v1.canonicalPages
 * @returns {Promise<{ changes: Array, otherFiles: Array }>}
 */
export async function buildChanges({ git, baseSha, headSha, wikiDir = 'brain/wiki', canonicalPages = [] }) {
  const canonical = canonicalSet(canonicalPages);
  const all = await git.diffNames(baseSha, headSha);
  const prefix = wikiDir.replace(/\/+$/, '') + '/';
  const wiki = all.filter((d) => d.path.startsWith(prefix) || d.from?.startsWith(prefix));
  const otherFiles = all.filter((d) => !wiki.includes(d)).map((d) => ({ status: d.status, path: d.path, ...(d.from ? { from: d.from } : {}) }));

  const fileCache = new Map();
  const readAt = async (sha, file) => {
    const key = `${sha}:${file}`;
    if (!fileCache.has(key)) fileCache.set(key, git.show(sha, file));
    return fileCache.get(key);
  };

  const changes = [];
  for (const d of wiki) {
    if (!d.path.endsWith('.md')) continue;
    const action = ACTIONS[d.status] || 'update';
    const slug = path.basename(d.path, '.md');
    const fromSlug = d.from ? path.basename(d.from, '.md') : '';
    const before = action === 'create' ? null : parsePage(await readAt(baseSha, d.from || d.path));
    const after = action === 'delete' ? null : parsePage(await readAt(headSha, d.path));

    const claims = diffClaims(before ? extractClaims(before.body) : [], after ? extractClaims(after.body) : []);
    for (const claim of claims) {
      const side = claim.op === 'remove' ? { page: before, sha: baseSha } : { page: after, sha: headSha };
      await attachExcerpt(claim, side, readAt);
    }

    const meta = after?.data || before?.data || {};
    const tierBefore = asString(before?.data?.tier);
    const tierAfter = asString(after?.data?.tier);
    changes.push({
      slug,
      path: d.path,
      ...(fromSlug && fromSlug !== slug ? { from: fromSlug } : {}),
      action,
      title: asString(meta.title) || slug,
      tier: tierAfter || tierBefore || 'curated',
      owner: asString(meta.owner),
      confidence: asString(meta.confidence),
      canonical: canonical.has(slug) || (fromSlug && canonical.has(fromSlug)) || tierBefore === 'canonical' || tierAfter === 'canonical',
      hot: false,
      demand: 0,
      claims,
      fields: action === 'update' || action === 'rename' ? fieldChanges(before, after) : [],
      // A new page the claim extractor found nothing in (a citation only on a
      // heading, say) is not "no change" — the whole page needs reading.
      ...(action === 'create' && claims.length === 0 ? { needsManualLook: true, preview: String(after?.body || '').trim().slice(0, 1500) } : {}),
      pageStatus: 'pending',
    });
  }
  for (const f of otherFiles) await attachPreview(f, { git, baseSha, headSha, readAt });
  return { changes, otherFiles };
}

const PREVIEW_LINES = 40;
const PREVIEW_CHARS = 4000;

/**
 * What a non-wiki file in the proposal says, so the reviewer reads it rather
 * than a filename: its size, and the first PREVIEW_LINES lines of a new file
 * or the lines a change adds to an existing one. A file under raw/ is
 * agent-written text like any page; approving it unseen is approving it blind.
 */
async function attachPreview(f, { git, baseSha, headSha, readAt }) {
  if (f.status === 'D') return;
  const text = await readAt(headSha, f.path);
  if (text === null || text === undefined) return;
  f.bytes = Buffer.byteLength(text);
  if (text.includes('\0')) { f.binary = true; return; }
  f.lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  let lines;
  if (f.status === 'M') {
    const diff = await git.run(['diff', '--unified=0', '--no-color', '--no-ext-diff', baseSha, headSha, '--', f.path]).catch(() => '');
    lines = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1));
    f.previewOf = 'added';
  } else {
    lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    f.previewOf = 'start';
  }
  f.previewTruncated = lines.length > PREVIEW_LINES;
  f.preview = lines.slice(0, PREVIEW_LINES).join('\n');
  if (f.preview.length > PREVIEW_CHARS) { f.preview = f.preview.slice(0, PREVIEW_CHARS); f.previewTruncated = true; }
}

async function attachExcerpt(claim, { page, sha }, readAt) {
  const c = claim.citation;
  if (!c || !c.id || c.id === 'unknown') { claim.excerptStatus = 'no-citation'; return; }
  const source = page?.sources.find((s) => s.id === c.id);
  if (!source) { claim.excerptStatus = 'unknown-source'; return; }
  c.title = source.title || source.id;
  if (source.path) c.path = source.path;
  if (!source.path) { claim.excerptStatus = 'source-missing'; return; }
  const text = await readAt(sha, source.path);
  if (text === null || text === undefined) { claim.excerptStatus = 'source-missing'; return; }
  const hit = locate(text, c.locator, { hint: claim.text });
  claim.excerptStatus = hit.status;
  if (hit.status === 'found') claim.excerpt = hit.passage;
}

/** Fill `hot` / `demand` from ctx.demand. Telemetry being down must never block a review. */
export async function attachDemand(changes, demand, log) {
  if (!demand?.get || changes.length === 0) return changes;
  try {
    const map = await demand.get(changes.map((c) => c.slug));
    for (const c of changes) {
      const d = map?.get?.(c.slug);
      c.hot = Boolean(d?.hot);
      c.demand = Number(d?.score || 0);
    }
  } catch (err) {
    log?.warn('demand lookup failed — treating pages as not hot', { error: err.message });
  }
  return changes;
}
