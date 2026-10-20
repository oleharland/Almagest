/**
 * trust.mjs — how an actor reached a review action.
 *
 * Every review action (approve, accept a page, reject, take a page out,
 * answer a question, ask for changes, retry a merge) needs a person who was
 * established by a path that cannot be driven by a token sitting in an
 * agent's environment:
 *
 *   'session'    a signed-in browser session (sessions.mjs) — the inbox, a
 *                chat confirmation opened in the inbox, an email sign-in link
 *   'slack'      a button press whose request Slack signed (channels/slack.mjs)
 *   'github-pr'  a merge GitHub signed a webhook for (channels/github-pr.mjs)
 *
 * The module that verified the request vouches for the actor object it
 * built. The mark lives in a WeakMap, not on the object: spreading an actor
 * into a new object, or writing `session: {…}` onto one, does not carry it.
 * Bearer tokens (ALMAGEST_TOKENS, OIDC access tokens, MCP OAuth tokens) are
 * never vouched for, so they can read proposals and never act on them.
 */
import { ForbiddenError } from '../core/auth.mjs';

const VOUCHED = new WeakMap();

/** Channels whose own verified path may act without a browser session, and the vouch each needs. */
export const SESSIONLESS = { slack: 'slack', 'github-pr': 'github-pr' };

export function vouch(actor, how) {
  if (actor && typeof actor === 'object') VOUCHED.set(actor, how);
  return actor;
}

export function vouchedAs(actor) {
  return (actor && typeof actor === 'object' && VOUCHED.get(actor)) || null;
}

/** Throws unless `actor` arrived through a path allowed to act on `channel`. */
export function assertMayAct(actor, channel) {
  const how = vouchedAs(actor);
  if (how === 'session' && actor.session?.sid) return;
  if (SESSIONLESS[channel] && how === SESSIONLESS[channel]) return;
  throw new ForbiddenError('Review actions need a signed-in browser session. Tokens can read proposals but never act on them — open the inbox.');
}
