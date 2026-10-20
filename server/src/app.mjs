/**
 * app.mjs — the composition root. Builds `ctx`, then each module in dependency
 * order. Modules talk to each other only through the service objects on `ctx`
 * (docs/v2/spec.md → Cross-module service objects), never through imports of
 * each other's internals.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAuth } from './core/auth.mjs';
import './core/auth-oidc.mjs';   // registers the `oidc` provider before createAuth runs
import { createBus } from './core/bus.mjs';
import { loadServiceConfig } from './core/config.mjs';
import { createGit } from './core/git.mjs';
import { createRouter } from './core/http.mjs';
import { createLogger } from './core/log.mjs';
import { createSnapshot } from './core/snapshot.mjs';
import { createStore } from './core/store/index.mjs';

import * as telemetry from './telemetry/index.mjs';
import * as connectors from './connectors/index.mjs';
import * as ingest from './ingest/index.mjs';
import * as governance from './governance/index.mjs';
import * as mcp from './mcp/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..');

/** Build order. telemetry first: it sets ctx.demand, which governance reads. */
export const MODULES = { telemetry, connectors, ingest, governance, mcp };

/**
 * @param {object} [options]
 * @param {string} [options.repoRoot]
 * @param {string} [options.configPath]
 * @param {object} [options.overrides]   config overrides (tests, CLI flags)
 * @param {object} [options.modules]     replace module implementations (tests)
 * @param {object} [options.log]
 */
export async function createApp(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.env.ALMAGEST_REPO || DEFAULT_REPO_ROOT);
  const config = loadServiceConfig(repoRoot, { configPath: options.configPath, overrides: options.overrides });
  const log = options.log || createLogger();

  const ctx = { repoRoot, config, log };
  ctx.store = options.store || (await createStore(config));
  ctx.bus = createBus({ log });
  ctx.git = createGit({ repoRoot, main: config.service.git.main, worktreeDir: config.paths.worktrees });
  ctx.auth = createAuth(ctx);
  ctx.http = createRouter({ auth: ctx.auth, log });
  ctx.snapshot = createSnapshot(ctx);

  ctx.http.route('GET', '/healthz', async () => ({ ok: true, profile: config.profile }));

  const modules = { ...MODULES, ...(options.modules || {}) };
  for (const [name, mod] of Object.entries(modules)) {
    ctx[name] = await mod.create(ctx);
  }

  let server = null;

  return {
    ctx,
    async start({ http = true } = {}) {
      await ctx.ingest.start?.();
      await ctx.telemetry.start?.();
      if (http) {
        server = await ctx.http.listen({ host: config.service.http.host, port: config.service.http.port });
        log.info('listening', { url: config.service.http.base_url, profile: config.profile });
      }
      return server;
    },
    async stop() {
      await ctx.ingest.stop?.();
      await ctx.telemetry.stop?.();
      await ctx.connectors.stop?.();
      if (server) await new Promise((r) => server.close(r));
      await ctx.bus.drain();
      await ctx.store.close();
    },
  };
}
