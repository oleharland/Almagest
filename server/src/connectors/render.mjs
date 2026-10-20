/**
 * render.mjs — a fetched item → plain text a citation can point into.
 *
 * Every mode writes the locator markers from the ingest rules, each alone on
 * its own line, so the frozen citation grammar resolves against the snapshot:
 *
 *   === section: Failover ===    ← [source: x, §Failover]
 *   === page 3 ===               ← [source: x, p.3]
 *   === row 14 ===               ← [source: x, row 14]
 *   === t 00:14:32 ===           ← [source: x, t 00:14:32]
 *
 * Upstream text is data. Nothing in it is removed or reworded, with one
 * mechanical exception: a line of upstream text that is itself shaped like a
 * marker gets a leading backslash, so third-party content cannot forge a
 * locator and make a citation land somewhere the source never said it.
 */
import { select, selectAll } from './mapping.mjs';

export const RENDER_MODES = ['markdown', 'json-to-markdown', 'transcript', 'rows', 'auto'];

const MARKER_LIKE = /^\s*(===\s.*\s===|--- (almagest snapshot|end of header)\b.*)\s*$/;

/** The one transformation applied to upstream text. */
export function neutralize(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (MARKER_LIKE.test(line) ? `\\${line}` : line))
    .join('\n');
}

export const marker = {
  section: (name) => `=== section: ${oneLine(name)} ===`,
  page: (n) => `=== page ${n} ===`,
  row: (n) => `=== row ${n} ===`,
  t: (hms) => `=== t ${hms} ===`,
};

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim() || 'untitled';
}

// ── markdown ─────────────────────────────────────────────────────────────────

/** Puts `=== section: … ===` above every ATX heading outside fenced code. */
function markHeadings(text) {
  const out = [];
  let fence = '';
  for (const line of text.split('\n')) {
    const f = line.match(/^\s*(```|~~~)/);
    if (f) fence = fence === f[1] ? '' : fence || f[1];
    const h = !fence && line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
    if (h) {
      if (out.length && out[out.length - 1] !== '') out.push('');
      out.push(marker.section(h[1]));
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Pulls text out of whatever a fetch returned: strings, MCP resource contents, text blocks. */
export function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join('\n\n');
  if (typeof value.text === 'string') return value.text;
  if (typeof value.blob === 'string') {
    return `[binary content not captured: ${value.mimeType || 'unknown type'}, ${value.blob.length} base64 characters]`;
  }
  return '';
}

function renderMarkdown(value, opts = {}) {
  if (opts.pages && Array.isArray(value)) {
    return value.map((p, i) => `${marker.page(i + 1)}\n${markHeadings(neutralize(textOf(p)))}`).join('\n\n');
  }
  const text = textOf(value);
  if (!text && value && typeof value === 'object') return renderJson(value, opts);
  return markHeadings(neutralize(text));
}

// ── json-to-markdown ─────────────────────────────────────────────────────────

const LONG_TEXT = 200;

function scalarText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function isLongText(v) {
  return typeof v === 'string' && (v.includes('\n') || v.length > LONG_TEXT);
}

function bullets(value, depth = 0) {
  const pad = '  '.repeat(depth);
  if (depth > 6) return [`${pad}- ${neutralize(JSON.stringify(value))}`];
  if (Array.isArray(value)) {
    return value.flatMap((v) => (isScalar(v) ? [`${pad}- ${neutralize(scalarText(v))}`] : [`${pad}-`, ...bullets(v, depth + 1)]));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) =>
      isScalar(v) ? [`${pad}- ${k}: ${neutralize(scalarText(v)).replace(/\n/g, ' ')}`] : [`${pad}- ${k}:`, ...bullets(v, depth + 1)]);
  }
  return [`${pad}- ${neutralize(scalarText(value))}`];
}

function itemLabel(v, i) {
  if (v && typeof v === 'object') {
    const label = select(v, 'title | name | id | key');
    if (label !== undefined && isScalar(label)) return String(label);
  }
  return `#${i + 1}`;
}

/**
 * An object becomes: an optional `# Title`, a `Properties` section of the
 * short scalar fields, then one section per long text or nested field. A
 * top-level array becomes one section per element.
 */
function renderJson(value, opts = {}) {
  const omit = new Set(opts.omit || []);
  if (Array.isArray(value)) {
    return value
      .map((v, i) => `${marker.section(itemLabel(v, i))}\n${isScalar(v) ? neutralize(scalarText(v)) : renderJson(v, { ...opts, title: undefined })}`)
      .join('\n\n');
  }
  if (!value || typeof value !== 'object') return neutralize(scalarText(value));

  const parts = [];
  const title = opts.title ? select(value, opts.title) : undefined;
  if (title !== undefined) parts.push(`# ${neutralize(oneLine(title))}`);

  const props = [];
  const sections = [];
  const bodyKeys = new Set(opts.body ? [].concat(opts.body) : []);
  for (const [k, v] of Object.entries(value)) {
    if (omit.has(k) || v === undefined) continue;
    if (bodyKeys.has(k) || isLongText(v)) {
      sections.push(`${marker.section(k)}\n${markHeadings(neutralize(textOf(v)))}`);
    } else if (isScalar(v)) {
      props.push(`- ${k}: ${neutralize(scalarText(v))}`);
    } else if (Array.isArray(v) && v.every(isScalar)) {
      props.push(`- ${k}: ${v.map((x) => neutralize(scalarText(x))).join(', ')}`);
    } else {
      sections.push(`${marker.section(k)}\n${bullets(v).join('\n')}`);
    }
  }
  if (props.length) parts.push(`${marker.section('Properties')}\n${props.join('\n')}`);
  parts.push(...sections);
  return parts.join('\n\n');
}

// ── transcript ───────────────────────────────────────────────────────────────

export function hms(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

const CLOCK_RE = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,]\d+)?$/;

function clockSeconds(text) {
  const m = String(text).trim().match(CLOCK_RE);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Seconds into the recording, from a number, a clock string, or an ISO time relative to `origin`. */
function offsetOf(raw, origin, unit) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw === 'number') return unit === 'ms' ? raw / 1000 : raw;
  const clock = clockSeconds(raw);
  if (clock !== null) return clock;
  if (/^-?\d+(\.\d+)?$/.test(String(raw))) return unit === 'ms' ? Number(raw) / 1000 : Number(raw);
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  if (origin.value === null) origin.value = t;
  return (t - origin.value) / 1000;
}

const LINE_STAMP_RE = /^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2})(?:[.,]\d+)?\]?\s*[-–:]?\s*(.*)$/;

function renderTranscript(value, opts = {}) {
  const segments = opts.segments ? selectAll(value, opts.segments) : Array.isArray(value) ? value : null;
  const out = [];
  let last = '';
  const stamp = (seconds) => {
    const t = hms(seconds);
    if (t === last) return;
    last = t;
    out.push(marker.t(t));
  };

  if (segments && segments.length && typeof segments[0] === 'object') {
    const origin = { value: null };
    for (const seg of segments) {
      const at = offsetOf(select(seg, opts.start || 'start | start_time | startTime | timestamp | offset | time'), origin, opts.unit);
      if (at !== null) stamp(at);
      else if (!last) stamp(0);
      const speaker = select(seg, opts.speaker || 'speaker | speaker_name | source | name');
      const text = neutralize(textOf(select(seg, opts.text || 'text | content | transcript')));
      out.push(speaker !== undefined && isScalar(speaker) ? `${neutralize(oneLine(speaker))}: ${text}` : text);
    }
    return out.join('\n');
  }

  // A plain-text transcript: a timestamp at the start of a line becomes a marker.
  const text = neutralize(textOf(value));
  const lines = text.split('\n');
  const stamped = lines.some((l) => LINE_STAMP_RE.test(l) && clockSeconds(l.match(LINE_STAMP_RE)[1]) !== null);
  if (!stamped) return `${marker.t(hms(0))}\n${text}`;
  for (const line of lines) {
    const m = line.match(LINE_STAMP_RE);
    const at = m ? clockSeconds(m[1]) : null;
    if (at !== null) {
      stamp(at);
      if (m[2]) out.push(m[2]);
    } else {
      if (!last) stamp(0);
      out.push(line);
    }
  }
  return out.join('\n');
}

// ── rows ─────────────────────────────────────────────────────────────────────

function renderRows(value, opts = {}) {
  const rows = opts.rows ? selectAll(value, opts.rows) : Array.isArray(value) ? value : [value];
  return rows
    .map((row, i) => {
      let body;
      if (row && typeof row === 'object' && !Array.isArray(row)) {
        const cols = opts.columns || Object.keys(row);
        body = cols
          .map((c) => [c, select(row, c)])
          .filter(([, v]) => v !== undefined)
          .map(([c, v]) => `${c}: ${neutralize(scalarText(v)).replace(/\n/g, ' ')}`)
          .join('\n');
      } else if (Array.isArray(row)) {
        body = row.map((v) => neutralize(scalarText(v))).join(' | ');
      } else {
        body = neutralize(scalarText(row));
      }
      return `${marker.row(i + 1)}\n${body}`;
    })
    .join('\n\n');
}

// ── entry point ──────────────────────────────────────────────────────────────

/**
 * @param {string} mode   markdown | json-to-markdown | transcript | rows | auto
 * @param {*} value       what `fetch.text` selected from the tool result
 * @param {object} [opts] the recipe's `fetch.render_options`
 * @param {object} [hint] { mimeType } — lets `auto` pick
 */
export function render(mode, value, opts = {}, hint = {}) {
  switch (mode || 'auto') {
    case 'markdown': return renderMarkdown(value, opts);
    case 'json-to-markdown': return renderJson(value, opts);
    case 'transcript': return renderTranscript(value, opts);
    case 'rows': return renderRows(value, opts);
    case 'auto': {
      const mime = String(hint.mimeType || (value && value.mimeType) || '');
      if (/json/.test(mime) && typeof textOf(value) === 'string') {
        try { return renderJson(JSON.parse(textOf(value)), opts); } catch { /* fall through */ }
      }
      if (/csv/.test(mime)) return renderRows(textOf(value).split('\n').filter(Boolean), opts);
      // Known non-markdown text (yaml, code, plain): no heading markers — a
      // `# comment` is not a section. Cite it by `line N`.
      if (mime && !/markdown/.test(mime) && textOf(value)) return neutralize(textOf(value));
      if (typeof value === 'string' || textOf(value)) return renderMarkdown(value, opts);
      return renderJson(value, opts);
    }
    default:
      throw new Error(`unknown render mode "${mode}" — ${RENDER_MODES.join(' | ')}`);
  }
}
