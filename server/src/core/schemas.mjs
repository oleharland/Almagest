/**
 * schemas.mjs — entity vocabularies, ids, and small validators.
 *
 * The entity shapes themselves are documented in docs/v2/spec.md → Entities.
 * This file holds what code needs to agree on mechanically: enum values, how
 * ids are minted, how the agent's run report is checked, and how secrets are
 * sealed before they reach the store.
 */
import crypto from 'node:crypto';

export const JOB_KINDS = ['ingest', 'revise', 'reverify', 'drop-page'];
export const JOB_STATUS = ['queued', 'running', 'succeeded', 'failed', 'blocked', 'cancelled'];
export const JOB_TRIGGERS = ['watch', 'schedule', 'manual', 'mcp', 'hook', 'decision', 'feedback', 'demand'];

export const PROPOSAL_STATUS = ['open', 'changes_requested', 'approved', 'merged', 'merged_unaccepted', 'rejected', 'superseded', 'conflicted'];
export const CHANGE_ACTIONS = ['create', 'update', 'delete', 'rename'];
export const PAGE_STATUS = ['pending', 'accepted', 'rejected'];

export const DECISION_KINDS = [
  'contradiction', 'canonical_conflict', 'delete', 'merge', 'rename', 'low_confidence', 'anonymization',
];
export const DECISION_STATUS = ['open', 'resolved'];

export const ACTOR_KINDS = ['human', 'agent', 'service'];
export const ROLES = ['viewer', 'contributor', 'reviewer', 'owner', 'admin'];
export const APPROVER_ROLES = ['reviewer', 'owner', 'admin'];

export const CHANNEL_KINDS = ['web', 'mcp', 'slack', 'email', 'github-pr', 'cli'];
export const SOURCE_KINDS = ['local', 'remote', 'connector'];

export const RUN_OUTCOMES = ['written', 'unchanged', 'blocked-only', 'failed'];

// ── ids & time ───────────────────────────────────────────────────────────────

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * `<prefix>_<10 chars time><12 chars random>`. Time-first so ids sort by
 * creation in every store without a second column, ULID-style.
 */
export function newId(prefix, now = Date.now()) {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.randomBytes(12);
  let rand = '';
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return `${prefix}_${time}${rand}`;
}

export function nowIso(date = new Date()) {
  return date.toISOString();
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Same slug shape the ingest rules use for filenames and branch names. */
export function slugify(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'source';
}

/** `ingest/<source-slug>-<sha7>` — the branch name non-negotiable 1 names. */
export function ingestBranch(source) {
  const slug = slugify(source.title || source.id || source.path || 'source');
  const sha7 = String(source.sha256 || source.version || '').slice(0, 7) || crypto.randomBytes(4).toString('hex').slice(0, 7);
  return `ingest/${slug}-${sha7}`;
}

// ── validation ───────────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(message, problems = []) {
    super(problems.length ? `${message}: ${problems.join('; ')}` : message);
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

function oneOf(problems, where, value, allowed) {
  if (!allowed.includes(value)) problems.push(`${where} must be one of ${allowed.join(' | ')} (got ${JSON.stringify(value)})`);
}

/**
 * The agent's run report (server/src/core/run-report.schema.json, hand-checked
 * here so the runner needs no JSON Schema dependency). Returns the report with
 * defaults filled, or throws ValidationError listing every problem at once.
 */
export function validateRunReport(report) {
  const problems = [];
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new ValidationError('run report must be an object');
  }
  if (!report.source || typeof report.source.id !== 'string' || !report.source.id) {
    problems.push('source.id is required');
  }
  oneOf(problems, 'outcome', report.outcome, RUN_OUTCOMES);

  const pages = Array.isArray(report.pages) ? report.pages : [];
  if (report.pages !== undefined && !Array.isArray(report.pages)) problems.push('pages must be an array');
  pages.forEach((p, i) => {
    if (!p || typeof p.slug !== 'string' || !p.slug) problems.push(`pages[${i}].slug is required`);
    oneOf(problems, `pages[${i}].action`, p?.action, ['create', 'update']);
  });

  const blocked = Array.isArray(report.blocked) ? report.blocked : [];
  if (report.blocked !== undefined && !Array.isArray(report.blocked)) problems.push('blocked must be an array');
  blocked.forEach((b, i) => {
    oneOf(problems, `blocked[${i}].kind`, b?.kind, DECISION_KINDS);
    if (!b || typeof b.question !== 'string' || !b.question) problems.push(`blocked[${i}].question is required`);
    if (!Array.isArray(b?.options) || b.options.length === 0) problems.push(`blocked[${i}].options needs at least one option`);
  });

  if (problems.length) throw new ValidationError('invalid run report', problems);
  return { ...report, pages, blocked, notes: report.notes || '' };
}

// ── secrets ──────────────────────────────────────────────────────────────────

function keyFrom(secret) {
  if (!secret) throw new Error('ALMAGEST_SECRET_KEY is not set — required to store connector credentials');
  return crypto.createHash('sha256').update(String(secret)).digest();
}

/** AES-256-GCM. Output: `v1.<iv>.<tag>.<ciphertext>`, base64url parts. */
export function seal(plaintext, secret = process.env.ALMAGEST_SECRET_KEY) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(String(plaintext), 'utf-8'), cipher.final()]);
  return ['v1', iv, cipher.getAuthTag(), body].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
}

export function unseal(sealed, secret = process.env.ALMAGEST_SECRET_KEY) {
  const [v, iv, tag, body] = String(sealed).split('.');
  if (v !== 'v1') throw new Error('unknown sealed-value version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf-8');
}

/** Keyed hash for telemetry fields stored as `hashed` — stable per instance, not reversible. */
export function pseudonymize(value, secret = process.env.ALMAGEST_SECRET_KEY || 'almagest') {
  return crypto.createHmac('sha256', String(secret)).update(String(value)).digest('hex').slice(0, 16);
}
