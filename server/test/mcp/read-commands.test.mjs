import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';

import { commands } from '../../src/mcp/cli.mjs';
import { makeApp, makeTempRepo, rmrf, SERVICE_ROOT } from '../helpers.mjs';
import { RANKING_PAGES } from './_util.mjs';

const repos = [];
const apps = [];
after(async () => {
  for (const a of apps) await a.stop();
  repos.forEach(rmrf);
});

/** A fixture brain with the real MCP and telemetry modules, the rest stubbed. */
async function setup(files = RANKING_PAGES) {
  const repoRoot = makeTempRepo({ files });
  repos.push(repoRoot);
  const app = await makeApp({ repoRoot, real: ['mcp', 'telemetry'] });
  apps.push(app);
  return app;
}

/** Run one CLI command in-process, collecting what it writes. */
async function cli(app, name, argv) {
  let stdout = '';
  let stderr = '';
  const code = await commands[name].run(argv, {
    repoRoot: app.ctx.repoRoot,
    ctx: app.ctx,
    out: (s) => { stdout += s; },
    err: (s) => { stderr += s; },
  });
  return { code, stdout, stderr };
}

describe('almagest search | get | ask', () => {
  it('search finds a page and points at the CLI commands, not the MCP tools', async () => {
    const app = await setup();
    const r = await cli(app, 'search', ['kestrel']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\[\[kestrel-scheduler\]\] Job Runner/);
    assert.match(r.stdout, /Next: almagest get <slug>/);
    assert.doesNotMatch(r.stdout, /get_page \{/);
    assert.doesNotMatch(r.stdout, /report_gap/);
  });

  it('search with no match prints the plain miss line and returns 1', async () => {
    const app = await setup();
    const r = await cli(app, 'search', ['zzzqqq']);
    assert.equal(r.code, 1);
    assert.equal(r.stdout.trim(), 'No page in the brain matches "zzzqqq".');
    assert.doesNotMatch(r.stdout, /report_gap/);
  });

  it('search --json prints the structured results', async () => {
    const app = await setup();
    const r = await cli(app, 'search', ['kestrel', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.ok(Array.isArray(data.results) && data.results.length > 0);
    assert.equal(data.results[0].slug, 'kestrel-scheduler');
  });

  it('a usage error returns 2 and writes one usage line to stderr', async () => {
    const app = await setup();
    const r = await cli(app, 'search', []);
    assert.equal(r.code, 2);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /usage: almagest search <words\.\.\./);
  });

  it('get prints the page, and --no-body leaves the body out', async () => {
    const app = await setup();
    const full = await cli(app, 'get', ['kestrel-scheduler']);
    assert.equal(full.code, 0, full.stderr);
    assert.match(full.stdout, /Job Runner/);
    assert.match(full.stdout, /executes batch work/);

    const bare = await cli(app, 'get', ['kestrel-scheduler', '--no-body']);
    assert.equal(bare.code, 0, bare.stderr);
    assert.match(bare.stdout, /Job Runner/);
    assert.doesNotMatch(bare.stdout, /executes batch work/);
  });

  it('get of a missing slug returns 1 and says so on stderr', async () => {
    const app = await setup();
    const r = await cli(app, 'get', ['no-such-page']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No page "no-such-page"/);
    assert.equal(r.stdout, '');
  });

  it('ask returns the answer-ready bundle and returns 0 when the brain answers', async () => {
    const app = await setup();
    const r = await cli(app, 'ask', ['kestrel']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /# Almagest .* context for: kestrel/);
    assert.match(r.stdout, /## How to answer/);
    assert.doesNotMatch(r.stdout, /report_gap|get_page/, 'the CLI text names no MCP tool');
  });

  it('ask on a miss returns 1 and drops the report_gap offer', async () => {
    const app = await setup();
    const r = await cli(app, 'ask', ['zzzqqq']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /does not cover it/);
    assert.doesNotMatch(r.stdout, /report_gap/);
  });

  it('ask --json returns the structured bundle', async () => {
    const app = await setup();
    const r = await cli(app, 'ask', ['kestrel', '--json']);
    assert.equal(r.code, 0, r.stderr);
    const data = JSON.parse(r.stdout);
    assert.equal(data.question, 'kestrel');
    assert.equal(data.answered, true);
  });

  it('every call is recorded on channel cli by the almagest-cli client', async () => {
    const app = await setup();
    await cli(app, 'search', ['kestrel']);
    await app.ctx.telemetry.flush();
    const events = await app.ctx.store.events.query({});
    const evt = events.filter((e) => e.channel === 'cli').at(-1);
    assert.ok(evt, 'a cli event was stored');
    assert.equal(evt.client, 'almagest-cli');
    assert.equal(evt.tool, 'search');
    assert.equal(evt.query, 'kestrel');
    assert.ok(evt.sessionId);
    assert.deepEqual(events.filter((e) => e.channel === 'mcp'), []);
  });
});

describe('almagest search | get | ask (real process)', () => {
  it('node bin/almagest.mjs search <word> --repo <dir> prints the hit and exits 0', () => {
    const repo = makeTempRepo({ files: RANKING_PAGES });
    repos.push(repo);
    const env = { ...process.env };
    delete env.ALMAGEST_TOKEN;
    delete env.ALMAGEST_TOKENS;
    const r = spawnSync(process.execPath, [path.join(SERVICE_ROOT, 'bin', 'almagest.mjs'), 'search', 'kestrel', '--repo', repo], {
      env, encoding: 'utf-8', timeout: 120_000,
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[\[kestrel-scheduler\]\]/);
  });
});
