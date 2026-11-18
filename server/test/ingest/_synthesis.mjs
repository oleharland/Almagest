/**
 * _synthesis.mjs — scaffolding for the learnings tests (not a test file).
 *
 * A brain on `main` that holds source pages from three different documents
 * (alpha and beta cite one document, delta another, epsilon a third) and two
 * claim pages, so each rule the runner checks has something to break.
 */
import crypto from 'node:crypto';

const SIDECAR_B = '=== page 1 ===\nDelta retries three times.\n';
const SIDECAR_C = '=== page 1 ===\nEpsilon retries once.\n';
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const SHA_A = '3b50e003ca81fc8afceca1f8d8a259adfd2a3940144e429640ee160e4f8677d9';

export const SOURCES = {
  'beta-pdf': { file: 'brain/raw/extracted/beta.pdf.txt', text: SIDECAR_B, sha: sha(SIDECAR_B), title: 'Beta overview' },
  'gamma-pdf': { file: 'brain/raw/extracted/gamma.pdf.txt', text: SIDECAR_C, sha: sha(SIDECAR_C), title: 'Gamma overview' },
};

const MANIFEST = `version: 1

sources:
  - id: alpha-pdf
    kind: local
    path: brain/raw/processed/alpha.pdf
    sha256: 1111111111111111111111111111111111111111111111111111111111111111
    extracted: brain/raw/extracted/alpha.pdf.txt
    extracted_sha256: ${SHA_A}
    bytes: 1024
    first_ingested: 2026-01-01
    last_ingested: 2026-01-01
    pages:
      - alpha
      - beta
    status: ingested
  - id: beta-pdf
    kind: local
    path: brain/raw/processed/beta.pdf
    sha256: 2222222222222222222222222222222222222222222222222222222222222222
    extracted: ${SOURCES['beta-pdf'].file}
    extracted_sha256: ${SOURCES['beta-pdf'].sha}
    bytes: 2048
    first_ingested: 2026-01-01
    last_ingested: 2026-01-01
    pages:
      - delta
    status: ingested
  - id: gamma-pdf
    kind: local
    path: brain/raw/processed/gamma.pdf
    sha256: 3333333333333333333333333333333333333333333333333333333333333333
    extracted: ${SOURCES['gamma-pdf'].file}
    extracted_sha256: ${SOURCES['gamma-pdf'].sha}
    bytes: 2048
    first_ingested: 2026-01-01
    last_ingested: 2026-01-01
    pages:
      - epsilon
    status: ingested
`;

const INDEX = `---
title: "Knowledge Base Index"
type: system
---

# Index

## Wiki pages

| Page | Type | Tier | Status | Last modified |
|------|------|------|--------|---------------|
| [[alpha]] | topic | curated | draft | 2026-01-05 |
| [[beta]] | entity | curated | draft | 2026-01-05 |
| [[delta]] | topic | curated | draft | 2026-01-05 |
| [[epsilon]] | topic | curated | draft | 2026-01-05 |
| [[eta-claim]] | claim | curated | draft | 2026-01-05 |
| [[gamma-claim]] | claim | curated | draft | 2026-01-05 |

## Raw sources (local)

| Source file | Ingested | Pages created/updated |
|------------|----------|-----------------------|
| \`brain/raw/extracted/alpha.pdf.txt\` | 2026-01-01 | alpha, beta |
| \`${SOURCES['beta-pdf'].file}\` | 2026-01-01 | delta |
| \`${SOURCES['gamma-pdf'].file}\` | 2026-01-01 | epsilon |
`;

/** A source page citing one document. */
export function sourcePage({ title, sourceId, alias = '', modified = '2026-01-05', body = 'It retries.' }) {
  const src = SOURCES[sourceId];
  return `---
title: ${JSON.stringify(title)}
type: topic
tier: curated
origin: source
status: draft
confidence: medium
tags: []
aliases: [${alias ? JSON.stringify(alias) : ''}]
owner: ""
date_created: "2026-01-02"
date_modified: "${modified}"
last_verified: "${modified}"
sources:
  - id: ${sourceId}
    path: ${src.file}
    sha256: "${src.sha}"
    title: ${JSON.stringify(src.title)}
related: []
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

## Summary

${title}.

## Details

${body} [source: ${sourceId}, p.1]
`;
}

/** A claim page that is already on main. */
export function claimPage({ title, basis }) {
  return `---
title: ${JSON.stringify(title)}
type: claim
tier: curated
origin: self
status: draft
confidence: medium
tags: []
aliases: []
owner: ""
date_created: "2026-01-05"
date_modified: "2026-01-05"
last_verified: "2026-01-05"
sources: []
related: []
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

## Summary

${title}.

## Basis

${basis.map((b) => `- [[${b}]]`).join('\n')}
`;
}

/** Files for `setup({ files })` / `makeTempRepo({ files })`. */
export function seedFiles() {
  return {
    'brain/manifest.yaml': MANIFEST,
    'brain/index.md': INDEX,
    [SOURCES['beta-pdf'].file]: SOURCES['beta-pdf'].text,
    [SOURCES['gamma-pdf'].file]: SOURCES['gamma-pdf'].text,
    'brain/wiki/delta.md': sourcePage({ title: 'Delta Service', sourceId: 'beta-pdf', body: 'Delta retries three times.' }),
    'brain/wiki/epsilon.md': sourcePage({ title: 'Epsilon Service', sourceId: 'gamma-pdf', body: 'Epsilon retries once.' }),
    'brain/wiki/eta-claim.md': claimPage({ title: 'Delta and Epsilon retry differently', basis: ['delta', 'epsilon'] }),
  };
}

/** Commit files on `main` of a temp repo (the repo's own checkout; tests only). */
export function commitOnMain(t, files, message = 'change') {
  for (const [rel, content] of Object.entries(files)) t.write(rel, content);
  t.git('add', '-A');
  t.git('commit', '-q', '-m', message);
  return t.git('rev-parse', 'main').trim();
}
