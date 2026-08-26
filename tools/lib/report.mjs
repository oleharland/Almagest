/**
 * report.mjs — the human report.
 *
 * Format is the house style already specified in `agent/rules/wiki.md` §Audit:
 * box-drawn header, one emoji per category, per-finding bullets with a `→`
 * suggestion, a counts block, and an action-item total. Two categories are new
 * — 📎 citations and 🧾 provenance — because schema v2 has checks the original
 * key predates.
 */
import { CATEGORIES, categoryOf } from './checks.mjs';

const RULE = '━'.repeat(60);
const MAX_PER_CATEGORY = 20;

export function colors(enabled) {
  if (!enabled) {
    return { red: (s) => s, yel: (s) => s, grn: (s) => s, dim: (s) => s, bld: (s) => s };
  }
  const wrap = (code) => (s) => `\u001b[${code}m${s}\u001b[0m`;
  return { red: wrap(31), yel: wrap(33), grn: wrap(32), dim: wrap(2), bld: wrap(1) };
}

function label(finding) {
  if (finding.page) return finding.file || finding.page;
  return finding.file || '(brain)';
}

function pad(text, width) {
  // Emoji are double-width in most terminals; count them as two columns so the
  // summary block lines up.
  const visible = [...text].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2100 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(1, width - visible));
}

export function renderReport(findings, meta, opts = {}) {
  const c = colors(opts.color !== false);
  const lines = [];
  const grouped = new Map(CATEGORIES.map((cat) => [cat.key, []]));
  for (const finding of findings) grouped.get(categoryOf(finding.id).key).push(finding);

  lines.push(RULE);
  lines.push(`🔎 Wiki Audit — ${meta.pageCount} page${meta.pageCount === 1 ? '' : 's'} scanned`);
  lines.push(RULE);

  for (const cat of CATEGORIES) {
    const items = grouped.get(cat.key);
    if (items.length === 0) continue;
    lines.push('');
    lines.push(`${cat.emoji} ${cat.label} (${items.length})`);

    for (const finding of items.slice(0, MAX_PER_CATEGORY)) {
      const tag = finding.severity === 'error' ? c.red(finding.id) : c.yel(finding.id);
      const where = finding.line ? `${label(finding)}:${finding.line}` : label(finding);
      const times = finding.count > 1 ? c.dim(` ×${finding.count}`) : '';
      lines.push(`  • ${where} — ${tag} ${finding.message}${times}`);
      if (finding.hint) lines.push(`    ${c.dim('→ ' + finding.hint)}`);
    }
    if (items.length > MAX_PER_CATEGORY) {
      lines.push(c.dim(`  … and ${items.length - MAX_PER_CATEGORY} more — run with --json for the full list`));
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;

  lines.push('');
  lines.push(RULE);
  lines.push('📋 Audit summary');
  lines.push(RULE);
  for (const cat of CATEGORIES) {
    const items = grouped.get(cat.key);
    if (items.length === 0) continue;
    const mark = items.some((f) => f.severity === 'error') ? c.red('❌') : c.yel('⚠️');
    lines.push(`  ${cat.emoji} ${pad(cat.label + ':', 18)}${String(items.length).padStart(3)}  ${mark}`);
  }
  lines.push('  ' + '─'.repeat(22));
  lines.push(
    `  ${c.red('❌')} ${pad('Errors:', 18)}${String(errors).padStart(3)}` + (errors > 0 ? '   → exit 1' : '')
  );
  lines.push(`  ${c.yel('⚠️')} ${pad('Warnings:', 18)}${String(warnings).padStart(3)}`);
  lines.push(`  ⚡ ${pad('Action items:', 18)}${String(findings.length).padStart(3)}`);

  if (meta.exempt?.length) {
    lines.push('');
    lines.push(
      c.dim(
        `  ${meta.exempt.length} template page${meta.exempt.length === 1 ? '' : 's'} ` +
          `exempt from PROV-001 / PROV-003 / CITE-005: ${meta.exempt.join(', ')}`
      )
    );
  }
  if (meta.legacySources) {
    lines.push(
      c.dim(`  ${meta.legacySources} source entr${meta.legacySources === 1 ? 'y' : 'ies'} still in the retired v1 string form`)
    );
  }

  lines.push('');
  if (findings.length === 0) {
    lines.push(c.grn('✓ Clean — no findings.'));
  } else {
    lines.push('👉 What would you like to address?');
  }

  return lines.join('\n') + '\n';
}

/**
 * Machine-readable findings.
 *
 * The finding shape is the one `docs/audit.md` documents — id, severity, slug,
 * path, line, message — plus two additive keys the human report already
 * carries: `hint` and `count`. Additive, so a consumer reading the documented
 * six is unaffected.
 */
export function renderJson(findings, meta) {
  const errors = findings.filter((f) => f.severity === 'error').length;
  return JSON.stringify(
    {
      ok: errors === 0,
      pages: meta.pageCount,
      counts: { errors, warnings: findings.length - errors, total: findings.length },
      exempt: meta.exempt ?? [],
      findings: findings.map((f) => ({
        id: f.id,
        severity: f.severity,
        slug: f.page,
        path: f.file,
        line: f.line,
        message: f.message,
        hint: f.hint,
        count: f.count,
      })),
    },
    null,
    2
  ) + '\n';
}
