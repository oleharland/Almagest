/**
 * snapshot.mjs — the brain as it is on `main`, whatever the checkout is doing.
 *
 * The service must never answer from, or count demand against, an ingest
 * branch someone happens to have checked out. So it reads pages from a
 * detached worktree pinned to main's commit (`.almagest/snapshots/main`).
 * Detached is the point: git allows a detached checkout of a commit that is
 * also checked out on a branch elsewhere, so this works beside a user who has
 * `main` open in their own working tree.
 *
 *   ctx.snapshot.load()    → { sha, dir, pages, byId, known }  (cached per sha)
 *   ctx.snapshot.refresh() → re-pins to main's current sha when it moved
 *
 * It always pins the LOCAL main, the one only reviewed merges move — never
 * the remote's, which may hold commits nobody reviewed here, so chats must
 * not cite it. It refreshes itself on `proposal.merged`. Remote deployments
 * additionally call `refresh({ fetch: true })` from a git webhook or an
 * interval: that re-pins local main too, and asks the remote where its main
 * is only to log a warning when the two differ.
 */
import fs from 'node:fs';
import path from 'node:path';

import matter from 'gray-matter';

import { loadWiki, WIKI_DIRS } from '../../../tools/lib/wiki-core.mjs';

export function createSnapshot({ git, config, bus, log, wikiDirs = WIKI_DIRS }) {
  const dir = path.join(config.paths.state, 'snapshots', 'main');
  let pinned = '';
  let cache = null;
  let inflight = null;
  let warned = '';

  async function pin(sha) {
    const existing = (await git.worktrees()).find((w) => fs.existsSync(dir) && sameDir(w.path, dir));
    if (!existing) {
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      await git.run(['worktree', 'prune']);
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await git.run(['worktree', 'add', '--detach', dir, sha]);
    } else {
      await git.run(['checkout', '--detach', '--force', sha], { cwd: dir });
    }
    pinned = sha;
    cache = null;
  }

  /** Where the remote's main is — asked, never fetched into a ref. Warns once per pair of shas when it is not local main. */
  async function checkRemote(sha) {
    const remote = config.service.git.remote;
    const out = await git.tryRun(['ls-remote', '--quiet', remote, `refs/heads/${config.service.git.main}`]);
    if (out === null) { log?.warn('snapshot: could not ask the remote where its main is', { remote }); return; }
    const theirs = out.trim().split(/\s+/)[0] || '';
    const pair = `${theirs}..${sha}`;
    if (theirs && theirs !== sha && pair !== warned) {
      warned = pair;
      log?.warn("the remote's main differs from local main — chats keep reading the reviewed local main", { remote, remoteSha: theirs.slice(0, 7), localSha: sha.slice(0, 7) });
    }
  }

  async function refresh({ fetch = false } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
      const sha = await git.revParse(config.service.git.main);
      if (fetch && config.service.git.remote) await checkRemote(sha);
      if (sha !== pinned || !fs.existsSync(dir)) {
        await pin(sha);
        log?.debug('snapshot pinned', { sha: sha.slice(0, 7) });
      }
      return pinned;
    })().finally(() => { inflight = null; });
    return inflight;
  }

  async function load() {
    if (!pinned) await refresh();
    if (cache && cache.sha === pinned) return cache;
    const wiki = loadWiki({ repoRoot: dir, matter, wikiDirs, showExamplePages: false, onWarn: (m) => log?.warn(m) });
    cache = { sha: pinned, dir, ...wiki };
    return cache;
  }

  bus?.on('proposal.merged', () => refresh().catch((err) => log?.error('snapshot refresh failed', { error: err.message })));

  return { dir, refresh, load, get sha() { return pinned; } };
}

function sameDir(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}
