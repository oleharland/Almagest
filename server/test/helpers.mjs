/**
 * helpers.mjs — shared test scaffolding for every module.
 *
 *   const repo = makeTempRepo();                      // git repo, main branch, clean fixture brain
 *   const app  = await makeApp({ repoRoot: repo, real: ['ingest'] });
 *   app.ctx.ingest  → the real module; every other module is its Phase 0 stub
 *
 * Temp repos hold only brain/ and brain.config.yaml. The audit always runs
 * from THIS checkout's tools/audit.mjs with `--repo <dir>` — the service never
 * executes tooling out of a worktree an agent could have written to.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp, MODULES } from '../src/app.mjs';
import { createMemoryLogger } from '../src/core/log.mjs';
import { notImplemented } from '../src/core/stub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SERVICE_ROOT = path.resolve(HERE, '..');
export const REPO_ROOT = path.resolve(SERVICE_ROOT, '..');
export const FIXTURES = path.join(REPO_ROOT, 'tools', 'lib', '__fixtures__');
export const AUDIT = path.join(REPO_ROOT, 'tools', 'audit.mjs');

export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t' },
  });
}

/** A throwaway git repo on `main` seeded from tools/lib/__fixtures__/<fixture>. */
export function makeTempRepo({ fixture = 'clean', files = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-test-'));
  fs.cpSync(path.join(FIXTURES, fixture), dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  fs.writeFileSync(path.join(dir, '.gitignore'), '.almagest/\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return dir;
}

/** Stubs for every module except the ones named in `real`. */
export function stubModules(real = []) {
  const out = {};
  for (const name of Object.keys(MODULES)) {
    if (real.includes(name)) continue;
    out[name] = { create: async (ctx) => notImplemented(name, ctx), commands: {} };
  }
  return out;
}

/**
 * @param {object} options
 * @param {string}   options.repoRoot
 * @param {string[]} [options.real]       modules to use for real; the rest are stubs
 * @param {object}   [options.modules]    explicit replacements, win over `real`
 * @param {object}   [options.overrides]  config overrides
 */
export async function makeApp({ repoRoot, real = [], modules = {}, overrides = {} } = {}) {
  const log = createMemoryLogger();
  const app = await createApp({
    repoRoot,
    log,
    modules: { ...stubModules(real), ...modules },
    overrides: { ...overrides, service: { ...(overrides.service || {}), store: { driver: 'memory' } } },
  });
  app.log = log;
  return app;
}

export function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
