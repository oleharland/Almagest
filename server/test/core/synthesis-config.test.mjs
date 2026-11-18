import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { loadServiceConfig } from '../../src/core/config.mjs';
import { JOB_KINDS, JOB_TRIGGERS, learningsBranch } from '../../src/core/schemas.mjs';
import { synthesisSettings } from '../../src/governance/learnings.mjs';
import { makeTempRepo, rmrf } from '../helpers.mjs';

const repos = [];
after(() => repos.forEach(rmrf));
const load = (overrides) => {
  const r = makeTempRepo();
  repos.push(r);
  return loadServiceConfig(r, { overrides });
};

describe('synthesis: config and vocabulary', () => {
  it('is on by default, with the documented bounds', () => {
    assert.deepEqual(load().synthesis, { enabled: true, min_changed_pages: 5, max_runs_per_day: 1, max_claims: 5, schedule: '' });
  });

  it('takes overrides key by key', () => {
    const c = load({ synthesis: { enabled: false, max_claims: 2 } });
    assert.equal(c.synthesis.enabled, false);
    assert.equal(c.synthesis.max_claims, 2);
    assert.equal(c.synthesis.min_changed_pages, 5);
  });

  it('settings are checked: a bad number falls back, only true switches it on', () => {
    const s = synthesisSettings({ synthesis: { enabled: 'yes', min_changed_pages: 'many', max_runs_per_day: -1, max_claims: 0, schedule: ' 0 * * * * ' } });
    assert.deepEqual(s, { enabled: false, minChangedPages: 5, maxRunsPerDay: 1, maxClaims: 0, schedule: '0 * * * *' });
  });

  it('adds the job kind and the trigger', () => {
    assert.ok(JOB_KINDS.includes('synthesize'));
    assert.ok(JOB_TRIGGERS.includes('synthesis'));
  });

  it('names the branch ingest/learnings-<sha7>', () => {
    assert.equal(learningsBranch('0123456789abcdef'), 'ingest/learnings-0123456');
    assert.match(learningsBranch('0123456789abcdef', { unique: true }), /^ingest\/learnings-[0-9a-f]{7}$/);
    assert.notEqual(learningsBranch('0123456789abcdef', { unique: true }), 'ingest/learnings-0123456');
  });
});
