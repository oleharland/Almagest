/**
 * watcher.mjs — the `watch` trigger. `fs.watch` (recursive) on the drop
 * folder, debounced per file, then held until the file stops changing.
 *
 * fs.watch reports intent, not completion: a browser download, a Finder copy
 * or an rsync fires a burst of events while the bytes are still arriving.
 * Hashing a half-written PDF would fingerprint bytes no one meant to ingest,
 * so a candidate is only handed on once its size and mtime have held still
 * for `stable_ms`.
 *
 * Whether the file is *new* is not decided here. The watcher passes every
 * stable candidate to `onCandidate`, which fingerprints it against main's
 * manifest (rule 5).
 */
import fs from 'node:fs';
import path from 'node:path';

import { isIngestCandidate } from './source.mjs';

const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

/** Resolves true once size+mtime hold for `stableMs`, false if the file vanished or never settled. */
export async function waitStable(file, { stableMs = 1000, maxWaitMs = 10 * 60 * 1000, isStopped = () => false } = {}) {
  const deadline = Date.now() + maxWaitMs;
  let prev = fs.statSync(file, { throwIfNoEntry: false });
  while (Date.now() < deadline && !isStopped()) {
    if (!prev?.isFile()) return false;
    await sleep(stableMs);
    const cur = fs.statSync(file, { throwIfNoEntry: false });
    if (!cur?.isFile()) return false;
    if (cur.size === prev.size && cur.mtimeMs === prev.mtimeMs) return true;
    prev = cur;
  }
  return false;
}

/** Every candidate file under `root`, for the start-up scan of drops made while the service was down. */
export function listCandidates(root) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = path.relative(root, abs);
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || rel === 'processed' || rel === 'extracted') continue;
        walk(abs);
      } else if (e.isFile() && isIngestCandidate(rel)) out.push(abs);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort();
}

export function createWatcher({ root, onCandidate, log, debounceMs = 750, stableMs = 1000 }) {
  let watcher = null;
  let stopped = false;
  const timers = new Map();
  const settling = new Set();

  function schedule(rel) {
    clearTimeout(timers.get(rel));
    const t = setTimeout(() => { timers.delete(rel); settle(rel); }, debounceMs);
    t.unref?.();
    timers.set(rel, t);
  }

  async function settle(rel) {
    if (settling.has(rel) || stopped) return;
    settling.add(rel);
    const abs = path.join(root, rel);
    try {
      if (await waitStable(abs, { stableMs, isStopped: () => stopped })) await onCandidate(abs);
    } catch (err) {
      log?.warn('watch: candidate failed', { file: rel, error: err.message });
    } finally {
      settling.delete(rel);
    }
  }

  return {
    start() {
      if (!fs.existsSync(root)) {
        log?.warn('watch: drop folder does not exist — not watching', { root });
        return false;
      }
      watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        if (!filename || stopped) return;
        const rel = filename.toString();
        if (isIngestCandidate(rel)) schedule(rel);
      });
      watcher.on('error', (err) => log?.error('watch: fs.watch failed', { error: err.message }));
      log?.info('watching drop folder', { root });
      return true;
    },
    stop() {
      stopped = true;
      watcher?.close();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
