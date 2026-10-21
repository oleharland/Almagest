import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { doctor } from '../../bin/almagest.mjs';
import { installHooks } from '../../../tools/lib/git-hooks.mjs';
import { git, makeTempRepo, REPO_ROOT, rmrf } from '../helpers.mjs';

const repos = [];
after(() => repos.forEach(rmrf));

/** A temp repo whose config skips the claude CLI probe, plus extra YAML appended. */
function repo(extraYaml = '') {
  const r = makeTempRepo();
  repos.push(r);
  fs.appendFileSync(path.join(r, 'brain.config.yaml'), `\ningest:\n  driver: fake\n${extraYaml}`);
  return r;
}

const READY_ENV = { ALMAGEST_SECRET_KEY: 'k', ALMAGEST_TOKENS: 'ada:owner:s3cret' };

async function run(r, deps = {}) {
  const lines = [];
  const code = await doctor(r, undefined, { env: READY_ENV, out: (l) => lines.push(l), ...deps });
  return { code, lines, line: (label) => lines.find((l) => l.slice(2).startsWith(`${label}:`)) || '' };
}

describe('doctor', () => {
  it('passes a ready repo and only warns about core.hooksPath', async () => {
    const r = repo();
    const unset = await run(r);
    assert.equal(unset.code, 0, unset.lines.join('\n'));
    assert.match(unset.line('git hooks'), /^! git hooks: core\.hooksPath is not set — run `node server\/bin\/almagest\.mjs hooks install`/);
    assert.match(unset.line('main branch'), /^✓ main branch: main/);

    // Pointing git at the working tree's tools/hooks — the old instruction — is not installed:
    // a checkout replaces those files.
    fs.cpSync(path.join(REPO_ROOT, 'tools', 'hooks'), path.join(r, 'tools', 'hooks'), { recursive: true });
    git(r, 'add', '-A');
    git(r, 'commit', '-qm', 'hooks', '--no-verify');
    git(r, 'config', 'core.hooksPath', path.join(fs.realpathSync(r), 'tools', 'hooks'));
    assert.match((await run(r)).line('git hooks'), /^! git hooks: core\.hooksPath is .*tools\/hooks, not .*\.git\/almagest\/hooks — run `node server\/bin\/almagest\.mjs hooks install`/);

    installHooks(r);
    assert.match((await run(r)).line('git hooks'), /^✓ git hooks: .*\.git\/almagest\/hooks$/);

    fs.appendFileSync(path.join(r, 'tools', 'hooks', 'pre-commit'), '# changed on main\n');
    git(r, 'commit', '-qam', 'hook change', '--no-verify');
    const outdated = await run(r);
    assert.equal(outdated.code, 0, 'a warning, not a failure');
    assert.match(outdated.line('git hooks'), /^! git hooks: pre-commit is outdated .*hooks install/);
  });

  it('does not count API tokens as sign-ins', async () => {
    const r = repo();
    const none = await run(r, { env: { ALMAGEST_TOKENS: 'ada:owner:s3cret' } });
    assert.equal(none.code, 1);
    assert.match(none.line('sign-in'), /^✗ sign-in: no usable entry in ALMAGEST_LOGINS/);

    const link = await run(r);
    assert.match(link.line('sign-in'), /^✓ sign-in: .*almagest\.mjs login <name>/);

    const reused = await run(r, { env: { ...READY_ENV, ALMAGEST_LOGINS: 'ada:s3cret' } });
    assert.ok(reused.lines.some((l) => /^! sign-in: .*also an API token/.test(l)), reused.lines.join('\n'));

    const ok = await run(r, { env: { ...READY_ENV, ALMAGEST_LOGINS: 'ada:other-secret' } });
    assert.match(ok.line('sign-in'), /^✓ sign-in: 1 sign-in secret\(s\) in ALMAGEST_LOGINS/);
  });

  it('fails when there is no local main, and prints the fix', async () => {
    const r = repo();
    git(r, 'branch', '-m', 'main', 'trunk');
    const res = await run(r);
    assert.equal(res.code, 1);
    assert.match(res.line('main branch'), /^✗ main branch: no local branch "main".*git branch main origin\/main/);
  });

  it('fails enterprise with a non-OIDC provider as its own check', async () => {
    const r = repo('service:\n  profile: enterprise\n  store: { driver: sqlite }\n  auth: { provider: token }\n');
    const res = await run(r);
    assert.equal(res.code, 1);
    assert.match(res.line('config'), /^✓ config: profile enterprise/);
    assert.match(res.line('profile'), /^✗ profile: service\.profile: enterprise requires service\.auth\.provider: oidc/);
  });

  it('fails a postgres store when pg cannot be imported', async () => {
    const r = repo('service:\n  store: { driver: postgres, url: "postgres://x" }\n');
    const missing = await run(r, { importPg: async () => { throw new Error('Cannot find package'); } });
    assert.equal(missing.code, 1);
    assert.match(missing.line('store'), /^✗ store: .*optional `pg` dependency/);
    const present = await run(r, { importPg: async () => ({}) });
    assert.match(present.line('store'), /^✓ store: postgres/);
    assert.equal(present.code, 0, present.lines.join('\n'));
  });

  it('warns, without failing, on the singular oidc default_role', async () => {
    const r = repo('service:\n  auth:\n    provider: oidc\n    oidc: { issuer: "https://idp", client_id: "c", default_role: viewer }\n');
    const res = await run(r);
    assert.equal(res.code, 0, res.lines.join('\n'));
    assert.ok(res.lines.some((l) => /^! config: service\.auth\.oidc\.default_role is deprecated/.test(l)));
  });
});
