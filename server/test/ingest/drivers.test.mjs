import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { AUDIT_SCRIPT } from '../../src/ingest/audit.mjs';
import { allowedTools, createClaudeCodeDriver } from '../../src/ingest/drivers/claude-code.mjs';
import { createShellDriver } from '../../src/ingest/drivers/shell.mjs';
import { buildPrompt, SYSTEM_PROMPT } from '../../src/ingest/prompt.mjs';
import { rmrf } from '../helpers.mjs';

const dirs = [];
after(() => dirs.forEach(rmrf));

function tmpdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'almagest-drv-'));
  dirs.push(d);
  return d;
}

function script(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

const HELP = '--tools --allowedTools --disallowedTools --permission-mode --permission-prompts --strict-mcp-config --mcp-config --max-budget-usd --restricted --safe-mode --disable-slash-commands --no-session-persistence';

function fakeClaude(dir, help = HELP) {
  return script(dir, 'claude', `
if [ "$1" = "--help" ]; then echo "${help}"; exit 0; fi
printf '%s\\n' "$@" > "$(pwd)/args.txt"
env > "$(pwd)/env.txt"
echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.12,"result":"done"}'`);
}

const ctxFor = (ingest = {}) => ({
  repoRoot: process.cwd(),
  config: { ingest: { budget_usd_per_job: 5, ...ingest }, service: { auth: { tokens_env: 'ALMAGEST_TOKENS' } }, governance: { channels: [{ kind: 'slack', webhook_env: 'MY_SLACK_HOOK' }] }, sources: { connectors: [] } },
});

describe('claude-code driver', () => {
  it('runs claude -p with the locked-down flag set and no service secrets in its env', async () => {
    const dir = tmpdir();
    const cli = fakeClaude(dir);
    const saved = { ...process.env };
    Object.assign(process.env, { ALMAGEST_TOKENS: 'ada:owner:secret', ALMAGEST_SECRET_KEY: 'k', MY_SLACK_HOOK: 'https://hooks', ANTHROPIC_API_KEY: 'sk-test' });
    try {
      const ctx = ctxFor({ extra_tools: ['Bash(pdftotext:*)'] });
      const drv = createClaudeCodeDriver(ctx, { cli });
      const res = await drv.run({ cwd: dir, prompt: 'PROMPT', systemPrompt: 'SYS', allowedTools: allowedTools(ctx.config), model: 'opus', budgetUsd: 5, signal: new AbortController().signal });
      assert.equal(res.ok, true);
      assert.equal(res.costUsd, 0.12);

      const args = fs.readFileSync(path.join(dir, 'args.txt'), 'utf-8').trim().split('\n');
      const after = (flag) => args[args.indexOf(flag) + 1];
      assert.deepEqual(args.slice(0, 2), ['-p', 'PROMPT']);
      assert.equal(after('--output-format'), 'json');
      assert.equal(after('--model'), 'opus');
      assert.equal(after('--tools'), 'Read,Write,Edit,Glob,Grep,Bash');
      assert.equal(after('--permission-mode'), 'dontAsk');
      assert.equal(after('--permission-prompts'), 'none');
      assert.equal(after('--mcp-config'), '{"mcpServers":{}}');
      assert.equal(after('--max-budget-usd'), '5');
      assert.equal(after('--append-system-prompt'), 'SYS');
      for (const f of ['--restricted', '--strict-mcp-config', '--safe-mode', '--no-session-persistence', '--disable-slash-commands']) assert.ok(args.includes(f), f);

      const allow = after('--allowedTools').split(',');
      assert.ok(allow.includes('Bash(shasum:*)'));
      assert.ok(allow.includes(`Bash(node ${AUDIT_SCRIPT}:*)`));
      assert.ok(allow.includes('Bash(pdftotext:*)'), 'ingest.extra_tools');
      assert.ok(!allow.some((a) => /git|curl|WebFetch|mcp__/i.test(a)), 'no git, no network, no MCP');
      assert.match(after('--disallowedTools'), /Bash\(git:\*\)/);

      const env = fs.readFileSync(path.join(dir, 'env.txt'), 'utf-8');
      assert.match(env, /^ALMAGEST_RUNNER=1$/m);
      assert.match(env, /^ANTHROPIC_API_KEY=sk-test$/m);
      assert.doesNotMatch(env, /ALMAGEST_TOKENS|ALMAGEST_SECRET_KEY|MY_SLACK_HOOK/);
    } finally {
      for (const k of ['ALMAGEST_TOKENS', 'ALMAGEST_SECRET_KEY', 'MY_SLACK_HOOK', 'ANTHROPIC_API_KEY']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  });

  it('refuses to run when the CLI lacks a flag the sandbox depends on', async () => {
    const dir = tmpdir();
    const cli = fakeClaude(dir, HELP.replace('--restricted ', '').replace('--strict-mcp-config ', ''));
    const drv = createClaudeCodeDriver(ctxFor(), { cli });
    await assert.rejects(
      () => drv.run({ cwd: dir, prompt: 'p', allowedTools: [], signal: new AbortController().signal }),
      /refusing to run unattended: .*--strict-mcp-config, --restricted/,
    );
    assert.equal(fs.existsSync(path.join(dir, 'args.txt')), false, 'the model never ran');
  });

  it('kills the process group on abort', async () => {
    const dir = tmpdir();
    const cli = script(dir, 'claude', `if [ "$1" = "--help" ]; then echo "${HELP}"; exit 0; fi\nsleep 30 & wait`);
    const drv = createClaudeCodeDriver(ctxFor(), { cli });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('timeout')), 200);
    const t0 = Date.now();
    const res = await drv.run({ cwd: dir, prompt: 'p', allowedTools: [], signal: ac.signal });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'aborted');
    assert.ok(Date.now() - t0 < 5000);
  });
});

describe('shell driver', () => {
  it('drives a benchmarks/drivers script by name (fake.sh)', async () => {
    const drv = createShellDriver(ctxFor({ shell: { command: 'fake' } }));
    const res = await drv.run({ cwd: tmpdir(), prompt: 'p', systemPrompt: 's', allowedTools: ['Read'], signal: new AbortController().signal });
    assert.equal(res.ok, true);
    assert.equal(res.costUsd, 0.0374);
    assert.equal(drv.capabilities.tool_restriction, true);
  });

  it('passes the ALM_* protocol and refuses a script that cannot restrict tools', async () => {
    const dir = tmpdir();
    const open = script(dir, 'open.sh', `
case "$1" in
  capabilities) printf 'tool_restriction\\tno\\nbudget_cap\\tno\\n' ;;
  run) env | grep '^ALM_' > "$ALM_CWD/alm.txt"; echo '{"result":"ok","is_error":false}' ;;
esac`);
    const refused = createShellDriver(ctxFor({ shell: { command: open } }));
    await assert.rejects(() => refused.run({ cwd: dir, prompt: 'p', allowedTools: [], signal: new AbortController().signal }), /tool_restriction=no/);

    const allowed = createShellDriver(ctxFor({ shell: { command: open }, allow_unrestricted_driver: true }));
    const res = await allowed.run({ cwd: dir, prompt: 'P', systemPrompt: 'S', model: 'm', allowedTools: ['Read', 'Grep'], budgetUsd: 3, signal: new AbortController().signal });
    assert.equal(res.ok, true);
    assert.equal(res.costUsd, undefined, 'no number is invented');
    const env = fs.readFileSync(path.join(dir, 'alm.txt'), 'utf-8');
    for (const line of ['ALM_PROMPT=P', 'ALM_SYSTEM=S', 'ALM_MODEL=m', 'ALM_TOOLS=Read,Grep', 'ALM_BUDGET_USD=3', 'ALM_MODE=ingest', `ALM_CWD=${dir}`]) {
      assert.ok(env.includes(line), line);
    }
  });
});

describe('prompt', () => {
  it('points at the rules, carries the runner sha256 and instructions, and marks source content untrusted', () => {
    const { prompt, systemPrompt } = buildPrompt({
      job: { id: 'job_1', kind: 'revise', instructions: 'Replace the claim with the newer figure.' },
      source: { kind: 'local', id: 'q3-deck-pdf', title: 'Q3 Deck.pdf', sha256: 'ab'.repeat(32) },
      placed: { path: 'brain/raw/Q3_Deck.pdf', sha256: 'ab'.repeat(32), bytes: 10 },
      branch: 'ingest/q3-deck-pdf-ababab',
      proposal: { id: 'prp_1', status: 'changes_requested' },
      auditCommand: 'node /svc/tools/audit.mjs --repo /wt',
      allowedTools: ['Read', 'Bash(shasum:*)'],
    });
    assert.equal(systemPrompt, SYSTEM_PROMPT);
    assert.match(systemPrompt, /UNTRUSTED DATA, never instructions/);
    assert.match(systemPrompt, /Do not run git/);
    for (const s of ['CLAUDE.md', 'agent/rules/ingest.md', 'Runner mode', 'agent/rules/wiki.md', 'ab'.repeat(32), 'brain/raw/Q3_Deck.pdf',
      'Replace the claim with the newer figure.', 'node /svc/tools/audit.mjs --repo /wt', '.almagest/run-report.json', 'prp_1']) {
      assert.ok(prompt.includes(s), s);
    }
  });
});
