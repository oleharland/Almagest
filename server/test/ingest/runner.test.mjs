import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { cleanup, setup } from './_setup.mjs';

after(cleanup);

describe('runner: full run with the fake driver', () => {
  it('commits on ingest/<slug>-<sha7>, leaves main alone, and hands governance a clean audit', async () => {
    const t = await setup();
    const mainBefore = t.git('rev-parse', 'main').trim();
    await t.app.start({ http: false });
    const job = await t.drop('notes.md');
    const done = await t.finished(job);

    assert.equal(done.status, 'succeeded', done.error);
    assert.match(done.branch, /^ingest\/notes-md-[0-9a-f]{7}$/);
    assert.equal(done.branch, `ingest/notes-md-${job.source.sha256.slice(0, 7)}`);
    assert.equal(t.git('rev-parse', 'main').trim(), mainBefore, 'main must not move');
    assert.equal(t.git('symbolic-ref', '--short', 'HEAD').trim(), 'main', 'the user checkout is never touched');

    // One commit on the branch, by svc:ingest, with the requester as co-author.
    assert.equal(t.git('rev-list', '--count', `main..${done.branch}`).trim(), '1');
    const msg = t.git('log', '-1', '--format=%an <%ae>%n%B', done.branch);
    assert.match(msg, /^ingest <svc-ingest@almagest\.local>/);
    assert.match(msg, /Co-authored-by: Ada <ada@example\.com>/);

    // The page, the moved original, the manifest — and no run report in git.
    assert.ok(t.show(done.branch, 'brain/wiki/notes.md').includes('origin: source'));
    assert.ok(t.show(done.branch, 'brain/raw/processed/notes.md'));
    assert.equal(t.show(done.branch, 'brain/raw/notes.md'), null);
    assert.ok(t.show(done.branch, 'brain/manifest.yaml').includes(job.source.sha256));
    assert.ok(!t.git('ls-tree', '-r', '--name-only', done.branch).includes('.almagest'));

    assert.equal(t.governance.calls.length, 1);
    const { details } = t.governance.calls[0];
    assert.equal(details.branch, done.branch);
    assert.equal(details.audit.exit, 0);
    assert.equal(details.headSha, t.git('rev-parse', done.branch).trim());
    assert.equal(details.baseSha, mainBefore);
    assert.equal(details.runReport.pages[0].slug, 'notes');
    assert.equal(done.proposalId, [...t.governance.proposals.keys()][0]);

    // Per-job log file.
    const logText = fs.readFileSync(path.join(t.repo, '.almagest', 'logs', `${job.id}.log`), 'utf-8');
    assert.match(logText, /step 7: proposal prp_/);
    await t.stop();
  });

  it('an audit-failing run fails the job: no commit, no proposal, worktree kept', async () => {
    const t = await setup({ mode: 'audit-fail' });
    await t.app.start({ http: false });
    const done = await t.finished(await t.drop('bad.md'));
    assert.equal(done.status, 'failed');
    assert.match(done.error, /CITE-002/);
    assert.equal(done.attempts, 1, 'an audit failure is not retried');
    assert.equal(done.audit.exit, 1);
    assert.equal(t.git('rev-list', '--count', `main..${done.branch}`).trim(), '0', 'nothing committed');
    assert.equal(t.governance.calls.length, 0);
    assert.ok(fs.existsSync(path.join(done.worktree, 'brain', 'wiki', 'bad.md')), 'worktree kept for inspection');
    await t.stop();
  });

  it('passes blocked[] through to governance, and blocked-only marks the job blocked', async () => {
    const t = await setup({ mode: 'blocked' });
    await t.app.start({ http: false });
    const done = await t.finished(await t.drop('contra.md'));
    assert.equal(done.status, 'succeeded');
    const blocked = t.governance.calls[0].details.runReport.blocked;
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].kind, 'contradiction');
    assert.equal(blocked[0].options.length, 2);

    t.ctx.config.ingest.fake.mode = 'blocked-only';
    const only = await t.finished(await t.drop('only.md'));
    assert.equal(only.status, 'blocked');
    assert.equal(t.governance.calls[1].details.runReport.outcome, 'blocked-only');
    assert.equal(t.show(only.branch, 'brain/wiki/only.md'), null, 'blocked means unwritten');
    await t.stop();
  });

  it('refuses a run that wrote outside brain/', async () => {
    const t = await setup({ mode: 'escape' });
    await t.app.start({ http: false });
    const done = await t.finished(await t.drop('x.md'));
    assert.equal(done.status, 'failed');
    assert.match(done.error, /outside the brain's writable paths: brain\.config\.yaml/);
    assert.equal(t.governance.calls.length, 0);
    await t.stop();
  });

  it('an unchanged outcome succeeds with no proposal and drops the empty branch', async () => {
    const t = await setup({ mode: 'unchanged' });
    await t.app.start({ http: false });
    const done = await t.finished(await t.drop('same.md'));
    assert.equal(done.status, 'succeeded');
    assert.equal(t.governance.calls.length, 0);
    assert.equal(t.git('branch', '--list', done.branch).trim(), '');
    await t.stop();
  });

  it('a missing run report fails the job after retries', async () => {
    const t = await setup({ mode: 'no-report' });
    await t.app.start({ http: false });
    const done = await t.finished(await t.drop('quiet.md'));
    assert.equal(done.status, 'failed');
    assert.match(done.error, /run-report\.json/);
    assert.equal(done.attempts, 2);
    await t.stop();
  });
});

describe('runner: drop-page', () => {
  it('removes a page created on the branch, cleans its references, re-audits and re-proposes', async () => {
    const t = await setup();
    await t.app.start({ http: false });
    const first = await t.finished(await t.drop('notes.md'));
    assert.equal(first.status, 'succeeded');

    const drop = await t.ctx.ingest.enqueue({ kind: 'drop-page', proposalId: first.proposalId, slug: 'notes', trigger: 'feedback', requestedBy: { id: 'usr_rev', display: 'Rev' } });
    const done = await t.finished(drop);
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(t.show(first.branch, 'brain/wiki/notes.md'), null);
    assert.ok(!t.show(first.branch, 'brain/index.md').includes('[[notes]]'));
    assert.ok(!/^\s*-\s*notes\s*$/m.test(t.show(first.branch, 'brain/manifest.yaml')));
    assert.match(t.git('log', '-1', '--format=%s', first.branch), /^drop-page: notes/);

    assert.equal(t.governance.calls.length, 2);
    assert.equal(t.governance.calls[1].details.branch, first.branch, 'governance upserts by branch');
    assert.equal(done.proposalId, first.proposalId);
    await t.stop();
  });

  it('restores a page that existed on main to its base version', async () => {
    const t = await setup();
    await t.app.start({ http: false });
    const first = await t.finished(await t.drop('notes.md'));
    // Simulate a revise that edited an existing page on the branch.
    const wt = first.worktree;
    const alpha = path.join(wt, 'brain', 'wiki', 'alpha.md');
    fs.writeFileSync(alpha, fs.readFileSync(alpha, 'utf-8').replace('fixed 30-second backoff', 'fixed 45-second backoff'));
    await t.ctx.git.run(['commit', '-qam', 'edit alpha'], { cwd: wt, env: { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t' } });

    const done = await t.finished(await t.ctx.ingest.enqueue({ kind: 'drop-page', proposalId: first.proposalId, slug: 'alpha', trigger: 'feedback', requestedBy: 'usr_rev' }));
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(t.show(first.branch, 'brain/wiki/alpha.md'), t.show('main', 'brain/wiki/alpha.md'));
    assert.ok(t.show(first.branch, 'brain/wiki/notes.md'), 'other pages on the branch are untouched');
    await t.stop();
  });
});

describe('runner: revise', () => {
  it('reuses the proposal branch and passes instructions to the driver', async () => {
    const t = await setup();
    await t.app.start({ http: false });
    const first = await t.finished(await t.drop('notes.md'));
    const done = await t.finished(await t.ctx.ingest.enqueue({ kind: 'revise', proposalId: first.proposalId, trigger: 'decision', instructions: 'Keep the existing claim.', requestedBy: 'usr_rev' }));
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(done.branch, first.branch);
    assert.match(t.show(first.branch, 'brain/log.md'), /Keep the existing claim/);
    assert.equal(t.git('rev-list', '--count', `main..${first.branch}`).trim(), '2');
    assert.equal(t.governance.calls.length, 2);
    await t.stop();
  });
});

describe('runner: other modules\' job shapes', () => {
  it('MCP submit_source: a local source under .almagest/submissions/, onBehalfOf recorded and co-authored', async () => {
    const t = await setup();
    const { sha256 } = await import('../../src/core/schemas.mjs');
    const text = 'Pasted into a chat: the gateway retries three times.\n';
    const sha = sha256(text);
    const file = t.write(`.almagest/submissions/gateway-notes-${sha.slice(0, 7)}.md`, text);
    await t.app.start({ http: false });
    const job = await t.ctx.ingest.enqueue({
      kind: 'ingest', trigger: 'mcp',
      source: { kind: 'local', id: 'gateway-notes', path: file, sha256: sha, title: 'Gateway notes' },
      requestedBy: 'agent:mcp:claude.ai', onBehalfOf: 'usr_ada',
    });
    assert.equal(job.onBehalfOf, 'usr_ada');
    assert.equal(job.source.id, 'gateway-notes');
    const done = await t.finished(job);
    assert.equal(done.status, 'succeeded', done.error);
    assert.equal(done.branch, `ingest/gateway-notes-${sha.slice(0, 7)}`);
    assert.ok(t.show(done.branch, `brain/raw/processed/gateway-notes-${sha.slice(0, 7)}.md`), 'copied into the worktree drop folder');
    assert.match(t.git('log', '-1', '--format=%B', done.branch), /Co-authored-by: usr_ada/);
    await t.stop();
  });

  it('a source-less reverify (WS5 auto_reverify): dedups on slug, runs on its own branch, no-op → no proposal', async () => {
    const t = await setup({ mode: 'unchanged' });
    const input = { kind: 'reverify', source: null, slug: 'alpha', trigger: 'demand', requestedBy: 'svc:telemetry', instructions: 'alpha is hot and 288 days unverified' };
    const a = await t.ctx.ingest.enqueue(input);
    const b = await t.ctx.ingest.enqueue(input);
    assert.equal(b.id, a.id);
    const beta = await t.ctx.ingest.enqueue({ ...input, slug: 'beta' });
    assert.notEqual(beta.id, a.id);
    await t.ctx.ingest.cancel(beta.id);
    await assert.rejects(() => t.ctx.ingest.enqueue({ ...input, slug: undefined }), /reverify needs/);

    const fin = t.finished(a);
    await t.app.start({ http: false });
    const done = await fin;
    assert.equal(done.status, 'succeeded', done.error);
    assert.match(done.branch, /^ingest\/reverify-alpha-[0-9a-f]{7}$/);
    assert.equal(t.governance.calls.length, 0);

    t.ctx.config.ingest.fake.mode = 'write';
    const again = await t.finished(await t.ctx.ingest.enqueue({ ...input, slug: 'gamma-claim' }));
    assert.equal(again.status, 'succeeded', again.error);
    assert.equal(t.governance.calls.length, 1, 'a reverify that changed something is proposed');
    await t.stop();
  });
});
