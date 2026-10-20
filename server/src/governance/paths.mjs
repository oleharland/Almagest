/**
 * paths.mjs — what a proposal is allowed to change.
 *
 * A proposal is knowledge-base content and its bookkeeping, nothing else. The
 * runner's path guard limits what the agent writes, but a merge carries the
 * whole branch, so the set is enforced again here: by the policy engine
 * (a proposal touching anything else can never be approved) and inside the
 * merge, on the branch diff and on the merge result, right before main moves.
 *
 * Writable:
 *   <brain>/wiki/<slug>.md          (each wiki dir from wiki-core WIKI_DIRS; no subdirectories)
 *   <brain>/raw/extracted/**        source sidecars and connector snapshots
 *   <brain>/raw/processed/**        text only — never a binary
 *   <brain>/index.md, the manifest, <brain>/log.md, the challenges ledger
 *   <index_dir>/<name>.tsv          the derived index
 *
 * Never: a dotfile or dot-directory anywhere (.gitattributes, .github/ …), a
 * symlink, an executable bit, a submodule — and every path outside the list
 * (tools/, server/, agent/, brain.config.yaml, CLAUDE.md …).
 */
import { WIKI_DIRS } from '../../../tools/lib/wiki-core.mjs';

const strip = (p) => String(p || '').replace(/^\.?\/+/, '').replace(/\/+$/, '');

export function writableMatcher({ brainDir = 'brain', manifestPath, challengesPath, indexDir, wikiDirs = WIKI_DIRS }) {
  const brain = strip(brainDir);
  const wikis = [...new Set([`${brain}/wiki`, ...wikiDirs.map((w) => strip(w.dir))])];
  const exact = new Set([`${brain}/index.md`, strip(manifestPath || `${brain}/manifest.yaml`), `${brain}/log.md`, strip(challengesPath || `${brain}/canonical-challenges.md`)]);
  const trees = [`${brain}/raw/extracted/`, `${brain}/raw/processed/`];
  const index = strip(indexDir || `${brain}/.index`);

  return function allowed(file) {
    const p = String(file || '');
    const segments = p.split('/');
    if (!p || segments.some((s) => s === '' || s === '..')) return false;
    if (exact.has(p)) return true;
    if (p.startsWith(`${index}/`)) {
      const rest = p.slice(index.length + 1);
      return !rest.includes('/') && !rest.startsWith('.') && rest.endsWith('.tsv');
    }
    // Dotfiles are refused everywhere else: .gitattributes alone can change how a file merges.
    if (segments.some((s) => s.startsWith('.'))) return false;
    for (const dir of wikis) {
      if (p.startsWith(`${dir}/`)) {
        const rest = p.slice(dir.length + 1);
        return !rest.includes('/') && rest.endsWith('.md');
      }
    }
    return trees.some((t) => p.startsWith(t));
  };
}

/**
 * Files that put a proposal outside the writable set, with a reason each.
 * `files`: [{ status, path, from?, mode?, binary? }] from listChanges().
 */
export function outsideFiles(files = [], allowed) {
  const out = [];
  for (const f of files) {
    for (const p of [f.path, f.from].filter(Boolean)) {
      if (!allowed(p)) out.push({ path: p, reason: 'outside the knowledge base' });
    }
    if (f.status !== 'D' && f.mode && f.mode !== '100644') {
      out.push({ path: f.path, reason: f.mode === '120000' ? 'a symbolic link' : f.mode === '160000' ? 'a submodule' : 'not a plain file (executable or special mode)' });
    }
    if (f.binary && /\/raw\/processed\//.test(`/${f.path}`)) out.push({ path: f.path, reason: 'a binary file in processed/ (text only)' });
  }
  const seen = new Set();
  return out.filter((o) => (seen.has(`${o.path}|${o.reason}`) ? false : seen.add(`${o.path}|${o.reason}`)));
}

/** `git diff --raw` + `--numstat` between two commits → [{ status, path, from?, mode, binary }]. */
export async function listChanges(git, a, b) {
  const raw = await git.run(['diff', '--raw', '-z', '-M', '--no-abbrev', a, b]);
  const parts = raw.split('\0');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const meta = parts[i];
    if (!meta.startsWith(':')) continue;
    const [, newMode, , , status] = meta.slice(1).split(' ');
    const letter = status[0];
    if (letter === 'R' || letter === 'C') { files.push({ status: 'R', from: parts[i + 1], path: parts[i + 2], mode: newMode }); i += 2; }
    else { files.push({ status: letter, path: parts[i + 1], mode: letter === 'D' ? '' : newMode }); i += 1; }
  }
  const num = await git.run(['diff', '--numstat', '-z', '--no-renames', a, b]);
  const binary = new Set();
  for (const entry of num.split('\0')) {
    const m = entry.match(/^-\t-\t(.+)$/);
    if (m) binary.add(m[1]);
  }
  for (const f of files) f.binary = binary.has(f.path);
  return files;
}

export function describeOutside(outside) {
  const list = outside.slice(0, 5).map((o) => `${o.path} (${o.reason})`).join(', ');
  return `This proposal also changes files outside the knowledge base — it can't be approved: ${list}${outside.length > 5 ? ` and ${outside.length - 5} more` : ''}.`;
}
