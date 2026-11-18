/**
 * diff.mjs — a page's diff, parsed for the review page.
 *
 * Input is the plain text of `git diff --no-color --no-ext-diff -U3 base head --
 * <path>`. Output is data: hunks of numbered lines, with the changed words
 * inside paired lines worked out here (so the view only has to print them).
 * Pure: no I/O, no HTML.
 */

/** The most text of one page (or one page's diff) the review page prints. Beyond it the page says so. */
export const PAGE_TEXT_LIMIT = 200 * 1024;

/** The first `limit` bytes of `text`, cut at a line end when it can be, and how big the whole was. */
export function capText(text, limit = PAGE_TEXT_LIMIT) {
  const s = String(text ?? '');
  const bytes = Buffer.byteLength(s);
  if (bytes <= limit) return { text: s, bytes, shownBytes: bytes, truncated: false };
  let head = Buffer.from(s).subarray(0, limit).toString('utf8').replace(/\uFFFD+$/, '');
  const nl = head.lastIndexOf('\n');
  if (nl > head.length / 2) head = head.slice(0, nl + 1);
  return { text: head, bytes, shownBytes: Buffer.byteLength(head), truncated: true };
}

/** A line longer than this is cut for display; the view says so. */
export const MAX_LINE_CHARS = 4000;
/** Word-level work is skipped for lines with more pieces than this. It is quadratic. */
const MAX_PIECES = 300;

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function unquote(p) {
  const s = String(p || '').trim();
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  return s;
}

const stripPrefix = (p) => (p === '/dev/null' ? '' : p.replace(/^[ab]\//, ''));

function cut(text) {
  return text.length > MAX_LINE_CHARS ? { text: `${text.slice(0, MAX_LINE_CHARS)}`, cut: true } : { text };
}

/**
 * Parse unified diff text.
 * @returns {{ files: Array<{ oldPath: string, newPath: string, renamed: boolean, hunks: Array }>, added: number, removed: number }}
 *   hunk: { header, oldStart, oldCount, newStart, newCount, lines: [{ type: 'ctx'|'add'|'del', oldNo, newNo, text, noEol?, cut? }] }
 */
export function parseDiff(input) {
  const lines = String(input ?? '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const files = [];
  let file = null;
  let i = 0;
  let added = 0;
  let removed = 0;
  const open = () => { file = { oldPath: '', newPath: '', renamed: false, hunks: [] }; files.push(file); return file; };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      open();
      i++;
      continue;
    }
    if (!file) {
      // A diff without a "diff --git" line: still read it.
      if (/^(---|@@) /.test(line)) open(); else { i++; continue; }
    }
    if (line.startsWith('rename from ')) { file.renamed = true; file.oldPath = unquote(line.slice(12)); i++; continue; }
    if (line.startsWith('rename to ')) { file.renamed = true; file.newPath = unquote(line.slice(10)); i++; continue; }
    if (line.startsWith('--- ')) {
      const p = stripPrefix(unquote(line.slice(4)).replace(/\t.*$/, ''));
      if (p) file.oldPath = p;
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = stripPrefix(unquote(line.slice(4)).replace(/\t.*$/, ''));
      if (p) file.newPath = p;
      i++;
      continue;
    }
    const h = line.match(HUNK);
    if (!h) { i++; continue; }
    const hunk = {
      header: h[5] || '',
      oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]),
      newStart: Number(h[3]), newCount: h[4] === undefined ? 1 : Number(h[4]),
      lines: [],
    };
    file.hunks.push(hunk);
    i++;
    let oldNo = hunk.oldStart;
    let newNo = hunk.newStart;
    let oldLeft = hunk.oldCount;
    let newLeft = hunk.newCount;
    // Count-driven, so a deleted line that reads "-- x" is not mistaken for a file header.
    while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
      const l = lines[i];
      const c = l[0];
      if (c === '\\') { if (hunk.lines.length) hunk.lines[hunk.lines.length - 1].noEol = true; i++; continue; }
      if (c === '+' && newLeft > 0) { hunk.lines.push({ type: 'add', oldNo: null, newNo: newNo++, ...cut(l.slice(1)) }); newLeft--; added++; }
      else if (c === '-' && oldLeft > 0) { hunk.lines.push({ type: 'del', oldNo: oldNo++, newNo: null, ...cut(l.slice(1)) }); oldLeft--; removed++; }
      else if (c === ' ' || l === '') { hunk.lines.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, ...cut(l.slice(1)) }); oldLeft--; newLeft--; }
      else break;
      i++;
    }
    while (i < lines.length && lines[i][0] === '\\') { if (hunk.lines.length) hunk.lines[hunk.lines.length - 1].noEol = true; i++; }
  }
  for (const f of files) {
    if (!f.newPath) f.newPath = f.oldPath;
    if (!f.oldPath) f.oldPath = f.newPath;
  }
  return { files, added, removed };
}

// ── words inside a changed line ──────────────────────────────────────────────

const PIECES = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

/**
 * The words that differ between two lines: [{ text, changed }] for each side,
 * and how much of the lines is shared (0..1). `null` when a line is too long
 * to compare word by word.
 */
export function wordDiff(a, b) {
  const x = String(a).match(PIECES) || [];
  const y = String(b).match(PIECES) || [];
  if (x.length > MAX_PIECES || y.length > MAX_PIECES) return null;
  const n = x.length;
  const m = y.length;
  const t = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i][j] = x[i] === y[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const left = [];
  const right = [];
  let i = 0;
  let j = 0;
  let same = 0;
  const push = (arr, text, changed) => {
    const last = arr[arr.length - 1];
    if (last && last.changed === changed) last.text += text; else arr.push({ text, changed });
  };
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { push(left, x[i], false); push(right, y[j], false); same += x[i].length; i++; j++; }
    else if (j < m && (i === n || t[i][j + 1] >= t[i + 1][j])) { push(right, y[j], true); j++; }
    else { push(left, x[i], true); i++; }
  }
  const total = Math.max(String(a).length, String(b).length) || 1;
  return { left, right, shared: same / total };
}

/** Lines paired when at least this much of them is the same. */
const PAIR_MIN = 0.4;

/**
 * Walk a hunk and return rows for printing. Each row is { left, right } where a
 * side is a line (with `parts` when its words were compared) or null. A run of
 * removed lines followed by added lines is paired one to one when they look
 * alike. Unified printing flattens these back to lines.
 */
export function hunkRows(hunk) {
  const rows = [];
  const ls = hunk.lines;
  let i = 0;
  while (i < ls.length) {
    if (ls[i].type === 'ctx') { rows.push({ left: ls[i], right: ls[i] }); i++; continue; }
    const dels = [];
    const adds = [];
    while (i < ls.length && ls[i].type === 'del') dels.push(ls[i++]);
    while (i < ls.length && ls[i].type === 'add') adds.push(ls[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      let l = dels[k] || null;
      let r = adds[k] || null;
      if (l && r) {
        const w = wordDiff(l.text, r.text);
        if (w && w.shared >= PAIR_MIN) { l = { ...l, parts: w.left }; r = { ...r, parts: w.right }; }
      }
      rows.push({ left: l, right: r });
    }
  }
  return rows;
}

/**
 * Hunks with the unchanged stretches between them, as printable items:
 *   { kind: 'fold', count, lines | null }   unchanged lines (lines only when the text is known)
 *   { kind: 'hunk', header, rows }
 * `newLines` is the whole new file split into lines (or null when it is not
 * available); it is what lets a fold be opened.
 */
export function layoutDiff(file, newLines = null, { newTotal = null, from = null } = {}) {
  const items = [];
  const fold = (fromOld, fromNew, count) => {
    if (count <= 0) return;
    const lines = newLines && fromNew - 1 + count <= newLines.length
      ? Array.from({ length: count }, (_, k) => ({ type: 'ctx', oldNo: fromOld + k, newNo: fromNew + k, text: newLines[fromNew - 1 + k] }))
      : null;
    items.push({ kind: 'fold', count, lines });
  };
  let oldNext = from?.old ?? 1;
  let newNext = from?.new ?? 1;
  for (const h of file.hunks) {
    // With no lines on a side, git numbers the hunk by the line before it.
    const newFirst = h.newCount === 0 ? h.newStart + 1 : h.newStart;
    const oldFirst = h.oldCount === 0 ? h.oldStart + 1 : h.oldStart;
    fold(oldNext, newNext, newFirst - newNext);
    items.push({ kind: 'hunk', header: h.header, oldStart: h.oldStart, newStart: h.newStart, rows: hunkRows(h), empty: h.lines.length === 0 });
    oldNext = oldFirst + h.oldCount;
    newNext = newFirst + h.newCount;
  }
  const total = newTotal ?? (newLines ? newLines.length : null);
  if (total !== null && total >= newNext) fold(oldNext, newNext, total - newNext + 1);
  return items;
}

/** How many lines the front matter block takes at the top of a page, delimiters included; 0 when there is none. */
export function frontMatterLines(text) {
  const m = /^\uFEFF?---[^\n]*\n(?:[\s\S]*?\n)?---[ \t]*(?:\n|$)/.exec(String(text ?? ''));
  if (!m) return 0;
  return m[0].split('\n').length - (m[0].endsWith('\n') ? 1 : 0);
}

/**
 * One file's hunks cut in two at the end of the front matter: the changes in
 * the details block, and the changes in the body. A hunk that crosses the line
 * is split; one with no change left on a side is dropped from it.
 */
export function splitFront(file, oldFront, newFront) {
  const inFront = (l) => (l.type === 'del' ? l.oldNo <= oldFront : l.newNo <= newFront);
  const front = [];
  const body = [];
  for (const h of file.hunks) {
    for (const [part, bucket] of [[h.lines.filter(inFront), front], [h.lines.filter((l) => !inFront(l)), body]]) {
      if (!part.some((l) => l.type !== 'ctx')) continue;
      const firstOld = part.find((l) => l.oldNo !== null);
      const firstNew = part.find((l) => l.newNo !== null);
      const oldCount = part.filter((l) => l.oldNo !== null).length;
      const newCount = part.filter((l) => l.newNo !== null).length;
      const before = (key) => { const at = h.lines.indexOf(part[0]); for (let i = at - 1; i >= 0; i--) if (h.lines[i][key] !== null) return h.lines[i][key]; return null; };
      bucket.push({
        header: h.header,
        oldStart: firstOld ? firstOld.oldNo : (before('oldNo') ?? h.oldStart - 1), oldCount,
        newStart: firstNew ? firstNew.newNo : (before('newNo') ?? h.newStart - 1), newCount,
        lines: part,
      });
    }
  }
  return { front: { ...file, hunks: front }, body: { ...file, hunks: body } };
}
