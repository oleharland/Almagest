/**
 * The gaps page: a gap the wiki can now answer sits under "Probably answered
 * since", with one line that links to the page in the inbox. Titles are data,
 * so a hostile title is escaped.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gapsPage } from '../../src/governance/web/views.mjs';

const gap = (over) => ({
  cluster: 'gap_1', representative: 'what is almagest', queries: [{ text: 'what is almagest', count: 1 }], tokens: [],
  count: 1, distinctSessions: 1, lastSeen: '2026-11-17T10:00:00.000Z', lookup: null, suggestion: 'consider submitting a source.', ...over,
});
const page = (items) => gapsPage({ items, actor: null, csrf: 'c', nonce: 'n', now: Date.parse('2026-11-18T10:00:00.000Z') }).toString();

describe('gaps page: covered gaps', () => {
  it('shows a covered gap under "Probably answered since", with a line that links to its inbox entry', () => {
    const html = page([
      gap({ coveredBy: [{ slug: 'almagest', title: 'Almagest' }] }),
      gap({ cluster: 'gap_2', representative: 'battery warranty terms', queries: [], tokens: ['battery'] }),
    ]);
    assert.match(html, /<h3>Probably answered since<\/h3>/);
    assert.match(html, /The wiki can probably answer this now: <a href="\/inbox\/pages\/almagest">Almagest<\/a>/);
    assert.ok(html.indexOf('Probably answered since') > html.indexOf('battery warranty terms'), 'after the open table');
  });

  it('keeps open gaps in the main table, with no covered heading when nothing is covered', () => {
    const html = page([gap()]);
    assert.ok(!html.includes('Probably answered since'));
    assert.ok(!html.includes('The wiki can probably answer this now'));
    assert.match(html, /Suggestion: consider submitting a source/);
  });

  it('escapes a hostile title and slug', () => {
    const html = page([gap({ coveredBy: [{ slug: 'x"><script>alert(1)</script>', title: '<img src=x onerror=alert(1)>' }] })]);
    assert.ok(!html.includes('<img src=x'), 'title is escaped');
    assert.ok(!html.includes('<script>alert(1)'), 'slug is escaped');
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });
});
