/**
 * cli: `almagest search`, `almagest get` and `almagest ask`, the brain from a
 * terminal. Each one calls the MCP tool of the same name through
 * ctx.mcp.callTool, so the role checks, the snapshot and the telemetry are the
 * ones an MCP client gets. Calls are recorded on channel `cli`.
 *
 * Exit codes: 0 found or answered · 1 the tool worked and found nothing
 * (no matching page, no answer, no page with that slug) · 2 usage error or any
 * other error.
 */

const TIERS = ['canonical', 'curated', 'evidence'];
const NOT_FOUND = /^No page "/;

class UsageError extends Error {}

/** Parse the words and options after the command name. Unknown options are an error. */
function parseOptions(argv, spec) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { opts._.push(a); continue; }
    const name = a.slice(2);
    if (spec.valued.includes(name)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
      opts[name] = value;
    } else if (spec.flags.includes(name)) {
      opts[name] = true;
    } else {
      throw new UsageError(`unknown option ${a}`);
    }
  }
  return opts;
}

/** The positional words joined with a space; a missing one is a usage error. */
function wordsOf(opts, what) {
  const text = opts._.join(' ').trim();
  if (!text) throw new UsageError(`missing ${what}`);
  return text;
}

const SPECS = {
  search: {
    summary: 'search <words>: find pages in the brain',
    usage: 'almagest search <words...> [--limit <n>] [--type <t>] [--tier <canonical|curated|evidence>] [--json]',
    valued: ['limit', 'type', 'tier'],
    flags: ['json'],
    tool: 'search',
    plan(opts) {
      const args = { query: wordsOf(opts, 'search words') };
      if (opts.limit !== undefined) {
        const n = Number(opts.limit);
        if (!Number.isInteger(n) || n < 1 || n > 25) throw new UsageError('--limit must be a whole number from 1 to 25');
        args.limit = n;
      }
      if (opts.type !== undefined) args.type = opts.type;
      if (opts.tier !== undefined) {
        if (!TIERS.includes(opts.tier)) throw new UsageError(`--tier must be one of ${TIERS.join(', ')}`);
        args.tier = opts.tier;
      }
      return args;
    },
    found: (res) => (res.data?.results?.length || 0) > 0,
  },
  get: {
    summary: 'get <slug>: read one page with its citations',
    usage: 'almagest get <slug> [--no-body] [--no-citations] [--json]',
    valued: [],
    flags: ['no-body', 'no-citations', 'json'],
    tool: 'get_page',
    plan(opts) {
      const args = { slug: wordsOf(opts, 'page slug') };
      if (opts['no-body']) args.include_body = false;
      if (opts['no-citations']) args.resolve_citations = false;
      return args;
    },
    // get_page reports a missing page as a tool error; that one is "found nothing", not a failure.
    notFound: (res) => NOT_FOUND.test(res.text),
    found: () => true,
  },
  ask: {
    summary: 'ask <question>: answer-ready context from the brain',
    usage: 'almagest ask <question...> [--json]',
    valued: [],
    flags: ['json'],
    tool: 'ask',
    plan(opts) {
      return { question: wordsOf(opts, 'question') };
    },
    found: (res) => res.data?.answered === true,
  },
};

/**
 * @param {string} name   search | get | ask
 * @param {string[]} argv words and options after the command name
 * @param {object} env    { ctx, out?, err? }; out and err default to stdout and stderr
 * @returns {Promise<number>} exit code
 */
async function runTool(name, argv, env) {
  const spec = SPECS[name];
  const out = env.out || ((s) => process.stdout.write(s));
  const err = env.err || ((s) => process.stderr.write(s));

  let args;
  let opts;
  try {
    opts = parseOptions(argv, spec);
    args = spec.plan(opts);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`almagest ${name}: ${e.message}\nusage: ${spec.usage}\n`);
    return 2;
  }

  let res;
  try {
    res = await env.ctx.mcp.callTool(spec.tool, args);
  } catch (e) {
    err(`almagest: ${e.message}\n`);
    return 2;
  }

  if (res.isError) {
    err(`${res.text}\n`);
    return spec.notFound?.(res) ? 1 : 2;
  }
  out(opts.json ? `${JSON.stringify(res.data, null, 2)}\n` : `${res.text}\n`);
  return spec.found(res) ? 0 : 1;
}

export const commands = {
  search: { summary: SPECS.search.summary, needsApp: true, run: (argv, env) => runTool('search', argv, env) },
  get: { summary: SPECS.get.summary, needsApp: true, run: (argv, env) => runTool('get', argv, env) },
  ask: { summary: SPECS.ask.summary, needsApp: true, run: (argv, env) => runTool('ask', argv, env) },
};
