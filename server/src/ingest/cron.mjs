/**
 * cron.mjs — a five-field cron parser, because one dependency for a dozen
 * lines of field arithmetic is a bad trade.
 *
 *   minute  hour  day-of-month  month  day-of-week
 *   0-59    0-23  1-31          1-12   0-7 (0 and 7 are Sunday)
 *
 * Each field takes `*`, a number, a range `a-b`, a step `*\/n` or `a-b/n`, and
 * comma lists of those. Month and weekday names (`jan`, `mon`) are accepted.
 * No seconds field, no `L` / `W` / `#`, no `@hourly` shorthands except the
 * handful listed in MACROS: connector schedules are "hourly", "every morning",
 * "weekdays at nine", and anything rarer belongs in a real scheduler.
 *
 * Day-of-month and day-of-week follow Vixie cron: when both are restricted, a
 * time matches if EITHER matches. That surprises people, and it is still the
 * behaviour every crontab they have written assumed.
 *
 * Times are evaluated in the process's local time zone, like cron.
 */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], base: 1 },
  { name: 'day-of-week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], base: 0 },
];

const MACROS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

export class CronError extends Error {
  constructor(expr, message) {
    super(`invalid cron "${expr}": ${message}`);
    this.name = 'CronError';
  }
}

function value(token, field, expr) {
  const lower = token.toLowerCase();
  if (field.names) {
    const i = field.names.indexOf(lower);
    if (i !== -1) return i + field.base;
  }
  if (!/^\d+$/.test(token)) throw new CronError(expr, `${field.name}: "${token}" is not a number`);
  const n = Number(token);
  if (n < field.min || n > field.max) throw new CronError(expr, `${field.name}: ${n} is outside ${field.min}-${field.max}`);
  return n;
}

function parseField(text, field, expr) {
  const set = new Set();
  for (const part of text.split(',')) {
    if (!part) throw new CronError(expr, `${field.name}: empty list item`);
    const [range, stepText] = part.split('/');
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) === 0) throw new CronError(expr, `${field.name}: bad step "${stepText}"`);
      step = Number(stepText);
    }
    let lo;
    let hi;
    if (range === '*') { lo = field.min; hi = field.max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = value(a, field, expr);
      hi = value(b, field, expr);
      if (lo > hi) throw new CronError(expr, `${field.name}: range ${a}-${b} runs backwards`);
    } else {
      lo = value(range, field, expr);
      // `5/15` means "from 5, every 15" — same as `5-max/15`.
      hi = stepText !== undefined ? field.max : lo;
    }
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  return set;
}

/**
 * @param {string} expr
 * @returns {{ expr: string, matches(date: Date): boolean, next(after?: Date): Date }}
 */
export function parseCron(expr) {
  const source = String(expr || '').trim();
  const text = MACROS[source.toLowerCase()] || source;
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new CronError(source, `expected 5 fields, got ${parts.length}`);

  const [minute, hour, dom, month, dowRaw] = parts.map((p, i) => parseField(p, FIELDS[i], source));
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  // Vixie cron decides "restricted" on the text: `*/2` in day-of-month counts
  // as restricted, a bare `*` does not.
  const domRestricted = parts[2] !== '*';
  const dowRestricted = parts[4] !== '*';

  function dayMatches(date) {
    const d = dom.has(date.getDate());
    const w = dow.has(date.getDay());
    if (domRestricted && dowRestricted) return d || w;
    if (domRestricted) return d;
    if (dowRestricted) return w;
    return true;
  }

  function matches(date) {
    return minute.has(date.getMinutes())
      && hour.has(date.getHours())
      && month.has(date.getMonth() + 1)
      && dayMatches(date);
  }

  /**
   * The first whole minute strictly after `after` that matches. Walks forward
   * skipping whole days and hours that cannot match, so even a yearly schedule
   * resolves in a few thousand steps rather than half a million.
   */
  function next(after = new Date()) {
    const t = new Date(after.getTime());
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);
    const limit = after.getTime() + 5 * 366 * 24 * 3600 * 1000;
    while (t.getTime() <= limit) {
      if (!month.has(t.getMonth() + 1)) { t.setMonth(t.getMonth() + 1, 1); t.setHours(0, 0, 0, 0); continue; }
      if (!dayMatches(t)) { t.setDate(t.getDate() + 1); t.setHours(0, 0, 0, 0); continue; }
      if (!hour.has(t.getHours())) { t.setHours(t.getHours() + 1, 0, 0, 0); continue; }
      if (!minute.has(t.getMinutes())) { t.setMinutes(t.getMinutes() + 1, 0, 0); continue; }
      return t;
    }
    throw new CronError(source, 'never fires (no matching time in five years)');
  }

  return { expr: source, matches, next };
}
