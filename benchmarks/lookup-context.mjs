#!/usr/bin/env node
/**
 * benchmarks/lookup-context.mjs — how much context does live lookup hand a chat,
 * compared with handing it the whole source document?
 *
 *   node benchmarks/lookup-context.mjs          table and summary
 *   node benchmarks/lookup-context.mjs --json   the same, as JSON
 *
 * No model calls, no network, no cost. For each question in questions.yaml that
 * has expected_sources (the questions the fixture documents can answer):
 *
 *   whole documents  the full text of every file in expected_sources, counted
 *                    with estimateTokens (characters / 4, rounded up)
 *   lookup           buildPassageIndex over ALL five fixture documents,
 *                    searchPassages with the question text, packPassages at the
 *                    default ask.token_budget; the packed token count
 *
 * Both columns use the same ruler. "Answer present" is a mechanical string test:
 * every must_contain literal in questions.yaml appears (ignoring case) in the
 * packed passage text. Where must_contain is empty the cell says "not checked".
 * Questions with no expected_sources (the unanswerable ones) are not measured.
 *
 * How the fixtures are fed to the passage module: the fixtures are Markdown, and
 * real sidecars and snapshots carry locator markers. So each Markdown heading
 * line becomes a "=== section: <heading> ===" marker before indexing. Pass
 * --no-markers to index the text as it is (one block cut at 1500 characters).
 *
 * LIMITS. Read these before quoting a number.
 *   - This measures context size, on a small fictional corpus, with an
 *     estimator. It does not measure answer quality, and it says nothing about
 *     cost in dollars.
 *   - Whole-document tokens are a floor for what a chat carries. A chat talking
 *     to a provider directly also carries tool definitions and search results,
 *     which would make the whole-document case larger.
 *   - Real documents are longer than these five fixtures, so the gap here is
 *     probably smaller than the gap on real material.
 *   - A must_contain literal found in the passages is a recall floor. Short
 *     literals such as "5" or "50" can match by accident.
 *   - It does not drive createLookup, which needs a full app, a repo and a
 *     manifest. It calls the passage functions directly, the same ones the
 *     sources step uses.
 *
 * Exit status: 0 when every question was measured, 1 when one could not be
 * (a missing source file or an unreadable questions file), 2 on a tool error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { estimateTokens } from '../server/src/mcp/search.mjs';
import { buildPassageIndex, packPassages, searchPassages } from '../server/src/mcp/passages.mjs';
import { MCP_DEFAULTS } from '../server/src/mcp/config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAW_DIR = path.join(HERE, 'fixtures', 'raw');
const QUESTIONS = path.join(HERE, 'questions.yaml');

/** Parse the restricted YAML subset questions.yaml promises: quoted scalars and inline lists, one per line. */
export function parseQuestions(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text).split('\n')) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;
    const start = raw.match(/^  - id:\s*(".*")\s*$/);
    if (start) { cur = { id: JSON.parse(start[1]) }; out.push(cur); continue; }
    const field = raw.match(/^    ([a-z_]+):\s*(.*?)\s*$/);
    if (field && cur) {
      try { cur[field[1]] = JSON.parse(field[2]); }
      catch { throw new Error(`question ${cur.id}: cannot parse field ${field[1]}`); }
    }
  }
  return out;
}

/** Turn Markdown heading lines into the section markers sidecars carry. */
export function addMarkers(text) {
  return String(text).replace(/\r\n?/g, '\n').split('\n')
    .map((line) => {
      const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
      return h ? `=== section: ${h[1]} ===` : line;
    })
    .join('\n');
}

/** Case-insensitive: does every literal appear in the text? null when there is nothing to check. */
export function answerPresent(mustContain, text) {
  if (!Array.isArray(mustContain) || !mustContain.length) return null;
  const hay = String(text).toLowerCase();
  return mustContain.every((s) => hay.includes(String(s).toLowerCase()));
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function loadCorpus({ rawDir = RAW_DIR, markers = true } = {}) {
  const docs = [];
  const raw = new Map();
  for (const f of fs.readdirSync(rawDir).filter((n) => n.endsWith('.md')).sort()) {
    const text = fs.readFileSync(path.join(rawDir, f), 'utf8');
    raw.set(f, text);
    const title = (text.match(/^#\s+(.+)$/m) || [])[1] || f;
    docs.push({ key: f, title, text: markers ? addMarkers(text) : text });
  }
  return { docs, raw };
}

export function measure(questions, { rawDir = RAW_DIR, markers = true, budget = MCP_DEFAULTS.ask.token_budget } = {}) {
  const { docs, raw } = loadCorpus({ rawDir, markers });
  const index = buildPassageIndex(docs);
  const rows = [];
  const problems = [];
  for (const q of questions) {
    const sources = q.expected_sources || [];
    if (!sources.length) continue;                        // not answerable from the fixtures
    const missing = sources.filter((f) => !raw.has(f));
    if (missing.length) { problems.push(`${q.id}: expected source not found: ${missing.join(', ')}`); continue; }
    if (!q.question) { problems.push(`${q.id}: no question text`); continue; }

    const whole = sources.reduce((n, f) => n + estimateTokens(raw.get(f)), 0);
    const found = searchPassages(index, q.question);
    const packed = packPassages(found.results, budget);
    const packedText = packed.items.flatMap((i) => i.passages.map((p) => p.text)).join('\n');
    const passages = packed.items.reduce((n, i) => n + i.passages.length, 0);
    rows.push({
      id: q.id,
      category: q.category,
      wholeTokens: whole,
      lookupTokens: packed.tokens,
      ratio: whole ? packed.tokens / whole : null,
      passages,
      found: passages > 0,
      answered: found.answered,
      present: answerPresent(q.must_contain, packedText),
    });
  }
  return { rows, problems, budget };
}

export function summarise(rows) {
  const whole = rows.map((r) => r.wholeTokens);
  const lookup = rows.map((r) => r.lookupTokens);
  const checkable = rows.filter((r) => r.present !== null);
  return {
    questions: rows.length,
    wholeMedian: median(whole), wholeMean: mean(whole),
    lookupMedian: median(lookup), lookupMean: mean(lookup),
    medianRatio: median(rows.map((r) => r.ratio).filter((x) => x !== null)),
    foundPassage: rows.filter((r) => r.found).length,
    checkable: checkable.length,
    answerPresent: checkable.filter((r) => r.present).length,
  };
}

const LIMITS = [
  'Limits: this measures context size on a small fictional corpus (five documents) with a',
  'characters/4 estimator. It is no measure of answer quality or of cost in dollars. It leaves out',
  'the tool definitions and search results a chat also carries when it talks to a provider',
  'directly, which would make the whole-document case larger. Real documents are longer than',
  'these fixtures. "Answer present" only checks that the must_contain strings from',
  'questions.yaml appear in the packed text; short strings can match by accident.',
];

function render({ rows, problems, budget }, summary, markers) {
  const f1 = (x) => (x === null ? '-' : (Math.round(x * 10) / 10).toString());
  const lines = [];
  lines.push(`Live lookup context size (budget ${budget} tokens, ${markers ? 'headings as section markers' : 'no markers'})`);
  lines.push('Whole documents = full text of the expected_sources in questions.yaml for each question.');
  lines.push('');
  const head = ['id', 'whole-doc tokens', 'lookup tokens', 'ratio', 'answer present'];
  const body = rows.map((r) => [r.id, String(r.wholeTokens), String(r.lookupTokens), r.ratio === null ? '-' : r.ratio.toFixed(2),
    r.present === null ? 'not checked' : r.present ? 'yes' : 'no']);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const fmt = (cells) => cells.map((c, i) => (i === 0 || i === 4 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  lines.push(fmt(head).trimEnd(), w.map((n) => '-'.repeat(n)).join('  '), ...body.map((b) => fmt(b).trimEnd()), '');
  lines.push('Summary');
  lines.push(`  questions measured        ${summary.questions}`);
  lines.push(`  whole-doc tokens          median ${f1(summary.wholeMedian)}, mean ${f1(summary.wholeMean)}`);
  lines.push(`  lookup tokens             median ${f1(summary.lookupMedian)}, mean ${f1(summary.lookupMean)}`);
  lines.push(`  median ratio              ${summary.medianRatio === null ? '-' : summary.medianRatio.toFixed(2)}`);
  lines.push(`  lookup found a passage    ${summary.foundPassage} of ${summary.questions}`);
  lines.push(`  answer present            ${summary.answerPresent} of ${summary.checkable} checkable`);
  lines.push('');
  lines.push(...LIMITS);
  if (problems.length) lines.push('', 'Could not measure:', ...problems.map((p) => `  ${p}`));
  return lines.join('\n');
}

function main(argv) {
  const markers = !argv.includes('--no-markers');
  const questions = parseQuestions(fs.readFileSync(QUESTIONS, 'utf8'));
  const result = measure(questions, { markers });
  if (!result.rows.length && !result.problems.length) result.problems.push('no question had expected_sources');
  const summary = summarise(result.rows);
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ budget: result.budget, markers, rows: result.rows, summary, limits: LIMITS.join(' '), problems: result.problems }, null, 2));
  } else {
    console.log(render(result, summary, markers));
  }
  return result.problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { console.error(`lookup-context: ${e.message}`); process.exitCode = 2; }
}
