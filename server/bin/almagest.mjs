#!/usr/bin/env node
/**
 * almagest — the v2 service CLI.
 *
 *   almagest serve              HTTP (inbox, remote MCP, API) + ingest runner
 *   almagest serve --no-http    ingest runner only (the background daemon)
 *   almagest mcp                Almagest as an MCP server over stdio
 *   almagest doctor             check the environment this instance needs
 *   almagest <module command>   commands contributed by modules (hook, connectors, …)
 *
 * Commands with `needsApp: false` (hooks, mostly) run without building the app
 * — no database, no network — because a Claude Code hook has to answer in
 * milliseconds and must work when the service is not running.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createApp, DEFAULT_REPO_ROOT, mainBranchProblem, MODULES } from '../src/app.mjs';
import { parseLogins, parseTokens, resolveLogins } from '../src/core/auth.mjs';
import { configErrors, loadServiceConfig } from '../src/core/config.mjs';
import { hooksInstalled } from '../../tools/lib/git-hooks.mjs';

const USAGE = `Usage: almagest <command> [options]

  serve [--no-http]   Run the service (inbox, remote MCP, ingest runner)
  mcp                 Serve the brain over MCP on stdio
  doctor              Check node, git, config, store
  help                This text

Options:
  --repo <dir>        Repo root (default: $ALMAGEST_REPO or the checkout this CLI lives in)
  --config <path>     brain.config.yaml to read
`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo' || a === '--config') opts[a.slice(2)] = argv[++i];
    else if (a === '--no-http') opts.http = false;
    else opts._.push(a);
  }
  return opts;
}

function moduleCommands() {
  const all = {};
  for (const [mod, m] of Object.entries(MODULES)) {
    for (const [name, cmd] of Object.entries(m.commands || {})) {
      if (all[name]) throw new Error(`command "${name}" is defined by both ${all[name].module} and ${mod}`);
      all[name] = { ...cmd, module: mod };
    }
  }
  return all;
}

/**
 * Exported for tests; `deps` swaps the environment, the output and the `pg`
 * import so each check can be driven both ways.
 * @returns {Promise<number>} 0 when nothing failed (warnings do not fail)
 */
export async function doctor(repoRoot, configPath, deps = {}) {
  const { env = process.env, out = console.log, importPg = () => import('pg') } = deps;
  let ok = true;
  const check = async (label, fn) => {
    try { out(`✓ ${label}: ${await fn()}`); }
    catch (err) { ok = false; out(`✗ ${label}: ${err.message}`); }
  };
  /** Like check, but a problem is printed as a warning and does not fail the run. */
  const advise = (label, fn) => {
    try { out(`✓ ${label}: ${fn()}`); }
    catch (err) { out(`! ${label}: ${err.message}`); }
  };
  await check('node', () => {
    const [maj, min] = process.versions.node.split('.').map(Number);
    if (maj < 22 || (maj === 22 && min < 13)) throw new Error(`${process.versions.node} — need 22.13+ for node:sqlite`);
    return process.versions.node;
  });
  await check('git', () => {
    const v = execFileSync('git', ['--version'], { encoding: 'utf-8' }).trim();
    const [maj, min] = (v.match(/(\d+)\.(\d+)/) || []).slice(1).map(Number);
    if (maj < 2 || (maj === 2 && min < 38)) throw new Error(`${v} — need 2.38+ for merge-tree --write-tree`);
    return v;
  });
  let config = null;
  await check('config', () => {
    // validate: false so a profile/auth mismatch is reported below as its own
    // line instead of hiding every check that needs the config.
    config = loadServiceConfig(repoRoot, { configPath, env, validate: false });
    return `profile ${config.profile}, store ${config.service.store.driver}, ${config.sources.connectors.length} connector(s)`;
  });
  for (const warning of config?.warnings || []) out(`! config: ${warning}`);
  await check('main branch', () => {
    const problem = mainBranchProblem(repoRoot, config?.service.git);
    if (problem) throw new Error(problem);
    return config?.service.git.main || 'main';
  });
  advise('git hooks', () => {
    // The pre-commit audit and the reference-transaction guard on main only
    // run once `almagest hooks install` has copied main's hooks into the git
    // dir; a hook that differs from main's is outdated until it is re-run.
    const hooks = hooksInstalled(repoRoot);
    if (!hooks.ok) throw new Error(hooks.problems.join('; '));
    return hooks.hooksPath;
  });
  if (config) {
    await check('profile', () => {
      const errors = configErrors(config);
      if (errors.length) throw new Error(errors.join('; '));
      return `${config.profile}, auth ${config.service.auth.provider}`;
    });
    await check('store', async () => {
      const { driver } = config.service.store;
      if (driver !== 'postgres') return driver;
      try { await importPg(); }
      catch { throw new Error('store.driver: postgres needs the optional `pg` dependency, which cannot be imported — run `npm install` in server/'); }
      if (!config.service.store.url) throw new Error('store.driver: postgres needs service.store.url (or DATABASE_URL)');
      return 'postgres, pg installed';
    });
    // What `serve` needs to be usable, not just to start: without these it
    // boots, and then nobody can sign in or no connector token can be stored.
    await check('secret key', () => {
      if (!env.ALMAGEST_SECRET_KEY) throw new Error('ALMAGEST_SECRET_KEY is not set — sessions, links and connector tokens need it');
      return 'set';
    });
    await check('sign-in', () => {
      const { provider, tokens_env: tokensEnv = 'ALMAGEST_TOKENS', logins_env: loginsEnv = 'ALMAGEST_LOGINS', oidc = {} } = config.service.auth;
      if (provider === 'oidc') {
        if (!oidc.issuer || !oidc.client_id) throw new Error('service.auth.oidc needs issuer and client_id');
        return `oidc ${oidc.issuer}`;
      }
      const tokens = parseTokens(env[tokensEnv] || '');
      if (!tokens.length) throw new Error(`${tokensEnv} is empty — nobody has a role, so nobody can sign in or approve`);
      // API tokens never sign in: a browser session comes from a separate
      // sign-in secret, or from a one-time link (`almagest login <name>`).
      const { usable, problems } = resolveLogins(tokens, parseLogins(env[loginsEnv] || ''), { loginsEnv, tokensEnv });
      for (const problem of problems) out(`! sign-in: ${problem}`);
      if (!usable.length) {
        if (!env.ALMAGEST_SECRET_KEY) throw new Error(`no usable entry in ${loginsEnv} and no ALMAGEST_SECRET_KEY for one-time links — nobody can sign in to the inbox`);
        return `no ${loginsEnv} entries — sign in with a one-time link: node server/bin/almagest.mjs login <name>`;
      }
      return `${usable.length} sign-in secret(s) in ${loginsEnv}, ${tokens.length} API token(s) in ${tokensEnv}`;
    });
    await check('ingest driver', () => {
      const driver = config.ingest.driver;
      if (driver !== 'claude-code') return driver;
      const cli = config.ingest.cli || 'claude';
      return `claude-code — ${execFileSync(cli, ['--version'], { encoding: 'utf-8' }).trim().split('\n')[0]}`;
    });
  }
  return ok ? 0 : 1;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [command = 'help', ...rest] = opts._;
  const repoRoot = opts.repo || process.env.ALMAGEST_REPO || DEFAULT_REPO_ROOT;

  if (command === 'help' || command === '--help' || command === '-h') {
    const extra = Object.entries(moduleCommands()).map(([n, c]) => `  ${n.padEnd(20)}${c.summary || ''}`).join('\n');
    process.stdout.write(USAGE + (extra ? `\nModule commands:\n${extra}\n` : ''));
    return 0;
  }
  if (command === 'doctor') return doctor(repoRoot, opts.config);

  if (command === 'serve') {
    const app = await createApp({ repoRoot, configPath: opts.config });
    await app.start({ http: opts.http !== false });
    const shutdown = async () => { await app.stop(); process.exit(0); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return new Promise(() => {});   // run until signalled
  }

  if (command === 'mcp') {
    const app = await createApp({ repoRoot, configPath: opts.config });
    await app.start({ http: false, background: false });
    await app.ctx.mcp.serveStdio();
    return new Promise(() => {});
  }

  const cmd = moduleCommands()[command];
  if (!cmd) {
    process.stderr.write(`almagest: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  }
  const env = { repoRoot, configPath: opts.config, opts };
  if (cmd.needsApp) {
    const app = await createApp({ repoRoot, configPath: opts.config });
    try { return await cmd.run(rest, { ...env, app, ctx: app.ctx }); }
    finally { await app.stop(); }
  }
  return cmd.run(rest, env);
}

// Run only as the CLI (directly or through the npm bin symlink), not when a
// test imports doctor().
const invoked = (() => { try { return fs.realpathSync(process.argv[1] || ''); } catch { return ''; } })();
if (invoked === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => { if (typeof code === 'number') process.exitCode = code; },
    (err) => { process.stderr.write(`almagest: ${err.stack || err.message}\n`); process.exitCode = 2; },
  );
}
