#!/usr/bin/env node
// A scripted agent for the canonical guard tests: writes the files named in $CANON_PLAN and a run report.
import fs from 'node:fs';
import path from 'node:path';

if (process.argv[2] === 'capabilities') {
  process.stdout.write('tool_restriction\tyes\nbudget_cap\tyes\ncost_reporting\tyes\nsession_isolation\tyes\nsandbox\tyes\n');
  process.exit(0);
}
const plan = JSON.parse(fs.readFileSync(process.env.CANON_PLAN, 'utf-8'));
for (const [rel, text] of Object.entries(plan.files)) {
  fs.mkdirSync(path.dirname(path.join(process.cwd(), rel)), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), rel), text);
}
fs.mkdirSync('.almagest', { recursive: true });
fs.writeFileSync('.almagest/run-report.json', JSON.stringify({
  source: { id: plan.sourceId }, outcome: 'written',
  pages: Object.keys(plan.files).map((f) => ({ slug: path.basename(f, '.md'), action: 'update', tier: 'evidence', summary: 'scripted' })),
  blocked: [], notes: 'scripted',
}));
process.stdout.write('{"is_error":false}\n');
