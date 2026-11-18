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

describe('SCHEMA-006: decided from the parsed YAML, not from the look of a line', () => {
  it('is quiet about a * or & that starts a continuation line of a plain scalar', () => {
    const fm = [
      'title: "X"',
      'summary: this value runs on',
      '  *over a second line',
      '  &and a third',
      'tags:',
      '  - first item that runs on',
      '    *and keeps going',
      '    &and going',
    ].join('\n');
    assert.deepEqual(frontmatterIndirection(page(fm)), []);
  });

  it('is quiet about a quoted multi-line value and a folded block that start lines with * or &', () => {
    const fm = ['title: "X"', 'a: "one', '  *two', '  &three"', 'b: >-', '  *four', '  &five', 'c: \'six', '  *seven\''].join('\n');
    assert.deepEqual(frontmatterIndirection(page(fm)), []);
  });

  it('still flags a real alias and anchor next to such a value, with their line', () => {
    const fm = ['title: "X"', 'summary: runs on', '  *over', 'tier: &t evidence', 'other: *t'].join('\n');
    const found = frontmatterIndirection(page(fm));
    assert.ok(found.some((f) => /anchor \(&t\) on line 4/.test(f)), found.join('|'));
    assert.ok(found.some((f) => /alias/.test(f) && /line 5/.test(f)), found.join('|'));
    assert.ok(!found.some((f) => /line 3/.test(f)), 'the continuation line is not a finding');
  });

  it('falls back to the raw text only for a header that does not parse', () => {
    const found = frontmatterIndirection(page('title: "X"\ntags: [one\ntier: *t'));
    assert.ok(found.length > 0, 'the unparsable header still shows the alias');
  });

  it('flags an anchor on a mapping, a sequence, a key and a merge key, and an alias to none', () => {
    for (const fm of ['a: &m {x: 1}\nb: *m', 'a: &l [1]\nb: *l', '&k key: 1', 'a: {x: 1}\nb:\n  <<: *a', 'tier: *nothing']) {
      assert.ok(frontmatterIndirection(page(fm)).length > 0, fm);
    }
  });
});

describe('SCHEMA-007: inline text starts no block', () => {
  it('a <!-- inside a code span that crosses a line break is code, not a comment', () => {
    assert.equal(bodyEndsOpen('Text `code <!--\nmore code` end.\n'), null);
    assert.equal(bodyEndsOpen('Text `code\nmore <!-- code` end.\n'), null);
    assert.equal(bodyEndsOpen('Text ``code ` <!--\nmore`` end.\n'), null);
  });

  it('a <!-- in the middle of a line is literal text, closed or not, whatever the backticks around it', () => {
    assert.equal(bodyEndsOpen('Text `code\n\nmore <!-- code` end.\n'), null);
    assert.equal(bodyEndsOpen('Text `code <!-- more`` end.\n'), null);
    assert.equal(bodyEndsOpen('Use `x` then <!-- never closed\n'), null);
    assert.equal(bodyEndsOpen('Use `x\ny` then <!-- never closed\n'), null);
  });

  it('a line that starts with <!-- starts a comment block, even inside what looks like a code span', () => {
    assert.equal(bodyEndsOpen('Text `code\n<!-- more` end.\n'), 'comment');
  });

  it('a <!-- inside a closed fenced block is never open, with either fence character', () => {
    assert.equal(bodyEndsOpen('```md\n<!-- not a comment\n```\n\ntext\n'), null);
    assert.equal(bodyEndsOpen('~~~\n<!--\n~~~\n'), null);
    assert.equal(bodyEndsOpen('````\n```\n<!--\n```\n````\n'), null);
  });

  it('an unclosed fence after a multi-line span is still caught', () => {
    assert.equal(bodyEndsOpen('Text `a\nb` end.\n\n```\ncode\n'), 'fence');
  });
});

describe('SCHEMA-007: CommonMark block rules, no false positives', () => {
  it('indented code that holds <!-- or a fence is never scanned', () => {
    assert.equal(bodyEndsOpen('## A\n\nExample:\n\n    <!-- this is code\n\nAfter.\n'), null);
    assert.equal(bodyEndsOpen('## A\n\n- item\n  - sub\n\n        <!-- in code\n'), null);
    assert.equal(bodyEndsOpen('## A\n\n    ```\n    code\n'), null);
    assert.equal(bodyEndsOpen('## A\n\n\t<!-- tab indented code\n'), null);
  });
  it('<!-- in the middle of a line of prose starts no block', () => {
    assert.equal(bodyEndsOpen('## A\n\nUse the `<!--` marker or <!-- in prose.\n'), null);
    assert.equal(bodyEndsOpen('## A\n\ntext <!-- start\nmore\n'), null);
  });
  it('a fence in a list item or a blockquote ends with its container', () => {
    assert.equal(bodyEndsOpen('## A\n\n- item\n\n  ```\n  code\n'), null);
    assert.equal(bodyEndsOpen('## A\n\n> ```\n> code\n'), null);
    assert.equal(bodyEndsOpen('## A\n\n1. step\n\n   ~~~\n   code\n'), null);
    assert.equal(bodyEndsOpen('## A\n\n> <!--\n> note\n'), null);
    assert.equal(bodyEndsOpen('- item\n  <!-- note\n'), null);
  });
  it('a block that starts at the top level, and in a container that has not ended, is still open', () => {
    assert.equal(bodyEndsOpen('## A\n\n   ```\n   code\n'), 'fence');
    assert.equal(bodyEndsOpen('## A\n\ntext\n<!--\n'), 'comment');
    assert.equal(bodyEndsOpen('## A\n\n   <!-- three spaces\n'), 'comment');
    assert.equal(bodyEndsOpen('## A\n\n- item\n\n  ```\n  code\n\n  more\n  ```\n\ntext\n'), null);
  });
  it('a closed fence in a list item does not hide an open one after it', () => {
    assert.equal(bodyEndsOpen('- item\n\n  ```\n  code\n  ```\n\n```\nopen\n'), 'fence');
  });
});

describe('SCHEMA-007: HTML blocks of types 1 to 5 stay open to their end condition', () => {
  const open = {
    script: '## A\n\nText.\n\n<script type="text/plain">\n',
    scriptUpper: '## A\n\n<SCRIPT>\n',
    pre: '## A\n\n<pre>\ncode\n',
    style: '## A\n\nText.\n\n<style>\n',
    textarea: '## A\n\n<textarea>\n',
    pi: '## A\n\nText.\n\n<?x\n',
    declaration: '## A\n\n<!DOCTYPE html\n',
    cdata: '## A\n\nText.\n\n<![CDATA[\n',
    interrupting: '## A\n\ntext\n<script>\n',
    blankLinesInside: '## A\n\n<style>\n\n\nbody { color: red }\n\n',
  };
  for (const [name, body] of Object.entries(open)) {
    it(`${name} is open`, () => assert.equal(bodyEndsOpen(body), 'html', body));
  }
  it('is closed by its end condition, on the same line or a later one', () => {
    for (const body of [
      '<script>x</script>\n', '<script>\nx\n</script>\n\ntext\n', '<pre>\ncode\n</pre>\n', '<style>\na{}\n</style>\n',
      '<textarea>\nx\n</textarea>\n', '<?php x ?>\n', '<?\nx\n?>\n', '<!DOCTYPE html>\n', '<!ELEMENT a\n>\n',
      '<![CDATA[ x ]]>\n', '<![CDATA[\nx\n]]>\n', '<script>x</SCRIPT>\n',
    ]) assert.equal(bodyEndsOpen(`## A\n\n${body}`), null, body);
  });
  it('a start in prose, in a code span, in indented code or in a fence is not a start', () => {
    for (const body of ['Use <script> in prose.\n', 'Use `<pre>` here.\n', '    <script>\n', '```\n<script>\n```\n', '<scripts>\n', '<prefix>\n', '<!-- <script> -->\n']) {
      assert.equal(bodyEndsOpen(`## A\n\n${body}`), null, body);
    }
  });
  it('types 6 and 7 end at a blank line and are not reported', () => {
    assert.equal(bodyEndsOpen('## A\n\n<details>\n'), null);
    assert.equal(bodyEndsOpen('## A\n\n<div hidden>\n'), null);
  });
});
