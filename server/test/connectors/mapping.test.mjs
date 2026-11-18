import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { globToRegExp, mapField, matchesGlob, parsePath, renderArgs, renderTemplate, select, selectAll, templateVars } from '../../src/connectors/mapping.mjs';

const doc = {
  issues: [
    { id: 'a', title: 'First', meta: { updatedAt: '2026-01-02' }, tags: ['x', 'y'] },
    { id: 'b', name: 'Second', meta: {} },
  ],
  page: { 'next cursor': 'c2' },
};

describe('path evaluator', () => {
  it('walks dot paths, indexes, quoted keys and the root', () => {
    assert.equal(select(doc, 'issues[0].title'), 'First');
    assert.equal(select(doc, '$.issues[1].id'), 'b');
    assert.equal(select(doc, 'issues[-1].id'), 'b');
    assert.equal(select(doc, 'page["next cursor"]'), 'c2');
    assert.equal(select(doc, '$'), doc);
    assert.equal(select(doc, 'issues[5].id'), undefined);
  });

  it('fans out on [*] and flattens', () => {
    assert.deepEqual(selectAll(doc, 'issues[*].id'), ['a', 'b']);
    assert.deepEqual(selectAll(doc, 'issues[*].tags[*]'), ['x', 'y']);
    assert.deepEqual(selectAll([1, 2], '$[*]'), [1, 2]);
  });

  it('takes the first alternative that yields anything', () => {
    assert.equal(select(doc.issues[1], 'title | name'), 'Second');
    assert.equal(select(doc.issues[0], 'meta.updatedAt | updated_at'), '2026-01-02');
    assert.deepEqual(selectAll(doc, 'missing[*] | issues[*].id'), ['a', 'b']);
  });

  it('never reaches the prototype chain', () => {
    assert.equal(select({}, '__proto__'), undefined);
    assert.equal(select({}, 'constructor'), undefined);
    assert.equal(select({ a: {} }, 'a.constructor.prototype'), undefined);
    assert.equal(select({ a: 1 }, 'toString'), undefined);
  });

  it('rejects malformed paths', () => {
    assert.throws(() => parsePath('a[b'), /unclosed/);
    assert.throws(() => parsePath('a[x y]'), /bad path segment/);
  });
});

describe('templates', () => {
  const vars = { since: '2026-01-05T10:00:00Z', select: { repo: 'acme/docs', paths: ['a/**'], n: '' }, item: { ref: 'r1' } };

  it('keeps the value type for a whole-string template', () => {
    assert.deepEqual(renderTemplate('{{select.paths}}', vars), ['a/**']);
    assert.equal(renderTemplate('{{select.missing}}', vars), undefined);
  });

  it('interpolates and applies filters', () => {
    assert.equal(renderTemplate('{{select.repo | before:/}}', vars), 'acme');
    assert.equal(renderTemplate('{{select.repo | after:/}}', vars), 'docs');
    assert.equal(renderTemplate('x/{{item.ref}}/{{nope}}', vars), 'x/r1/');
    assert.equal(renderTemplate('{{since | date}}', vars), '2026-01-05');
    assert.equal(renderTemplate('{{select.n | default:owner = me}}', vars), 'owner = me');
    assert.equal(renderTemplate('{{select.n | default:200}}', vars), 200);
    assert.equal(renderTemplate('{{raw | attr:id}}', { raw: ' title="t" id="m-1" data-id="no"' }), 'm-1');
    assert.equal(renderTemplate('{{p | mime}}', { p: 'docs/x.MD' }), 'text/markdown');
    assert.throws(() => renderTemplate('{{since | exec}}', vars), /unknown template filter/);
  });

  it('drops args that render empty, so optional arguments vanish', () => {
    const args = renderArgs({ updatedAt: '{{since}}', cursor: '{{cursor}}', limit: 50, ids: ['{{item.ref}}'], nested: { a: '{{nope}}' } }, vars);
    assert.deepEqual(args, { updatedAt: vars.since, limit: 50, ids: ['r1'], nested: {} });
  });

  it('reports which variables a tree uses', () => {
    assert.deepEqual([...templateVars({ a: '{{since | date}}', b: ['{{cursor}}'] })].sort(), ['cursor', 'since']);
  });

  it('maps a field by path, or by template with raw in scope', () => {
    assert.equal(mapField('meta.updatedAt', doc.issues[0], {}), '2026-01-02');
    assert.equal(mapField('{{select.repo}}/{{raw.id}}', doc.issues[0], vars), 'acme/docs/a');
  });
});

describe('globs', () => {
  it('** crosses directories, * does not, and regex syntax is literal', () => {
    assert.ok(matchesGlob('docs/a/b.md', 'docs/**/*.md'));
    assert.ok(matchesGlob('docs/b.md', 'docs/**/*.md'));
    assert.ok(!matchesGlob('docs/a/b.md', 'docs/*.md'));
    assert.ok(matchesGlob('anything', []));
    assert.ok(!globToRegExp('a.(b)').test('axxb'));
    assert.ok(globToRegExp('a.(b)').test('a.(b)'));
  });
});
