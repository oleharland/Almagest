/**
 * log.mjs — structured logger. Always stderr: `almagest mcp` speaks the MCP
 * protocol on stdout, and one stray log line there corrupts the stream.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

export function createLogger(options = {}) {
  const {
    level = process.env.ALMAGEST_LOG_LEVEL || 'info',
    json = process.env.ALMAGEST_LOG_JSON === '1',
    bindings = {},
    sink = (line) => process.stderr.write(line + '\n'),
  } = options;
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(lvl, msg, fields = {}) {
    if (LEVELS[lvl] < threshold) return;
    const all = { ...bindings, ...fields };
    if (json) {
      sink(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...all }));
      return;
    }
    const extra = Object.entries(all)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ');
    sink(`[almagest] ${lvl.padEnd(5)} ${msg}${extra ? ' ' + extra : ''}`);
  }

  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (more) => createLogger({ level, json, sink, bindings: { ...bindings, ...more } }),
  };
}

/** For tests: collects lines instead of writing them. */
export function createMemoryLogger() {
  const lines = [];
  const log = createLogger({ level: 'debug', json: true, sink: (l) => lines.push(JSON.parse(l)) });
  return Object.assign(log, { lines });
}
