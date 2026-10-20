/**
 * recorder.mjs — the write path behind `ctx.telemetry.record`.
 *
 * The contract is that recording never throws and never blocks the caller: a
 * `search` over MCP must answer at the same speed whether the database is
 * healthy, slow or down. So `record` only builds the event and pushes it onto a
 * bounded in-memory buffer; a single background drain appends to the store.
 *
 *   store slow   → the buffer fills; past `maxBuffer` the OLDEST event is
 *                  dropped and `dropped` counts it (recent demand matters more)
 *   store fails  → that event is lost, `failed` counts it, one warning is logged
 *                  per burst — never per event, or the log becomes the outage
 *
 * `flush()` resolves once the buffer is empty — for tests and for shutdown.
 */
export function createRecorder({ store, log, build, maxBuffer = 1000 }) {
  const buffer = [];
  const stats = { recorded: 0, appended: 0, dropped: 0, failed: 0, rejected: 0 };
  let draining = null;
  let warnedAt = 0;

  function warn(msg, fields) {
    const t = Date.now();
    if (t - warnedAt < 60_000) return;
    warnedAt = t;
    try { log?.warn(msg, { ...fields, ...stats }); } catch { /* a broken logger must not break record() either */ }
  }

  async function drain() {
    while (buffer.length) {
      const evt = buffer.shift();
      try {
        await store.events.append(evt);
        stats.appended++;
      } catch (err) {
        stats.failed++;
        warn('telemetry append failed; event dropped', { error: err?.message ?? String(err) });
      }
    }
  }

  function kick() {
    if (draining) return;
    draining = new Promise((resolve) => setImmediate(resolve))
      .then(drain)
      .catch(() => {})
      .finally(() => { draining = null; if (buffer.length) kick(); });
  }

  /** @returns {object|null} the event as stored, or null when it was rejected */
  function record(partial) {
    try {
      const evt = build(partial);
      if (buffer.length >= maxBuffer) {
        buffer.shift();
        stats.dropped++;
        warn('telemetry buffer full; oldest event dropped', { maxBuffer });
      }
      buffer.push(evt);
      stats.recorded++;
      kick();
      return evt;
    } catch (err) {
      stats.rejected++;
      try { log?.debug('telemetry event rejected', { error: err?.message ?? String(err) }); } catch { /* ignore */ }
      return null;
    }
  }

  async function flush() {
    while (draining || buffer.length) {
      if (!draining) kick();
      await draining;
    }
  }

  return { record, flush, stats: () => ({ ...stats, buffered: buffer.length }) };
}
