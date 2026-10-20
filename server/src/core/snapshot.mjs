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
 * It refreshes itself on `proposal.merged`. Remote deployments additionally
 * call `refresh({ fetch: true })` from a git webhook or an interval.
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

  async function refresh({ fetch = false } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
      const remote = config.service.git.remote;
      if (fetch && remote) await git.run(['fetch', '--quiet', remote, config.service.git.main]);
      const ref = fetch && remote ? `${remote}/${config.service.git.main}` : config.service.git.main;
      const sha = await git.revParse(ref);
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
