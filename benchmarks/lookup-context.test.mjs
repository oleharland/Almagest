// Tests for the pure parts of lookup-context.mjs. Run: node --test benchmarks/lookup-context.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { addMarkers, answerPresent, mean, median, measure, parseQuestions } from './lookup-context.mjs';

describe('lookup-context', () => {
  it('parses the questions.yaml subset', () => {
    const q = parseQuestions('questions:\n  # c\n  - id: "a"\n    question: "Why \\"x\\"?"\n    expected_sources: ["f.md"]\n    must_contain: []\n');
    assert.deepEqual(q, [{ id: 'a', question: 'Why "x"?', expected_sources: ['f.md'], must_contain: [] }]);
  });
  it('turns headings into section markers', () => {
    assert.equal(addMarkers('# T\nbody\n## §2 Scope\nx'), '=== section: T ===\nbody\n=== section: §2 Scope ===\nx');
  });
  it('checks must_contain ignoring case, and leaves empty lists unchecked', () => {
    assert.equal(answerPresent(['Q3 2029'], 'due q3 2029'), true);
    assert.equal(answerPresent(['a', 'b'], 'a only'), false);
    assert.equal(answerPresent([], 'a'), null);
  });
  it('median and mean', () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(mean([1, 2, 3]), 2);
    assert.equal(median([]), null);
  });
  it('reports a missing expected source instead of skipping it', () => {
    const r = measure([{ id: 'z', question: 'anything', expected_sources: ['nope.md'] }]);
    assert.equal(r.rows.length, 0);
    assert.equal(r.problems.length, 1);
  });
});
