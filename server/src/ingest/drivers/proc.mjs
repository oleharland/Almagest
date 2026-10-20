/**
 * proc.mjs — running an agent CLI as a child process the runner can kill.
 *
 * Agent CLIs spawn children of their own (shells, extractors, MCP servers if
 * one slipped through). Killing only the direct child leaves those running
 * with the worktree open, so the child is started as the leader of its own
 * process group and the whole group is signalled: SIGTERM, then SIGKILL after
 * a grace period.
 */
import { spawn } from 'node:child_process';

/**
 * Environment for an unattended agent: the parent's, minus the service's own
 * secrets. The agent needs its provider credentials (ANTHROPIC_API_KEY, the
 * keychain via HOME, cloud-provider variables); it has no business holding the
 * approval tokens, the sealing key, the database URL, or a channel webhook.
 */
export function agentEnv(config, extra = {}) {
  const named = new Set(['DATABASE_URL', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'GH_TOKEN', 'SMTP_URL']);
  const collect = (v) => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/_env$/i.test(k) && typeof x === 'string') named.add(x);
        else collect(x);
      }
    }
  };
  collect(config.service);
  collect(config.governance);
  collect(config.sources?.connectors);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^ALMAGEST_/.test(k) || /^PG[A-Z]+$/.test(k) || /^SLACK_/.test(k) || named.has(k)) continue;
    env[k] = v;
  }
  return { ...env, ALMAGEST_RUNNER: '1', ...extra };
}

/**
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, aborted: boolean, durationMs: number }>}
 */
export function runProcess(cmd, args, { cwd, env, signal, logStream, graceMs = 5000, input } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: process.platform !== 'win32', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let aborted = false;
    let killTimer = null;

    child.stdout.on('data', (d) => { stdout += d; logStream?.write(d); });
    child.stderr.on('data', (d) => logStream?.write(d));
    if (input !== undefined) child.stdin.end(input);

    const killGroup = (sig) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already gone */ }
    };
    const onAbort = () => {
      aborted = true;
      logStream?.write(`\n[runner] aborting agent (${signal.reason?.message || signal.reason || 'aborted'})\n`);
      killGroup('SIGTERM');
      killTimer = setTimeout(() => killGroup('SIGKILL'), graceMs);
      killTimer.unref?.();
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (killTimer) clearTimeout(killTimer);
      resolve({ code, signal: sig, stdout, aborted, durationMs: Date.now() - started });
    });
  });
}

/** The last JSON object a CLI printed on stdout, or null. CLIs print banners; the envelope is last. */
export function lastJsonObject(text) {
  const trimmed = String(text || '').trim();
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  const lines = trimmed.split('\n').reverse();
  for (const line of lines) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    try { return JSON.parse(l); } catch { /* keep looking */ }
  }
  return null;
}
