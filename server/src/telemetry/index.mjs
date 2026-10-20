/**
 * telemetry — WS5. Spec: docs/v2/spec.md → Telemetry and demand.
 *
 * PHASE 0 STUB. Builds ctx.telemetry + ctx.demand with the method names the spec promises, each
 * throwing until WS5 replaces this file. Keep the two exports — app.mjs and
 * bin/almagest.mjs depend on them:
 *
 *   create(ctx) → service object        (may register routes on ctx.http, subscribe to ctx.bus)
 *   commands    → { [name]: { summary, needsApp, run(argv, env) → exit code } }
 */
import { notImplemented } from '../core/stub.mjs';

export async function create(ctx) {
  return notImplemented('telemetry', ctx);
}

export const commands = {};
