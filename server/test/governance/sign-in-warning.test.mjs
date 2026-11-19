/**
 * The "nobody can sign in to the review inbox" warning is about the inbox, so
 * it is logged only by a server that serves HTTP. A command that never listens
 * (synthesize, mcp, doctor) must not print it.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { cleanup, govApp, repo } from './fixtures.mjs';

const WARNING = 'nobody can sign in to the review inbox';
const ENV_KEYS = ['ALMAGEST_TOKENS', 'ALMAGEST_LOGINS', 'ALMAGEST_SECRET_KEY'];
const saved = {};

before(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.ALMAGEST_TOKENS = 'ada:owner:ada-api-1';
  process.env.ALMAGEST_SECRET_KEY = 'k';
  delete process.env.ALMAGEST_LOGINS;   // nobody has a sign-in secret
});
after(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  cleanup();
});

const warned = (app) => JSON.stringify(app.log.lines).includes(WARNING);

describe('sign-in warning follows the inbox, not the constructor', () => {
  it('is logged when the server starts listening', async () => {
    const app = await govApp(repo());
    try {
      assert.equal(warned(app), false, 'not logged while the app is only constructed');
      await app.start({ background: false });
      assert.equal(warned(app), true);
    } finally { await app.stop(); }
  });

  it('is absent for a command that does not serve HTTP', async () => {
    const app = await govApp(repo());
    try {
      await app.start({ http: false, background: false });
      assert.equal(warned(app), false);
    } finally { await app.stop(); }
  });

  it('is absent when serving and someone can sign in', async () => {
    process.env.ALMAGEST_LOGINS = 'ada:ada-signin-1';
    const app = await govApp(repo());
    try {
      await app.start({ background: false });
      assert.equal(warned(app), false);
    } finally {
      await app.stop();
      delete process.env.ALMAGEST_LOGINS;
    }
  });
});
