/**
 * source.mjs — turning "a file appeared" into a SourceRef, and putting the
 * bytes a job will read into its worktree.
 *
 * The service fingerprints; the agent never does (spec → "Fingerprint, don't
 * guess"). A local file is hashed once, here, and copied into a
 * content-addressed staging area under `.almagest/staging/<sha256>`. The job
 * then reads the staged copy, not the user's file: someone who drops a PDF and
 * then edits or deletes it a second later must not change what a queued job
 * ingests, or the sha256 on the job would describe bytes nobody read.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { slugify } from '../core/schemas.mjs';

/**
 * Filename sanitization from agent/rules/ingest.md → Filename sanitization.
 * Windows-safe is safe everywhere; path separators are stripped too, since a
 * name is about to become one path segment.
 */
export function sanitizeFilename(name) {
  return String(name)
    .replace(/%20/g, '_')
    .replace(/ /g, '_')
    .replace(/:/g, '-')
    .replace(/—/g, '--')
    .replace(/[\\/]/g, '_')
    .replace(/[<>"|?*\x00-\x1f]/g, '_');
}

export async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** True when `child` is `parent` or inside it — on real paths, so a symlink cannot walk out. */
export function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function realish(p) {
  // The file may not exist yet (a hook fires before Write creates it), so
  // resolve the nearest existing ancestor and re-append the rest. That is what
  // makes /var vs /private/var on macOS compare equal.
  let cur = path.resolve(p);
  const tail = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  try { cur = fs.realpathSync(cur); } catch { /* keep the resolved path */ }
  return path.join(cur, ...tail);
}

/**
 * Should this path under the drop folder become a job at all? Mechanical
 * filters only — whether it is *new* is the manifest's question, not this one.
 */
export function isIngestCandidate(relToLocal) {
  const parts = relToLocal.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return false;
  if (parts[0] === 'processed' || parts[0] === 'extracted') return false;
  if (parts.some((p) => p.startsWith('.'))) return false;
  const base = parts[parts.length - 1];
  if (base === '.gitkeep' || /^readme(\.[a-z0-9]+)?$/i.test(base)) return false;
  if (/~$|\.swp$|\.tmp$|\.crdownload$|\.part$/i.test(base)) return false;
  return true;
}

/**
 * A SourceRef for a file under `sources.local.path`, fingerprinted and staged.
 * `extraRoots` admits service-owned drop points too — `.almagest/submissions/`,
 * where MCP `submit_source` writes what a chat handed it. Nothing else outside
 * the drop folder is ever readable this way, so a request body cannot name
 * `~/.ssh/id_rsa` as a "source".
 *
 *   path    the file as the user dropped it, repo-relative (where the bytes came from)
 *   id      the manifest id the agent should use: slug of the sanitized filename
 *   title   the original filename — `ingestBranch` slugs it, matching `id`
 *   sha256  of the bytes, computed here
 */
export async function localSource({ repoRoot, localPath, stagingDir, extraRoots = [] }, file, { stage: doStage = true } = {}) {
  const abs = realish(path.resolve(repoRoot, file));
  const root = [path.resolve(repoRoot, localPath), ...extraRoots].map(realish).find((r) => isInside(r, abs) && abs !== r);
  if (!root) {
    throw Object.assign(new Error(`${file} is not under ${localPath}/`), { status: 400 });
  }
  const rel = path.relative(root, abs);
  if (!isIngestCandidate(rel)) {
    throw Object.assign(new Error(`${file} is not an ingest candidate (processed/, extracted/, dotfiles and READMEs are skipped)`), { status: 400 });
  }
  const stat = fs.statSync(abs, { throwIfNoEntry: false });
  if (!stat?.isFile()) throw Object.assign(new Error(`${file} is not a file`), { status: 400 });

  const sha256 = await sha256File(abs);
  // Staging is skipped while merely checking a file against the manifest —
  // copying every unchanged PDF on each start-up scan would be pure waste.
  const staged = doStage ? await stage(stagingDir, abs, sha256) : undefined;
  const name = sanitizeFilename(path.basename(abs));
  return {
    kind: 'local',
    id: slugify(name),
    // Repo-relative when inside the repo (every drop folder is), absolute otherwise.
    path: (isInside(realish(repoRoot), abs) ? path.relative(realish(repoRoot), abs) : abs).split(path.sep).join('/'),
    sha256,
    bytes: stat.size,
    title: path.basename(abs),
    ...(staged ? { staged } : {}),
  };
}

/** Copy into `<stagingDir>/<sha256>`, verifying the copy — the file may be changing under us. */
export async function stage(stagingDir, abs, sha256) {
  fs.mkdirSync(stagingDir, { recursive: true });
  const dest = path.join(stagingDir, sha256);
  if (fs.existsSync(dest)) return dest;
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.copyFileSync(abs, tmp);
  const got = await sha256File(tmp);
  if (got !== sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${path.basename(abs)} changed while it was being staged — it will be picked up again once it is stable`);
  }
  fs.renameSync(tmp, dest);
  return dest;
}

/** Where a local source lands inside the worktree: flat under the drop folder, sanitized. */
export function worktreeSourcePath(localPath, source) {
  const name = sanitizeFilename(path.basename(source.path || source.title || source.id));
  return `${localPath.replace(/\/+$/, '')}/${name}`;
}

/**
 * Put the source's bytes into the worktree and return the worktree-relative
 * path the agent should read.
 *
 * local      staged copy (or the repo file, re-hashed) → `<local>/<sanitized name>`
 * connector  the snapshot ctx.connectors produced → `ctx.connectors.snapshotPath(ref)`
 *
 * Either way the bytes are hashed again after the copy and must equal
 * `source.sha256`. A mismatch fails the job: the agent would otherwise record a
 * fingerprint for content it never saw.
 */
export async function placeSource(ctx, source, worktree) {
  const { repoRoot, config } = ctx;
  let from;
  let rel;
  if (source.kind === 'connector') {
    rel = await ctx.connectors.snapshotPath(source);
    from = [
      source.staged,
      source.stagedPath,
      path.join(config.paths.state, 'connectors', rel),
      path.isAbsolute(rel) ? rel : path.join(repoRoot, rel),
    ].find((p) => p && fs.existsSync(p));
    if (path.isAbsolute(rel)) rel = path.relative(repoRoot, rel);
  } else if (source.kind === 'local') {
    rel = worktreeSourcePath(config.sources.localPath, source);
    from = [source.staged, path.join(config.paths.state, 'staging', source.sha256 || '-'), path.resolve(repoRoot, source.path || '.')]
      .find((p) => p && fs.existsSync(p) && fs.statSync(p).isFile());
  } else {
    throw new Error(`source kind "${source.kind}" cannot be placed by the runner — remote sources arrive as connector snapshots`);
  }
  if (!from) throw new Error(`source bytes for ${source.id} are gone (looked for the staged copy and ${source.path || rel})`);

  const dest = path.join(worktree, rel);
  if (!isInside(worktree, path.resolve(dest))) throw new Error(`refusing to place ${source.id} outside the worktree (${rel})`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(from, dest);
  const got = await sha256File(dest);
  if (source.sha256 && got !== source.sha256) {
    throw new Error(`fingerprint mismatch for ${source.id}: queued as ${source.sha256.slice(0, 7)}…, bytes are ${got.slice(0, 7)}…`);
  }
  return { path: rel.split(path.sep).join('/'), sha256: got, bytes: fs.statSync(dest).size };
}
