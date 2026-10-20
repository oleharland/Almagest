/**
 * challenges.mjs — appending to brain/canonical-challenges.md.
 *
 * The ledger is how a canonical page that has drifted from reality becomes
 * visible without the page itself ever being changed by a proposal
 * (non-negotiable 4). Rows are appended, never edited away; this file only
 * ever adds one.
 */
const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();

export function challengeRow({ date, slug, claim, source, status = 'open' }) {
  return `| ${cell(date)} | [[${cell(slug)}]] | ${cell(claim)} | ${cell(source)} | ${cell(status)} |`;
}

const HEADER = '| Date | Canonical page | Challenging claim | Source | Status |\n|---|---|---|---|---|';

/** `text` with `row` appended to the `## Challenges` table (created when absent). */
export function appendChallenge(text, row) {
  const src = String(text ?? '');
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s+challenges\s*$/i.test(l.trim()));
  if (start < 0) {
    const base = src.trim() ? src.replace(/\n*$/, '\n\n') : '# Canonical challenges\n\n';
    return `${base}## Challenges\n\n${HEADER}\n${row}\n`;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i].trim())) { end = i; break; }
  }
  let last = -1;
  for (let i = start + 1; i < end; i++) if (lines[i].trim().startsWith('|')) last = i;
  if (last < 0) {
    lines.splice(start + 1, 0, '', HEADER, row);
  } else {
    lines.splice(last + 1, 0, row);
  }
  const out = lines.join('\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}

/**
 * The challenging claim and its source for a canonical_conflict decision.
 * Convention: A is what the wiki already says, B is the new material. A
 * decision that only filled A is treated as the new claim.
 */
export function challengeFrom(decision, { date, fallbackSource = '' } = {}) {
  const ctx = decision.context || {};
  const claim = ctx.claimB || ctx.claimA || decision.question;
  const source = (ctx.claimB ? ctx.sourceB : ctx.sourceA) || fallbackSource;
  return { date, slug: decision.slug || '', claim, source, status: 'open' };
}
