/**
 * canonical.mjs — the canonical set on `main`, read out of git.
 *
 * The definition lives in tools/lib/canonical.mjs (canonicalSet): a page is
 * canonical when its slug is in `canonical_pages` or its frontmatter says
 * `tier: canonical`. This file only gathers the tiers: every page directly in
 * `<brain>/wiki/` at a commit, parsed as frontmatter — never a text search, so
 * `tier: "canonical"`, a trailing comment or a quoted escape all read as the
 * audit reads them. Reads are one `git ls-tree` and one `git cat-file --batch`,
 * and the result is kept per commit.
 */
import { execFile } from 'node:child_process';

import { canonicalSet, lockingTier } from '../../../tools/lib/canonical.mjs';
import { childEnv } from '../core/git.mjs';

const CACHE_SIZE = 8;
const cache = new Map();   // `${repoRoot}\0${wikiDir}\0${sha}` → Map<slug, tier>

function batch(repoRoot, shas) {
  return new Promise((resolve, reject) => {
    const child = execFile('git', ['cat-file', '--batch'], {
      cwd: repoRoot, env: childEnv(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024,
    }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin.end(`${shas.join('\n')}\n`);
  });
}

/** `git cat-file --batch` output → one Buffer per requested sha, in order. */
function split(out, count) {
  const blobs = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    const eol = out.indexOf(0x0a, at);
    if (eol === -1) { blobs.push(null); continue; }
    const header = out.toString('utf-8', at, eol).split(' ');
    if (header[1] !== 'blob') { blobs.push(null); at = eol + 1; continue; }
    const size = Number(header[2]);
    blobs.push(out.subarray(eol + 1, eol + 1 + size));
    at = eol + 1 + size + 1;
  }
  return blobs;
}

/**
 * Every page in `<wikiDir>/` at `ref`, as Map<slug, tier> ('' when a page has
 * no tier). A page whose tier the two parsers read differently, or cannot read,
 * is listed as 'canonical': it is locked (tools/lib/canonical.mjs, lockingTier).
 * Pages in subdirectories are not wiki pages (paths.mjs).
 */
export async function tiersAt(git, ref, wikiDir) {
  const sha = await git.revParse(ref);
  const key = `${git.repoRoot}\0${wikiDir}\0${sha}`;
  if (cache.has(key)) return cache.get(key);
  const listing = await git.tryRun(['ls-tree', '-z', `${sha}:${wikiDir.replace(/\/+$/, '')}`]);
  const files = [];
  for (const entry of (listing || '').split('\0').filter(Boolean)) {
    const m = /^(\d+) blob ([0-9a-f]{40,64})\t(.+)$/.exec(entry);
    if (m && m[3].endsWith('.md')) files.push({ slug: m[3].slice(0, -3), sha: m[2] });
  }
  const tiers = new Map();
  if (files.length) {
    const blobs = split(await batch(git.repoRoot, files.map((f) => f.sha)), files.length);
    files.forEach((f, i) => tiers.set(f.slug, blobs[i] ? lockingTier(blobs[i].toString('utf-8')) : ''));
  }
  cache.set(key, tiers);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
  return tiers;
}

/**
 * The canonical set at `ref` (default: main): `canonical_pages` from the
 * config plus every page whose frontmatter at that commit says canonical.
 */
export async function canonicalAt(git, config, ref = config.service.git.main) {
  const tiers = await tiersAt(git, ref, `${config.v1.brainDir.replace(/\/+$/, '')}/wiki`);
  return canonicalSet({ configPages: config.v1.canonicalPages, tiers });
}
