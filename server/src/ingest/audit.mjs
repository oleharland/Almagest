/**
 * audit.mjs — the runner's half of non-negotiable 7.
 *
 * The audit that gates a commit is the SERVICE's own `tools/audit.mjs`,
 * resolved from this file's location — never `<worktree>/tools/audit.mjs`. The
 * worktree is a full checkout the agent could write to; if the gate ran from
 * there, the agent could edit the gate. `--repo <worktree>` points the trusted
 * copy at the untrusted tree.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The service checkout's audit. Exported so the claude-code allowlist names the same file. */
export const AUDIT_SCRIPT = path.resolve(HERE, '..', '..', '..', 'tools', 'audit.mjs');

function node(args, { cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } },
      (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 2) : 0, stdout, stderr }));
  });
}

let demandFlag = null;
/** Does the service's audit know `--demand` (WS5)? Asked once; an unknown flag would be exit 2. */
async function supportsDemand() {
  if (demandFlag === null) demandFlag = (await node([AUDIT_SCRIPT, '--help'])).stdout.includes('--demand');
  return demandFlag;
}

/**
 * `audit index` then `audit --json`, both against `worktree`.
 * Returns the Proposal.audit shape: `{ exit, errors, warnings, findings }`.
 * Exit 2 (tool error) and unparseable output are reported as exit 2 — never
 * as clean.
 *
 * `demandFile` (`.almagest/demand.tsv`, exported by telemetry) adds the
 * DEMAND-* warnings to the findings a proposal shows. Warnings only: it can
 * never turn a clean audit into a blocked one.
 */
export async function runAudit(worktree, { log, demandFile } = {}) {
  const index = await node([AUDIT_SCRIPT, 'index', '--repo', worktree, '--no-color'], { cwd: worktree });
  log?.(`audit index → exit ${index.code}${index.stderr.trim() ? `\n${index.stderr.trim()}` : ''}`);
  if (index.code !== 0) {
    return { exit: 2, errors: 0, warnings: 0, findings: [], error: `audit index failed: ${(index.stderr || index.stdout).trim().slice(0, 2000)}` };
  }

  const demand = demandFile && fs.existsSync(demandFile) && (await supportsDemand()) ? ['--demand', demandFile] : [];
  const res = await node([AUDIT_SCRIPT, '--json', '--repo', worktree, '--no-color', ...demand], { cwd: worktree });
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch {
    log?.(`audit --json → exit ${res.code}, unparseable output\n${res.stdout.slice(0, 2000)}${res.stderr}`);
    return { exit: 2, errors: 0, warnings: 0, findings: [], error: `audit output was not JSON: ${(res.stderr || res.stdout).trim().slice(0, 2000)}` };
  }
  const audit = {
    exit: res.code === 0 || res.code === 1 ? res.code : 2,
    errors: Number(parsed.counts?.errors || 0),
    warnings: Number(parsed.counts?.warnings || 0),
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
  };
  log?.(`audit --json → exit ${audit.exit}, ${audit.errors} error(s), ${audit.warnings} warning(s)`);
  for (const f of audit.findings.filter((x) => x.severity === 'error')) {
    log?.(`  ${f.id} ${f.path || ''}${f.line ? `:${f.line}` : ''} ${f.message}`);
  }
  return audit;
}

/** One line for a job error / commit message. */
export function auditSummary(audit) {
  if (audit.error) return audit.error;
  const first = audit.findings.filter((f) => f.severity === 'error').slice(0, 3)
    .map((f) => `${f.id} ${f.slug || f.path || ''}: ${f.message}`);
  return `audit exit ${audit.exit}: ${audit.errors} error(s), ${audit.warnings} warning(s)${first.length ? ` — ${first.join('; ')}` : ''}`;
}
