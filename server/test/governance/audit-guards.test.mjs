/**
 * The two audit checks that stop a page header or body from hiding things
 * from a reviewer: SCHEMA-006 (anchors, aliases and merge keys in the front
 * matter) and SCHEMA-007 (a body that ends inside a comment or a code fence).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bodyEndsOpen, frontmatterIndirection } from '../../../tools/lib/checks.mjs';

const page = (fm, body = '## Summary\n\nText.\n') => `---\n${fm}\n---\n\n${body}`;

describe('SCHEMA-006: front matter has no anchors, aliases or merge keys', () => {
  it('flags an anchor and an alias, from the raw text and from the parsed document', () => {
    const found = frontmatterIndirection(page('title: "X"\naliases:\n  - &t evidence\ntier: *t'));
    assert.ok(found.some((f) => /anchor/.test(f)), found.join('|'));
    assert.ok(found.some((f) => /alias/.test(f)), found.join('|'));
  });

  it('flags a merge key', () => {
    assert.ok(frontmatterIndirection(page('title: "X"\nbase: {a: 1}\nrest:\n  <<: {a: 2}')).length > 0);
  });

  it('flags flow forms and anchors on a mapping or list', () => {
    assert.ok(frontmatterIndirection(page('tags: [&a one, *a]')).length > 0);
    assert.ok(frontmatterIndirection(page('related: &r\n  - one\nother: *r')).length > 0);
  });

  it('flags a flow alias that the line-based reading would miss, after a tag', () => {
    assert.ok(frontmatterIndirection(page('a: &x !!str one\nb: *x')).length > 0);
  });

  it('is not fooled by a trailing comment hiding nothing, and still finds the alias', () => {
    assert.ok(frontmatterIndirection(page('a: &x one # note\nb: *x # note')).length > 0);
  });

  it('is quiet about a literal & or * inside quoted strings, plain text and block scalars', () => {
    const fm = [
      'title: "R&D *notes* &more"',
      "owner: 'a &b *c'",
      'type: topic',
      'summary: Tom & Jerry, 2*3 and R&D',
      'note: |',
      '  &anchor-looking *alias-looking',
      '  <<: not a key',
      'multi: "first line',
      '  *second &line"',
    ].join('\n');
    assert.deepEqual(frontmatterIndirection(page(fm)), []);
  });

  it('reads only the front matter: a body line with &x or *x is not a finding', () => {
    assert.deepEqual(frontmatterIndirection(page('title: "X"', '## S\n\n*emphasis* and &amp; and &x\n')), []);
  });
});

describe('SCHEMA-007: a body does not end inside a comment or a code fence', () => {
  it('flags an unclosed HTML comment and an unclosed fence', () => {
    assert.equal(bodyEndsOpen('## A\n\ntext\n<!--\n'), 'comment');
    assert.equal(bodyEndsOpen('## A\n\ntext <!-- start\nmore\n'), 'comment');
    assert.equal(bodyEndsOpen('## A\n\n```\ncode\n'), 'fence');
    assert.equal(bodyEndsOpen('## A\n\n~~~js\ncode\n'), 'fence');
  });

  it('accepts closed ones', () => {
    assert.equal(bodyEndsOpen('## A\n\n<!-- note -->\n\ntext\n'), null);
    assert.equal(bodyEndsOpen('## A\n\n<!--\nmultiline\n-->\ntext\n'), null);
    assert.equal(bodyEndsOpen('## A\n\n```\ncode\n```\n\ntext\n'), null);
    assert.equal(bodyEndsOpen('## A\n\n````\n```\nnested\n```\n````\n'), null);
  });

  it('closes a fence only with the same character and at least the same length', () => {
    assert.equal(bodyEndsOpen('````\ncode\n```\n'), 'fence');
    assert.equal(bodyEndsOpen('```\ncode\n~~~\n'), 'fence');
    assert.equal(bodyEndsOpen('~~~\ncode\n```\n'), 'fence');
    assert.equal(bodyEndsOpen('```\ncode\n````\n'), null);
    assert.equal(bodyEndsOpen('```\ncode\n```   \n'), null);
  });

  it('a closing fence takes no text after it, and four spaces of indent is content, not a fence', () => {
    assert.equal(bodyEndsOpen('```\ncode\n``` more\n'), 'fence');
    assert.equal(bodyEndsOpen('```\ncode\n    ```\n'), 'fence');
    assert.equal(bodyEndsOpen('```\ncode\n   ```\n'), null);
  });

  it('indented code and inline code are not fences', () => {
    assert.equal(bodyEndsOpen('## A\n\n    ```\n    indented code\n'), null);
    assert.equal(bodyEndsOpen('Use ```code``` inline.\n'), null);
    assert.equal(bodyEndsOpen('Use `<!--` in a sentence.\n'), null);
    assert.equal(bodyEndsOpen('Use ``a ` b <!-- c`` here.\n'), null);
  });

  it('a comment marker inside a fence, and a fence marker inside a comment, do not count', () => {
    assert.equal(bodyEndsOpen('```\n<!--\n```\n'), null);
    assert.equal(bodyEndsOpen('<!--\n```\n-->\n'), null);
    assert.equal(bodyEndsOpen('<!-- a -->\n<!-- b\n'), 'comment');
  });

  it('is quiet on an empty body and on CRLF text', () => {
    assert.equal(bodyEndsOpen(''), null);
    assert.equal(bodyEndsOpen('```\r\ncode\r\n```\r\n'), null);
  });
});
