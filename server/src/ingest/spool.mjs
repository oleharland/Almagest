/**
 * spool.mjs — the hand-off for when the service is not listening.
 *
 * A Claude Code hook has to finish in milliseconds and must work with the
 * service down. So `hook enqueue` tries the HTTP API once, briefly, and on any
 * failure writes `.almagest/spool/<ts>-<rand>.json`. The service drains the
 * spool on start and on an interval. No authentication is involved, and none
 * is needed: anyone who can write to `.almagest/spool/` can write to
 * `brain/raw/` too, and a spooled path is fingerprinted and checked against
 * the manifest exactly like a watched one.
 *
 * Written tmp-then-rename so a drain never reads half a file.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function writeSpool(dir, entry) {
  fs.mkdirSync(dir, { recursive: true });
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
  const tmp = path.join(dir, `.${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify({ ...entry, at: new Date().toISOString() }));
  fs.renameSync(tmp, path.join(dir, name));
  return path.join(dir, name);
}

/**
 * Hand each spooled entry to `handle`, oldest first. Handled entries are
 * deleted; ones that throw are renamed `.failed` and left for a human, never
 * retried in a loop.
 */
export async function drainSpool(dir, handle, { log } = {}) {
  if (!fs.existsSync(dir)) return 0;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort();
  let n = 0;
  for (const f of files) {
    const file = path.join(dir, f);
    let entry;
    try {
      entry = JSON.parse(fs.readFileSync(file, 'utf-8'));
      await handle(entry);
      fs.rmSync(file, { force: true });
      n++;
    } catch (err) {
      log?.warn('spool: entry failed — renamed .failed', { file: f, error: err.message });
      try { fs.renameSync(file, `${file}.failed`); } catch { /* raced with another drain */ }
    }
  }
  return n;
}
