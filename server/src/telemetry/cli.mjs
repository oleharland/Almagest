/**
 * cli.mjs — `almagest demand | gaps | reverify`. Human-readable tables on
 * stdout; `--json` for the same data as the HTTP API returns.
 *
 *   almagest demand [--top N] [--json]
 *   almagest gaps [--limit N] [--since <iso date>] [--json]
 *   almagest reverify [--json]
 *
 * Each recomputes demand first, so the answer reflects the event log as it is
 * now rather than the last interval tick.
 */
function parse(argv) {
  const opts = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--top' || a === '--limit' || a === '--since') {
      const v = argv[++i];
      if (v == null) throw new Error(`${a} needs a value`);
      opts[a.slice(2)] = v;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function positive(v, fallback) {
  if (v == null) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`expected a positive integer, got "${v}"`);
  return n;
}

/** A plain-text table. Columns are left-aligned except those named in `right`. */
export function table(rows, columns, { right = [] } = {}) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const cell = (c, v, i) => (right.includes(c) ? String(v).padStart(widths[i]) : String(v).padEnd(widths[i]));
  const line = (r) => columns.map((c, i) => cell(c, r[c] ?? '', i)).join('  ').trimEnd();
  return [line(Object.fromEntries(columns.map((c) => [c, c]))), columns.map((_, i) => '─'.repeat(widths[i])).join('  '), ...rows.map(line)].join('\n');
}

function writer(env) {
  return env.stdout || ((s) => process.stdout.write(s));
}

async function run(env, fn) {
  const out = writer(env);
  try {
    await fn(out);
    return 0;
  } catch (err) {
    (env.stderr || ((s) => process.stderr.write(s)))(`almagest: ${err.message}\n`);
    return 2;
  }
}

export const commands = {
  demand: {
    summary: 'Pages ranked by demand, hot pages marked [--top N] [--json]',
    needsApp: true,
    run: (argv, env) => run(env, async (out) => {
      const opts = parse(argv);
      const { ctx } = env;
      const top = positive(opts.top, 20);
      const record = await ctx.demand.recompute({ reason: 'cli' });
      const entries = await ctx.demand.top(top);
      if (opts.json) return out(JSON.stringify({ computedAt: record.computedAt, hot: record.hot, top: entries }, null, 2) + '\n');
      if (!ctx.telemetry.enabled) return out('telemetry is disabled (telemetry.enabled: false)\n');
      if (entries.length === 0) return out('No demand recorded yet.\n');
      const rows = entries.map((e) => ({ rank: e.rank, slug: e.slug, score: e.score.toFixed(2), sessions: e.distinctSessions, hot: e.hot ? 'hot' : '' }));
      out(`${table(rows, ['rank', 'slug', 'score', 'sessions', 'hot'], { right: ['rank', 'score', 'sessions'] })}\n\n` +
        `${record.hot.length} hot of ${record.population} page(s) · computed ${record.computedAt}\n`);
    }),
  },

  gaps: {
    summary: 'Unanswered questions, clustered [--limit N] [--since date] [--json]',
    needsApp: true,
    run: (argv, env) => run(env, async (out) => {
      const opts = parse(argv);
      if (opts.since && Number.isNaN(new Date(opts.since).getTime())) throw new Error(`--since is not a date: "${opts.since}"`);
      const gaps = await env.ctx.telemetry.gaps({ limit: positive(opts.limit, 20), since: opts.since });
      if (opts.json) return out(JSON.stringify({ gaps }, null, 2) + '\n');
      if (gaps.length === 0) return out('No open gaps.\n');
      const rows = gaps.map((g) => ({
        count: g.count,
        sessions: g.distinctSessions,
        'last seen': g.lastSeen.slice(0, 10),
        question: g.representative ?? `(hashed) ${g.cluster}`,
      }));
      out(`${table(rows, ['count', 'sessions', 'last seen', 'question'], { right: ['count', 'sessions'] })}\n\n` +
        gaps.map((g) => `→ ${g.suggestion}`).join('\n') + '\n');
    }),
  },

  reverify: {
    summary: 'Hot pages due a re-check, most urgent first [--json]',
    needsApp: true,
    run: (argv, env) => run(env, async (out) => {
      const opts = parse(argv);
      await env.ctx.demand.recompute({ reason: 'cli' });
      const queue = await env.ctx.telemetry.reverifyQueue();
      if (opts.json) return out(JSON.stringify({ queue }, null, 2) + '\n');
      if (queue.length === 0) return out('Nothing to re-verify: no hot page is stale or low-confidence.\n');
      const rows = queue.map((q) => ({
        slug: q.slug,
        score: q.score.toFixed(2),
        'last verified': q.lastVerified ?? 'never',
        overdue: q.overdueDays > 0 ? `${q.overdueDays}d` : '—',
        reason: q.reason,
      }));
      out(table(rows, ['slug', 'score', 'last verified', 'overdue', 'reason'], { right: ['score', 'overdue'] }) + '\n');
    }),
  },
};
