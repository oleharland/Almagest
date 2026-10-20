/**
 * bus.mjs — in-process event bus. Event names and payloads are listed in
 * docs/v2/spec.md → Bus events; emitting a name not listed there is a bug.
 *
 * Handlers run asynchronously and in isolation: a channel that fails to send a
 * Slack message must not fail the merge that triggered it. Errors are logged,
 * never rethrown to the emitter.
 */
export const BUS_EVENTS = [
  'job.queued', 'job.started', 'job.finished',
  'proposal.created', 'proposal.updated', 'proposal.approved', 'proposal.rejected', 'proposal.merged',
  'decision.created', 'decision.resolved',
  'connector.synced',
  'demand.updated',
];

export function createBus({ log } = {}) {
  const handlers = new Map();
  const pending = new Set();

  function on(type, fn) {
    if (!BUS_EVENTS.includes(type)) throw new Error(`unknown bus event "${type}"`);
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => handlers.get(type)?.delete(fn);
  }

  function emit(type, payload) {
    if (!BUS_EVENTS.includes(type)) throw new Error(`unknown bus event "${type}"`);
    for (const fn of handlers.get(type) ?? []) {
      const p = Promise.resolve()
        .then(() => fn(payload, type))
        .catch((err) => log?.error('bus handler failed', { event: type, error: err?.message ?? String(err) }))
        .finally(() => pending.delete(p));
      pending.add(p);
    }
  }

  /** Resolves with the next payload of `type` matching `predicate`. Tests use this. */
  function waitFor(type, predicate = () => true, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timed out waiting for ${type}`)); }, timeoutMs);
      const off = on(type, (payload) => {
        if (!predicate(payload)) return;
        clearTimeout(timer);
        off();
        resolve(payload);
      });
    });
  }

  /** Waits for every handler currently in flight. */
  async function drain() {
    while (pending.size) await Promise.allSettled([...pending]);
  }

  return { on, emit, waitFor, drain };
}
