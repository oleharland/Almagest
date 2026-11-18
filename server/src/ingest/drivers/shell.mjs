/**
 * shell.mjs — any executable that speaks the benchmarks/drivers protocol.
 *
 *   <command> capabilities   TSV <key>\t<yes|no>
 *   <command> run            reads ALM_* from the environment, prints one JSON object
 *
 * That protocol already has drivers for codex, gemini-cli and antigravity, so
 * `ingest.driver: codex` resolves to `benchmarks/drivers/codex.sh` through
 * here. Two extra variables tell an ingest-aware script what it is doing:
 * `ALM_MODE=ingest` and `ALM_CWD` (also the process cwd).
 *
 * The capability check is the point of this file. The unattended agent reads
 * untrusted content, and the tool allowlist is what makes that safe. A script
 * that reports `tool_restriction no` cannot be held to the allowlist, so it is
 * refused unless `ingest.allow_unrestricted_driver: true` says, in config a
 * reviewer can see, that someone decided to run it anyway — in a disposable
 * container, one hopes. The benchmark scripts for codex and antigravity report
 * `no` today, and the benchmark scripts run their CLIs read-only, which cannot
 * write pages at all: point `ingest.shell.command` at a write-capable wrapper.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentEnv, lastJsonObject, runProcess } from './proc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BENCH_DRIVERS = path.resolve(HERE, '..', '..', '..', '..', 'benchmarks', 'drivers');

export const CAPABILITY_KEYS = ['tool_restriction', 'budget_cap', 'structured_output', 'cost_reporting', 'session_isolation', 'sandbox'];

export function parseCapabilities(tsv) {
  const caps = {};
  for (const line of String(tsv).split('\n')) {
    const [k, v] = line.trim().split('\t');
    if (CAPABILITY_KEYS.includes(k)) caps[k] = v === 'yes';
  }
  return caps;
}

/** `codex` → benchmarks/drivers/codex.sh; anything with a `/` is a path. */
export function resolveShellCommand(nameOrPath, repoRoot) {
  if (!nameOrPath) throw new Error('ingest.shell.command is not set — name a driver script');
  if (nameOrPath.includes('/')) return path.resolve(repoRoot, nameOrPath);
  const bench = path.join(BENCH_DRIVERS, `${nameOrPath}.sh`);
  if (fs.existsSync(bench)) return bench;
  return nameOrPath;   // on PATH
}

export function createShellDriver(ctx, options = {}) {
  const shellCfg = ctx.config.ingest.shell || {};
  const name = options.name || 'shell';
  const command = resolveShellCommand(options.command || shellCfg.command || (name !== 'shell' ? name : ''), ctx.repoRoot);
  let caps = null;

  async function capabilities() {
    if (caps) return caps;
    const res = await runProcess(command, ['capabilities'], { cwd: ctx.repoRoot, env: agentEnv(ctx.config) });
    if (res.code !== 0) throw new Error(`${command} capabilities exited ${res.code}`);
    caps = parseCapabilities(res.stdout);
    return caps;
  }

  return {
    name,
    get capabilities() { return caps || {}; },

    async run({ cwd, prompt, systemPrompt, allowedTools, model, budgetUsd, signal, logStream }) {
      const c = await capabilities();
      if (!c.tool_restriction && ctx.config.ingest.allow_unrestricted_driver !== true) {
        throw new Error(`refusing to run ${path.basename(command)} unattended: it reports tool_restriction=no, so the tool allowlist cannot be enforced — set ingest.allow_unrestricted_driver: true only for a disposable sandbox`);
      }
      if (!c.budget_cap) logStream?.write(`[shell] note: ${path.basename(command)} cannot enforce a budget; ingest.budget_usd_per_job is advisory for this driver\n`);

      const env = agentEnv(ctx.config, {
        ALM_PROMPT: prompt,
        ALM_SYSTEM: systemPrompt || '',
        ALM_MODEL: model || '',
        ALM_TOOLS: allowedTools.join(','),
        ALM_BUDGET_USD: budgetUsd ? String(budgetUsd) : '',
        ALM_SCHEMA_FILE: '',
        ALM_MODE: 'ingest',
        ALM_CWD: cwd,
        ...(shellCfg.cli ? { ALM_CLI: String(shellCfg.cli) } : {}),
      });
      logStream?.write(`[shell] ${command} run (cwd ${cwd})\n`);
      const res = await runProcess(command, ['run'], { cwd, env, signal, logStream });
      const out = lastJsonObject(res.stdout);
      const ok = res.code === 0 && !res.aborted && out && out.is_error !== true && out.is_error !== 'true';
      const cost = Number(out?.total_cost_usd);
      return {
        ok: Boolean(ok),
        costUsd: Number.isFinite(cost) && out?.total_cost_usd !== '' ? cost : undefined,
        durationMs: res.durationMs,
        error: ok ? undefined : (res.aborted ? 'aborted' : `exit ${res.code}${res.signal ? ` (${res.signal})` : ''}`),
        raw: out || { stdout: res.stdout.slice(-4000), code: res.code },
      };
    },
  };
}
