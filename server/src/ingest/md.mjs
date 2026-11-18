/**
 * md.mjs — the two Markdown table edits the runner and the fake driver make
 * mechanically to index.md and log.md. Line-based on purpose: rewriting the
 * whole file through a Markdown parser would reflow tables a human wrote, and
 * the diff a reviewer reads would be mostly noise.
 */

/** Insert `row` after the last table line under `headingRe`, creating the section from `header` if absent. */
export function appendTableRow(md, headingRe, header, row) {
  const lines = md.split('\n');
  const h = lines.findIndex((l) => headingRe.test(l));
  if (h === -1) return `${md.replace(/\n*$/, '\n')}\n${header}\n${row}\n`;
  let last = -1;
  for (let i = h + 1; i < lines.length; i++) {
    if (/^#{1,6}\s/.test(lines[i])) break;
    if (lines[i].trim().startsWith('|')) last = i;
  }
  if (last === -1) {
    lines.splice(h + 1, 0, '', ...header.split('\n').filter((l) => l.trim().startsWith('|')), row);
  } else if (/^\|\s*_?\((no|none)\b/i.test(lines[last])) {
    // A placeholder row like `| _(no actions yet)_ | | |` gives way to the first real one.
    lines.splice(last, 1, row);
  } else {
    lines.splice(last + 1, 0, row);
  }
  return lines.join('\n');
}

/**
 * Drop table rows under `headingRe` whose FIRST cell links `[[slug]]`.
 * Returns the text unchanged (same string) when nothing matched, so callers
 * can write-if-changed by comparing.
 */
export function removeTableRowsFor(md, headingRe, slug) {
  const lines = md.split('\n');
  const h = lines.findIndex((l) => headingRe.test(l));
  if (h === -1) return md;
  const link = new RegExp(`^\\|\\s*\\[\\[${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\|[^\\]]*)?\\]\\]\\s*\\|`);
  let changed = false;
  const out = [];
  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    if (i === h) inSection = true;
    else if (inSection && /^#{1,6}\s/.test(lines[i])) inSection = false;
    if (inSection && link.test(lines[i])) { changed = true; continue; }
    out.push(lines[i]);
  }
  return changed ? out.join('\n') : md;
}
