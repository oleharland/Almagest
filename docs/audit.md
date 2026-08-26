# The Audit Tool

`tools/audit.mjs` checks that the wiki says only what it can back up. It reads `brain/wiki/`, `brain/manifest.yaml`, `brain/index.md`, and `brain.config.yaml`, reports every violation it finds, and **never changes a file** — except in `index` mode, which writes `brain/.index/` and nothing else.

It is a deterministic Node program, not the agent reading pages. That distinction is the point: the same twenty checks run identically on your laptop, in the agent's ingest loop, and in CI, and the exit code means the same thing in all three.

## Why it is a program

The checks it runs were previously prose in `agent/rules/wiki.md` — an instruction to the agent to go and look. That fails three ways:

- **Non-deterministic.** The same wiki audits differently on two runs, and differently again on a different model.
- **Unrunnable in CI.** A pull request cannot ask a rules file whether the citations resolve.
- **Slow and expensive.** Re-deriving structural checks over every page, every time, is the worst possible use of a model.

Everything the tool checks is mechanical: string comparison, hex comparison, grammar parsing, graph reachability, date arithmetic. None of it needs judgment, so none of it should cost judgment.

### One parser, shared with the site

The audit does not reimplement frontmatter parsing, wikilink resolution, the backlink graph, or the citation grammar. There is one implementation and both consumers use it:

| File | What it is |
|---|---|
| `tools/lib/wiki-core.mjs` | Plain ESM. **The single implementation** — frontmatter, wikilinks, backlink graph, citation grammar |
| `tools/audit.mjs` | Imports it directly |
| `site/src/lib/wiki.ts` | A thin typed wrapper around it |

The core lives under `tools/` rather than under `site/` for a blunt reason: Node 22 cannot import TypeScript, so a `.mjs` tool cannot depend on a `.ts` loader. The dependency points from the typed wrapper down to the plain-ESM core, never the other way.

The consequence is what matters: **what the audit validates is exactly what the site renders.** A page that audits clean and renders wrong is a bug in one shared parser, not a divergence between two.

## Running it

```bash
node tools/audit.mjs                 # full audit, human report to stdout
node tools/audit.mjs --json          # machine-readable findings
node tools/audit.mjs index           # regenerate brain/.index/
node tools/audit.mjs --check-index   # verify brain/.index/ is current (CI)
```

Requires Node 22. No dependencies beyond what `site/` already installs (`gray-matter`, `marked`).

### Exit codes

| Code | Means |
|---|---|
| `0` | Clean. Warnings may still have been reported |
| `1` | Violations found — at least one error-severity finding |
| `2` | Tool error — bad config, unreadable file, crash |

Warnings never change the exit code. That is deliberate: an orphan page or a stale `last_verified` is a thing to look at, not a thing that should stop a merge.

## What it checks

Check IDs are **frozen**. `agent/rules/wiki.md`, `brain.config.yaml`, and the report all reference them by ID, so they do not get renamed.

### Schema — does the frontmatter hold up?

| ID | Detects | Severity |
|---|---|---|
| `SCHEMA-001` | Missing required frontmatter field | error |
| `SCHEMA-002` | Invalid enum value (`type` / `tier` / `status` / `confidence` / `origin`) | error |
| `SCHEMA-003` | Missing `type_fields` entry required for this `type` | error |
| `SCHEMA-004` | `owner` missing or not in `owner_teams` while `require_owner: true` | error |
| `SCHEMA-005` | `type` carries a `type_fields` vocabulary value (e.g. `type: organisation`) | error |

`SCHEMA-005` catches the single most common authoring mistake: `page_types` and the `type_fields` vocabularies are separate lists, and an organisation is `type: entity` with `entity_type: organisation`.

### Links — does the graph resolve?

| ID | Detects | Severity |
|---|---|---|
| `LINK-001` | `[[wikilink]]` to a page that does not exist | error |
| `LINK-002` | Orphan — zero backlinks | warning |
| `LINK-003` | `relations` target does not exist | error |

A broken link is an error because it is a promise the wiki cannot keep. An orphan is a warning because a page nothing links to is often just new.

### Citations — is every claim attributable?

| ID | Detects | Severity |
|---|---|---|
| `CITE-001` | Citation does not parse against the frozen grammar | error |
| `CITE-002` | Citation `id` is not in that page's `sources` | error |
| `CITE-003` | Unsourced claim — a body block outside `## Summary`, `## Open questions`, and `## Basis` with no `[source:` and `origin: source` | error |
| `CITE-004` | `origin: source` page with empty `sources` | error |
| `CITE-005` | `sources[].sha256` disagrees with `manifest.yaml` — citations are stale | error |
| `CITE-006` | `origin: self` page with no `## Basis` section, or a `## Basis` bullet that is not a wikilink | error |

The grammar these parse against:

```
[source: <id>, <locator>]
[source: <id>, <locator>, (<date>)]
[source: unknown]
```

`<locator>` is one of `§<section name>` · `p.<n>` · `pp.<n>-<m>` · `row <n>` · `slide <n>` · `t <hh:mm:ss>` · `line <n>`.

`CITE-005` is the check that earns the object-form `sources`. When a source is re-ingested and its bytes change, every page citing it now points at page numbers and section names that may have moved. The sha mismatch says so, page by page, instead of leaving the citations quietly wrong.

### Provenance — does the paper trail exist?

| ID | Detects | Severity |
|---|---|---|
| `PROV-001` | `sources[].path` does not exist on disk | error |
| `PROV-002` | `manifest.yaml` entry names a `pages` slug that does not exist | error |
| `PROV-003` | A page's source is absent from `manifest.yaml` | error |
| `PROV-004` | `index.md` names a page that does not exist | error |
| `PROV-005` | A page exists in `brain/wiki/` with no `index.md` row | warning |

These five are the drift detector for the three records that must agree: the wiki, the manifest, and the index. Repair follows `agent/rules/ingest.md` → *Drifted manifest*, whose precedence rule is `wiki/` > `index.md` > `manifest.yaml`.

`PROV-004` and `PROV-005` are the two directions of one drift and are deliberately not the same severity. An `index.md` row naming a page that does not exist **asserts something false** — a reader is sent to a page that isn't there. A page with no row asserts nothing; it is bookkeeping that has not caught up. Failing a build on the second would punish tidiness rather than truth, so it is a warning.

### Canonical and staleness

| ID | Detects | Severity |
|---|---|---|
| `CANON-001` | Outstanding entries in `brain/canonical-challenges.md` | warning |
| `STALE-001` | `last_verified` past threshold | warning |

`CANON-001` is informational by design. An open challenge means evidence contradicts a canonical page and a human has not yet ruled — that is a queue, not a failure. It stays visible in every audit run until the row's status changes.

## Template pages are partly exempt — read this

**Pages whose slug begins with `_` skip three checks: `PROV-001`, `PROV-003`, and `CITE-005`.**

This is a real hole and it is documented here rather than buried because someone could hide a page in it.

Why it exists: `brain/wiki/_example.md` and `brain/wiki/_example-claim.md` ship with the framework to show schema v2. They cite a source that does not exist, because a template cannot ship with a real ingested PDF and a matching `manifest.yaml` entry. Without the exemption, every fresh fork fails CI on day one over two files the user has not written — and the first experience of the audit becomes "this tool is broken."

What the exemption does **not** cover. Everything else still applies to `_`-prefixed pages:

| Still enforced | Exempt |
|---|---|
| All `SCHEMA-*` | `PROV-001` — `sources[].path` does not exist on disk |
| All `LINK-*` | `PROV-003` — source absent from `manifest.yaml` |
| `CITE-001` · `CITE-002` · `CITE-003` · `CITE-004` · `CITE-006` | `CITE-005` — `sha256` disagrees with the manifest |
| `CANON-001` · `STALE-001` | |

So a template page must still have valid frontmatter, resolving wikilinks, parseable citations naming an `id` in its own `sources`, and a `## Basis` if it is `origin: self`. Only the three checks that reach outside the page — to the filesystem and the manifest — are skipped.

**Never use a leading underscore on a real page.** It is not a "draft" or "private" marker; it means "this page's provenance is not checked." A real page with unverifiable provenance is exactly the thing the audit exists to catch. Delete both examples once you have written your first real page.

## Configuration

Thresholds and severities come from `brain.config.yaml` → `audit`. Nothing is hardcoded.

```yaml
audit:
  stale_after_days:
    canonical: 0         # never stale
    curated: 90
    evidence: 90
    stub: 30             # by status; wins over the tier threshold
  severity:
    errors: [SCHEMA-001, …]
    warnings: [LINK-002, CANON-001, STALE-001]
  challenges_path: brain/canonical-challenges.md
  index_dir: brain/.index
```

Moving an ID between `errors` and `warnings` changes what fails a build. Do it deliberately — demoting a `CITE-*` check to a warning means the wiki can assert things it cannot back up and still go green.

## The derived index

`node tools/audit.mjs index` writes `brain/.index/`, which is **committed, not gitignored** — the same idiom as the generated harness shims, and verified in CI with `--check-index`. Output is deterministic: sorted by slug, tab-separated, `\n` line endings, no timestamps, so it diffs cleanly and never churns.

`brain/.index/pages.tsv` — header row, then one row per page:

```
slug	title	type	tier	status	origin	confidence	aliases	tags	source_ids	backlinks	last_verified
```

Multi-value cells are `|`-separated. Empty cells are empty strings, never `-`.

`brain/.index/aliases.tsv` — header `alias\tslug`, one row per alias **and** one per title (lowercased).

That second file is the one that pays for itself. Entity dedup during ingest — "does a page for this thing already exist?" — becomes a single `grep` against a sorted file, instead of a model reading `index.md` and deciding.

## CI

Two jobs, both cheap:

```yaml
- run: node tools/audit.mjs                 # fails the build on exit 1
- run: node tools/audit.mjs --check-index   # fails if brain/.index/ is out of date
```

`--check-index` regenerates the index in memory and compares it byte-for-byte against what is committed. It exits `1` on any difference and does not write. If it fails, run `node tools/audit.mjs index` and commit the result.

## How the agent uses it

The agent **runs the tool**. It does not perform the checks by hand and does not argue with the exit code.

- Before committing to an `ingest/<slug>-<sha7>` branch, run the audit. **Any error-severity finding blocks the commit entirely** — fix the finding or drop the page from the batch.
- On "audit the wiki", run it and present the report.
- After any fix session, run it again before proposing the diff.

Everything the agent does in response to a finding is a proposal. The audit reports; the human decides; the merge to `main` is the gate. See `agent/rules/wiki.md` → *Approval gates*.

## Report format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔎 Wiki Audit — 47 pages scanned
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Schema (2)
  • wiki/concept-x.md — SCHEMA-001 missing `tier`
  • wiki/tool-y.md — SCHEMA-005 `type: organisation` is an entity_type

📎 Citations (2)
  • wiki/failover.md:31 — CITE-002 id `site-survey` not in this page's sources
  • wiki/warranty-risk.md — CITE-006 origin: self with no ## Basis section

🕸️ Stale (1)
  • wiki/data-pipeline.md — STALE-001 last verified 2026-03-15 (137 days, curated)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Audit summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📋 Schema:          2  ❌
  📎 Citations:       2  ❌
  🕸️ Stale:           1  ⚠️
  ──────────────────────
  ❌ Errors:          4   → exit 1
  ⚠️ Warnings:        1
  ⚡ Action items:    5

👉 What would you like to address?
```

**Emoji key:** 🔎 audit · 📋 schema · 🔗 broken link · 📎 citation · 🧾 provenance · 🕸️ stale · 👻 orphan · 🛡️ canonical challenge · ❌ error · ⚠️ warning · ⚡ action items · 👉 awaiting input.

## `--json`

`--json` emits one envelope object, for anything that wants the findings without parsing a box-drawn report:

```json
{
  "ok": false,
  "pages": 42,
  "counts": { "errors": 4, "warnings": 1, "total": 5 },
  "exempt": ["_example", "_example-claim"],
  "findings": [
    {
      "id": "CITE-002",
      "severity": "error",
      "slug": "failover",
      "path": "brain/wiki/failover.md",
      "line": 31,
      "message": "citation id `site-survey` is not in this page's sources",
      "hint": "add it to `sources`, or correct the id",
      "count": 1
    }
  ]
}
```

| Key | What |
|---|---|
| `ok` | `false` when any error-severity finding was raised — the same condition as exit `1` |
| `pages` | How many pages were scanned |
| `counts` | `errors`, `warnings`, `total` |
| `exempt` | **Slugs that skipped the provenance checks** — the machine-readable form of the exemption notice. See *Template pages are partly exempt* above |
| `findings` | The findings array |

Per finding: `id`, `severity`, `slug`, `path`, `line`, `message`, plus `hint` (the suggested fix, the same text the terminal report prints after `→`) and `count` (how many occurrences this finding collapses, for checks that can fire repeatedly on one page).

`exempt` is the reason this is an envelope rather than a bare array. The exemption must never be silent: a bare array has nowhere to say "these two pages were not fully checked", and a consumer that cannot see that would report a clean audit over pages whose provenance was never verified.
