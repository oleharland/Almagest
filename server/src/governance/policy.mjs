/**
 * policy.mjs — who has to say yes before a proposal reaches main.
 *
 * Pure: no I/O, no clock, no store. Two halves:
 *
 *   computeRequirements(...)  config rules → what this proposal needs
 *   evaluate(...)             requirements + approvals → ready, or what is missing
 *
 * The configurable half is `governance.rules`: each rule whose `when` matches
 * adds its `require`, and requirements combine by max (counts) and union
 * (roles, teams). Rules can only ever ADD requirements.
 *
 * The non-configurable half is written out below as invariants. No rule, flag
 * or profile can relax them:
 *
 *   - at least one human approval, given for the current headSha
 *   - agents and services never approve (core/auth.mjs → assertCanApprove)
 *   - with separation of duties on, whoever submitted a proposal (or the human
 *     an agent submitted it for) cannot approve it
 *   - open decisions block the merge
 *   - an audit exit other than 0 blocks the merge
 *   - a proposal that modifies a canonical page never merges
 *   - `owner_team` means an approver from the page's own `owner` team
 *   - people are counted by who they are (personKey: email when known, else
 *     id), not by how many ids they appear under
 *   - an approval names the version (headSha) the reviewer looked at
 *   - an approval counts with the approver's roles as they are now, never
 *     more than they had when they gave it (capRoles) — demoting someone
 *     takes their pending approvals' weight away
 *   - a proposal that changes anything outside the knowledge base's writable
 *     files (paths.mjs) can never be approved
 */
import { assertCanApprove, ForbiddenError, hasRole } from '../core/auth.mjs';
import { HttpError } from '../core/http.mjs';
import { APPROVER_ROLES, DECISION_KINDS, ROLES } from '../core/schemas.mjs';
import { keysFor } from './identity.mjs';
import { describeOutside, outsideFiles } from './paths.mjs';

export const PAGE_CONDITIONS = ['hot', 'tier', 'action', 'page', 'owner'];
export const PROPOSAL_CONDITIONS = ['decision', 'label', 'connector', 'source_kind'];
export const REQUIRE_KEYS = ['approvals', 'per_page', 'roles', 'teams', 'owner_team', 'distinct_teams'];

/** Statuses a proposal can still be approved (and merged) from. */
export const APPROVABLE = ['open', 'approved'];
/** Statuses where the proposal is still in play — an upsert updates it instead of starting over. */
export const LIVE = ['open', 'changes_requested', 'approved', 'conflicted'];

// ── config validation ────────────────────────────────────────────────────────

/** Throws a readable error for a malformed rules list. Called at startup, so a typo fails loudly. */
export function validateRules(rules) {
  if (rules == null) return [];
  if (!Array.isArray(rules)) throw new Error('governance.rules must be a list');
  rules.forEach((rule, i) => {
    const where = `governance.rules[${i}]`;
    if (!rule || typeof rule !== 'object') throw new Error(`${where} must be an object with when / require`);
    const when = rule.when ?? {};
    const req = rule.require ?? {};
    for (const k of Object.keys(when)) {
      if (![...PAGE_CONDITIONS, ...PROPOSAL_CONDITIONS].includes(k)) {
        throw new Error(`${where}.when.${k} is not a known condition — use ${[...PAGE_CONDITIONS, ...PROPOSAL_CONDITIONS].join(', ')}`);
      }
    }
    for (const kind of [].concat(when.decision ?? [])) {
      if (!DECISION_KINDS.includes(kind)) throw new Error(`${where}.when.decision: unknown decision kind "${kind}"`);
    }
    for (const k of Object.keys(req)) {
      if (!REQUIRE_KEYS.includes(k)) throw new Error(`${where}.require.${k} is not a known requirement — use ${REQUIRE_KEYS.join(', ')}`);
    }
    for (const r of [].concat(req.roles ?? [])) {
      if (!ROLES.includes(r)) throw new Error(`${where}.require.roles: unknown role "${r}"`);
    }
    for (const k of ['approvals', 'distinct_teams']) {
      if (req[k] !== undefined && !(Number.isInteger(req[k]) && req[k] >= 0)) {
        throw new Error(`${where}.require.${k} must be a whole number`);
      }
    }
  });
  return rules;
}

// ── matching ─────────────────────────────────────────────────────────────────

export function globToRegExp(glob) {
  let re = '';
  const s = String(glob);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' && s[i + 1] === '*') { re += '.*'; i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '.';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function matchOne(want, have) {
  if (Array.isArray(want)) return want.some((w) => matchOne(w, have));
  if (typeof want === 'boolean') return Boolean(have) === want;
  return String(want) === String(have ?? '');
}

function pageMatches(when, change) {
  if (when.hot !== undefined && !matchOne(when.hot, change.hot)) return false;
  if (when.tier !== undefined && !matchOne(when.tier, change.tier)) return false;
  if (when.action !== undefined && !matchOne(when.action, change.action)) return false;
  if (when.owner !== undefined && !matchOne(when.owner, change.owner)) return false;
  if (when.page !== undefined && ![].concat(when.page).some((g) => globToRegExp(g).test(change.slug))) return false;
  return true;
}

function proposalMatches(when, facts) {
  if (when.decision !== undefined && ![].concat(when.decision).some((k) => facts.decisionKinds.includes(k))) return false;
  if (when.label !== undefined && !matchOne(when.label, facts.label)) return false;
  if (when.connector !== undefined && !matchOne(when.connector, facts.connector)) return false;
  if (when.source_kind !== undefined && !matchOne(when.source_kind, facts.sourceKind)) return false;
  return true;
}

function hasPageCondition(when) {
  return PAGE_CONDITIONS.some((k) => when[k] !== undefined);
}

// ── requirements ─────────────────────────────────────────────────────────────

function emptyReq() {
  return { approvals: 0, explicit: false, roles: [], teams: [], ownerTeam: false, distinctTeams: 0, reasons: [] };
}

function addReq(target, req, reason) {
  target.approvals = Math.max(target.approvals, req.approvals ?? (req.per_page ? 1 : 0));
  if (req.per_page) target.explicit = true;
  for (const r of [].concat(req.roles ?? [])) if (!target.roles.includes(r)) target.roles.push(r);
  for (const t of [].concat(req.teams ?? [])) if (!target.teams.includes(t)) target.teams.push(t);
  if (req.owner_team) target.ownerTeam = true;
  target.distinctTeams = Math.max(target.distinctTeams, req.distinct_teams ?? 0);
  if (reason && !target.reasons.includes(reason)) target.reasons.push(reason);
}

function describeWhen(when, change) {
  const bits = [];
  if (when.hot) bits.push('frequently read');
  if (when.tier) bits.push(`${[].concat(when.tier).join('/')} tier`);
  if (when.action) bits.push([].concat(when.action).join('/'));
  if (when.page) bits.push(`matches ${[].concat(when.page).join(', ')}`);
  if (when.owner) bits.push(`owned by ${[].concat(when.owner).join('/')}`);
  if (when.decision) bits.push(`raised a ${[].concat(when.decision).join('/').replace(/_/g, ' ')} question`);
  if (when.label) bits.push(`label ${[].concat(when.label).join('/')}`);
  if (when.connector) bits.push(`from ${[].concat(when.connector).join('/')}`);
  if (when.source_kind) bits.push(`${[].concat(when.source_kind).join('/')} source`);
  const what = bits.join(', ') || 'every proposal';
  return change ? `${change.title || change.slug}: ${what}` : what;
}

/**
 * @param {object} input
 * @param {Array}  input.changes     ProposalChange[] (slug, tier, hot, action, owner, canonical)
 * @param {Array}  [input.decisions] Decision[] recorded on the proposal, open or resolved
 * @param {object} [input.source]    SourceRef
 * @param {string} [input.label]     the connector's label, when the source came from one
 * @param {Array}  [input.rules]     governance.rules
 * @returns {{ approvals, perPage, roles, teams, ownerTeam, distinctTeams, reasons, pages, canonical }}
 */
export function computeRequirements({ changes = [], decisions = [], source = null, label = '', rules = [] }) {
  const proposal = emptyReq();
  proposal.approvals = 1;   // invariant, not config
  const pages = {};
  const facts = {
    decisionKinds: decisions.map((d) => d.kind),
    label: label || '',
    connector: source?.connector || '',
    sourceKind: source?.kind || '',
  };
  const active = changes.filter((c) => c.pageStatus !== 'rejected');

  for (const rule of rules || []) {
    const when = rule.when || {};
    const req = rule.require || {};
    if (!proposalMatches(when, facts)) continue;

    if (hasPageCondition(when) || req.owner_team || req.per_page) {
      const matched = hasPageCondition(when) ? active.filter((c) => pageMatches(when, c)) : active;
      for (const c of matched) {
        // owner_team and per_page are inherently about one page; everything
        // else in a page-matched rule without per_page raises the proposal bar.
        if (req.per_page || req.owner_team) {
          pages[c.slug] ??= { ...emptyReq(), owner: c.owner || '', title: c.title || c.slug };
          addReq(pages[c.slug], req, describeWhen(when, c));
        } else {
          addReq(proposal, req, describeWhen(when, c));
        }
      }
    } else {
      addReq(proposal, req, describeWhen(when));
    }
  }

  const canonical = changes.filter((c) => c.canonical).map((c) => c.slug);
  const pageList = Object.values(pages);
  return {
    approvals: proposal.approvals,
    perPage: pageList.some((p) => p.explicit),
    roles: proposal.roles,
    teams: [...new Set([...proposal.teams, ...pageList.flatMap((p) => p.teams)])],
    ownerTeam: pageList.some((p) => p.ownerTeam),
    distinctTeams: proposal.distinctTeams,
    proposalTeams: proposal.teams,
    reasons: [...proposal.reasons, ...pageList.flatMap((p) => p.reasons)],
    pages,
    canonical,
  };
}

/** Roles the rules demand for resolving a decision of `kind` (proposal-level rules naming that kind). */
export function decisionRoles(kind, rules = []) {
  const roles = new Set();
  for (const rule of rules || []) {
    const when = rule.when || {};
    if (when.decision === undefined || hasPageCondition(when)) continue;
    if (![].concat(when.decision).includes(kind)) continue;
    for (const r of [].concat(rule.require?.roles ?? [])) roles.add(r);
  }
  return [...roles];
}

// ── who may approve ──────────────────────────────────────────────────────────

/** Actor ids that count as "the submitter" for separation of duties. */
export function submittersOf(proposal) {
  return [...new Set([proposal.submittedBy, ...(proposal.submitters || [])].filter(Boolean))];
}

/** Every key the submitter is known by (ids, and emails from the identity registry). */
export function submitterKeysOf(proposal, submitterKeys) {
  if (submitterKeys) return submitterKeys;
  return new Set(submittersOf(proposal).map((id) => `id:${id}`));
}

/** Files outside the writable set: recomputed when a matcher is given, else as recorded. */
export function outsideOf(proposal, allowed) {
  if (allowed) return Array.isArray(proposal.files) ? outsideFiles(proposal.files, allowed) : [{ path: '(unknown)', reason: 'the changed files have not been checked' }];
  return proposal.outside || [];
}

const intersects = (a, b) => [...a].some((k) => b.has(k));

/** Nothing left to add: every page was taken out and no challenge row is being recorded. */
export function isEmpty(proposal) {
  const active = (proposal.changes || []).filter((c) => c.pageStatus !== 'rejected');
  if (active.length) return false;
  return !(proposal.otherFiles || []).some((f) => /(^|\/)canonical-challenges\.md$/.test(f.path));
}
export const EMPTY_MESSAGE = 'Nothing is left to add — every page was taken out. Turn it down to close it.';

/**
 * Throws when `actor` may not approve `proposal` right now. The checks that
 * hold whatever the config says come first.
 *
 * `headSha` is the version the reviewer was shown. It must be the current
 * one: approving "whatever the branch is now" is not reviewing it.
 */
export function assertMayApprove(proposal, actor, {
  separationOfDuties = false, requireSso = false, scope = 'all', channel = 'web',
  headSha, requireHead = false, actorKeys = null, submitterKeys = null, allowed = null,
} = {}) {
  assertCanApprove(actor);   // human + approver role — core, unconditional
  const mine = actorKeys || keysFor(actor.id, actor.email);
  if (separationOfDuties && intersects(mine, submitterKeysOf(proposal, submitterKeys))) {
    throw new ForbiddenError('You sent this in, so someone else has to approve it — separation of duties is on.');
  }
  if (requireSso && actor.idp !== 'oidc' && channel !== 'github-pr') {
    throw new ForbiddenError('Approving needs a single sign-on session. Open the inbox and sign in with SSO.');
  }
  if (!APPROVABLE.includes(proposal.status)) {
    throw new HttpError(409, `This proposal can't be approved — it is ${STATUS_WORDS[proposal.status] || proposal.status}.`);
  }
  const outside = outsideOf(proposal, allowed);
  if (outside.length) throw new HttpError(409, describeOutside(outside));
  if (isEmpty(proposal)) throw new HttpError(409, EMPTY_MESSAGE);
  if (scope !== 'all' && !(proposal.changes || []).some((c) => c.slug === scope && c.pageStatus !== 'rejected')) {
    throw new HttpError(400, `There is no page "${scope}" left in this proposal to approve.`);
  }
  if (requireHead || headSha !== undefined) assertSameHead(proposal, headSha);
}

/** The version a person acted on must be the current one. */
export function assertSameHead(proposal, headSha) {
  if (!headSha) throw new HttpError(400, 'Say which version you reviewed — the request carried no headSha.');
  if (headSha !== proposal.headSha) {
    const err = new HttpError(409, 'This proposal changed since you opened it — review the new version.');
    err.code = 'stale';
    throw err;
  }
}

export const STATUS_WORDS = {
  open: 'waiting for review',
  changes_requested: 'being revised',
  approved: 'approved and still landing',
  merged: 'already added to the knowledge base',
  merged_unaccepted: 'merged on GitHub but not accepted into the knowledge base',
  rejected: 'turned down',
  superseded: 'replaced by a newer version',
  conflicted: 'clashing with recent changes and being revised',
};

// ── evaluation ───────────────────────────────────────────────────────────────

/**
 * The roles an approval counts with: what the approver had when they gave it,
 * cut down to what they have now. Never more than either — a promotion after
 * the fact does not upgrade an old approval, a demotion voids it.
 */
export function capRoles(stored = [], current = []) {
  const now = new Set(current);
  if (now.has('admin')) return [...stored];
  if (stored.includes('admin')) return [...current];
  return stored.filter((r) => now.has(r));
}

function isCountable(a, headSha, submitterKeys, separationOfDuties, keysOfApproval) {
  if (a.headSha !== headSha) return false;                         // pinned to the diff they saw
  if (a.kind !== 'human') return false;                            // belt and braces: never an agent
  if (!(a.roles || []).some((r) => APPROVER_ROLES.includes(r))) return false;
  if (separationOfDuties && intersects(keysOfApproval(a), submitterKeys)) return false;
  return true;
}

/** Largest number of distinct teams covered by distinct people (bipartite matching, tiny inputs). */
export function distinctTeamCount(approvers) {
  const teamOwner = new Map();
  const tryAssign = (person, seen) => {
    for (const team of person.teams || []) {
      if (seen.has(team)) continue;
      seen.add(team);
      const holder = teamOwner.get(team);
      if (!holder || tryAssign(holder, seen)) { teamOwner.set(team, person); return true; }
    }
    return false;
  };
  let n = 0;
  for (const person of approvers) if (tryAssign(person, new Set())) n++;
  return n;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const quote = (s) => `“${s}”`;

function roleWords(roles) {
  return roles.length ? `someone with the ${roles.join(' or ')} role` : '';
}

/**
 * What is still missing for one requirement block, as plain sentences.
 * `who` are the approvals that count toward it.
 */
function gaps(req, who, { forPage = null } = {}) {
  const out = [];
  const people = [...new Map(who.map((a) => [a.personKey || a.actorId, a])).values()];
  const target = forPage ? ` for the page ${quote(forPage.title)}` : '';
  const explicitHint = forPage && req.explicit ? ' (accept that page itself — approving the whole proposal does not cover it)' : '';

  const short = Math.max(0, (req.approvals || 0) - people.length);
  const needRole = req.roles?.length && !people.some((a) => hasRole(a, ...req.roles));
  const teams = req.teams || [];
  const needTeam = teams.length && !people.some((a) => (a.teams || []).some((t) => teams.includes(t)));
  let needOwner = false;
  let ownerWords = '';
  if (req.ownerTeam && forPage) {
    if (forPage.owner) {
      needOwner = !people.some((a) => (a.teams || []).includes(forPage.owner));
      ownerWords = `in team ${forPage.owner}`;
    } else {
      needOwner = !people.some((a) => hasRole(a, 'owner'));
      ownerWords = 'with the owner role (the page has no owner team)';
    }
  }

  if (short || needRole || needTeam || needOwner) {
    const from = [
      needRole ? roleWords(req.roles) : '',
      needOwner ? ownerWords : '',
      needTeam ? `in team ${teams.join(' or ')}` : '',
    ].filter(Boolean);
    const count = !short ? 'an approval'
      : people.length === 0 ? (short === 1 ? 'an approval' : plural(short, 'approval'))
        : plural(short, 'more approval');
    const fromText = from.length ? ` from someone ${from.join(' and ').replace(/^someone with/, 'with')}` : '';
    out.push(`Needs ${count}${fromText}${target}${explicitHint}.`);
  }
  if (req.distinctTeams && distinctTeamCount(people) < req.distinctTeams) {
    out.push(`Needs approvals from ${plural(req.distinctTeams, 'different team')}${target} — so far ${distinctTeamCount(people)}.`);
  }
  return out;
}

/**
 * @param {object} input
 * @param {object} input.proposal    the Proposal (headSha, status, audit, changes, approvals, required)
 * @param {Array}  [input.decisions] its Decision records
 * @param {object} [input.options]   { separationOfDuties, keyring, submitterKeys, allowed,
 *                                     currentRoles: Map actorId → roles now (identity.mjs) }
 * @returns {{ ready: boolean, blockers: Array<{code,message}>, missing: Array<{code,message,slug?}>,
 *             approvers: Array, explanation: string }}
 */
export function evaluate({ proposal, decisions = [], options = {} }) {
  const { separationOfDuties = false, keyring = null, submitterKeys = null, allowed = null, currentRoles = null } = options;
  const required = proposal.required || computeRequirements({ changes: proposal.changes });
  const subKeys = submitterKeysOf(proposal, submitterKeys);
  // One person is one approver, whichever ids and channels they used.
  const keysOfApproval = (a) => keyring?.get(a.actorId)?.keys || keysFor(a.actorId, a.email);
  const personOf = (a) => keyring?.get(a.actorId)?.personKey || (a.email ? `email:${String(a.email).toLowerCase()}` : `id:${a.actorId}`);
  // Roles as they stand now: an approval from someone since demoted stops counting.
  const rolesNow = (a) => (currentRoles?.has(a.actorId) ? capRoles(a.roles || [], currentRoles.get(a.actorId)) : a.roles || []);
  const counted = (proposal.approvals || [])
    .map((a) => ({ ...a, roles: rolesNow(a) }))
    .filter((a) => isCountable(a, proposal.headSha, subKeys, separationOfDuties, keysOfApproval))
    .map((a) => ({ ...a, personKey: personOf(a) }));
  const active = (proposal.changes || []).filter((c) => c.pageStatus !== 'rejected');

  const blockers = [];
  const missing = [];

  // ── blockers: things no number of approvals fixes ─────────────────────────
  if (!APPROVABLE.includes(proposal.status)) {
    blockers.push({ code: 'status', message: `This proposal is ${STATUS_WORDS[proposal.status] || proposal.status}.` });
  }
  const open = decisions.filter((d) => d.status === 'open');
  if (open.length) {
    blockers.push({ code: 'decisions', message: `${plural(open.length, 'question')} ${open.length === 1 ? 'needs' : 'need'} an answer first.` });
  }
  const exit = proposal.audit?.exit;
  if (exit !== 0) {
    const n = proposal.audit?.errors ?? 0;
    blockers.push({
      code: 'audit',
      message: exit === undefined || exit === null
        ? 'The automatic checks have not run on this proposal.'
        : exit === 1
          ? `The automatic checks found ${plural(n, 'problem')} — this can't be added until they're fixed.`
          : 'The automatic checks could not run — this can\'t be added until they do.',
    });
  }
  for (const slug of required.canonical || []) {
    const c = (proposal.changes || []).find((x) => x.slug === slug);
    if (c && c.pageStatus !== 'rejected') {
      blockers.push({
        code: 'canonical',
        slug,
        message: `It changes the locked reference page ${quote(c.title || slug)}. Locked pages are never changed by a proposal — remove that page; any disagreement is recorded as a challenge instead.`,
      });
    }
  }
  const outside = outsideOf(proposal, allowed);
  if (outside.length) blockers.push({ code: 'paths', message: describeOutside(outside), files: outside });
  if (isEmpty(proposal) && !(proposal.changes || []).some((c) => c.pageStatus === 'rejected')) blockers.push({ code: 'empty', message: EMPTY_MESSAGE });
  for (const c of proposal.changes || []) {
    if (c.pageStatus === 'rejected') {
      blockers.push({ code: 'page-removal', slug: c.slug, message: `The page ${quote(c.title || c.slug)} was taken out by a reviewer — waiting for the agent to remove it.` });
    }
  }

  // ── approvals ──────────────────────────────────────────────────────────────
  // A person approves the proposal by approving "all", or by accepting every
  // page still in it one by one.
  const people = new Map();
  for (const a of counted) {
    if (!people.has(a.personKey)) people.set(a.personKey, { ...a, scopes: new Set() });
    people.get(a.personKey).scopes.add(a.scope);
  }
  const wholeApprovers = [...people.values()].filter((p) =>
    p.scopes.has('all') || (active.length > 0 && active.every((c) => p.scopes.has(c.slug))));

  // The floor of one human approval is enforced here, not read from config:
  // a stored `required.approvals: 0` still needs one person.
  const proposalReq = {
    approvals: Math.max(1, required.approvals || 0), roles: required.roles || [],
    teams: required.proposalTeams ?? [], distinctTeams: required.distinctTeams || 0,
  };
  for (const message of gaps(proposalReq, wholeApprovers)) {
    missing.push({ code: wholeApprovers.length === 0 ? 'human' : 'approvals', message });
  }

  for (const [slug, req] of Object.entries(required.pages || {})) {
    const change = active.find((c) => c.slug === slug);
    if (!change) continue;
    const who = counted.filter((a) => a.scope === slug || (!req.explicit && a.scope === 'all'));
    const extra = req.explicit ? [] : wholeApprovers.filter((p) => !who.some((w) => w.personKey === p.personKey));
    for (const message of gaps(req, [...who, ...extra], { forPage: { title: change.title || slug, owner: change.owner || req.owner } })) {
      missing.push({ code: 'page', slug, message });
    }
  }

  const ready = blockers.length === 0 && missing.length === 0;
  const explanation = ready
    ? 'Everything is in place — this can be added to the knowledge base.'
    : [...blockers, ...missing].map((x) => x.message).join(' ');
  return { ready, blockers, missing, approvers: [...people.values()].map(({ scopes, ...a }) => ({ ...a, scopes: [...scopes] })), explanation };
}
