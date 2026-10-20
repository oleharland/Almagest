/**
 * drivers/index.mjs — `ingest.driver` → a driver object.
 *
 * Interface every driver implements:
 *
 *   { name, capabilities: { tool_restriction, budget_cap, cost_reporting, session_isolation, sandbox },
 *     run({ cwd, prompt, systemPrompt, allowedTools, model, budgetUsd, timeoutMs, signal, logStream,
 *           job, source, sourcePath })
 *       → { ok, costUsd?, durationMs, error?, raw } }
 *
 * `job`, `source` and `sourcePath` are passed for drivers that need structured
 * input rather than prose — the fake driver; a real agent reads the prompt.
 * A driver never commits, never runs the audit that gates, and never decides
 * whether its own output is acceptable: the runner does all three.
 *
 * `codex`, `gemini-cli` and `antigravity` are the shell driver pointed at the
 * matching benchmarks/drivers/*.sh script.
 */
import { createClaudeCodeDriver } from './claude-code.mjs';
import { createFakeDriver } from './fake.mjs';
import { createShellDriver } from './shell.mjs';

export const DRIVERS = ['claude-code', 'shell', 'fake', 'codex', 'gemini-cli', 'antigravity'];

export function createDriver(name, ctx) {
  switch (name) {
    case 'claude-code': return createClaudeCodeDriver(ctx);
    case 'fake': return createFakeDriver(ctx);
    case 'shell': return createShellDriver(ctx);
    case 'codex':
    case 'gemini-cli':
    case 'antigravity':
      return createShellDriver(ctx, { name, command: ctx.config.ingest.shell?.command || name });
    default:
      throw new Error(`unknown ingest.driver "${name}" — one of ${DRIVERS.join(' | ')}`);
  }
}
