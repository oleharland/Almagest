# Brain — Wiki Write Rules

**Load this when** you are about to create, edit, delete, or merge anything in `brain/wiki/`, or run an audit. Read it in full before proposing a change; it is the authoritative version. It also owns the contradiction protocol that `agent/rules/ingest.md` routes into.

Rules for creating and editing wiki pages. These activate when working with wiki files.

**Before starting any wiki session, read `brain.config.yaml` for instance-specific configuration.**

## Name anonymization

**Controlled by `brain.config.yaml` → `anonymization.enabled`.**

- **`enabled: false` (the default)** — skip this whole section. Names are ordinary content.
- **`enabled: true`** — **no personal names in wiki pages**, anywhere: body text, frontmatter, source paths, inline citations.

### When you encounter a name (only when `enabled: true`)

1. **STOP** — do not write the name to any wiki file.
2. **Alert the user** — show what name was found and where.
3. **Propose a role-based replacement** — a role label with the name stripped (`Engineering Lead, Acme Corp`), consistent across the page and every page derived from the same source.
4. **Wait for approval** before writing the anonymized version.

### What counts as a name

- First names, last names, full names
- **Source file paths in `sources:` must also be anonymized** — if a raw file has a name in its filename, it must be renamed during ingest before the reference is written
- Names in inline citations must use role identifiers, not personal names
- No personal names anywhere — body text, frontmatter, source paths, inline citations

### Detection is best-effort, and says so

`anonymization.role_patterns` **no longer exists**. It held three regexes matching `Firstname Lastname, Job Title`, which caught a rounding error of real names — no title appended, possessives, initials, non-Western name shapes, names in filenames — while looking like coverage. That appearance is the danger: a config block that reads as solved is what stops a reviewer reading the diff, in exactly the GDPR case the setting exists for.

What replaces it:

| Layer | What it is | What it is worth |
|---|---|---|
| Agent NER pass | You read the source and flag every name-shaped token before extraction | Best-effort. Assume misses |
| `anonymization.ignore_names` | Fixed list of company/product terms that are not personal data | Suppresses false positives — a job a fixed list is good at |
| **Human diff review** | The reviewer reads the branch diff before merge | **The actual control.** The other two are aids to it |

Never tell the user a page is anonymized. Tell them what you found and replaced, and that the diff still needs their eyes.

## Approval gates

**Non-negotiable #1 is "no unreviewed writes."** Not "no writes without an in-session yes" — the gate moved from the keystroke to the diff.

- The agent **never writes to `brain/wiki/` on `main`.** Ingest creates and commits to a branch named `ingest/<source-slug>-<sha7>`, where `<sha7>` is the first 7 characters of the source's `sha256` (or commit SHA, for remote sources).
- **`main` is reached only by a human merging a reviewed diff.** That merge is the gate. There is no flag that bypasses it and no auto-merge mode.
- Unattended ingest onto a branch is permitted and supported. Unattended merge is forbidden.

### What still blocks in-session, even on the branch

A branch is cheap; a wrong merge is not. These situations stop the run rather than landing on the branch, because a reviewer reading a diff cannot see the thing that was resolved away before the diff existed.

| Situation | On the ingest branch |
|---|---|
| Evidence-tier additive page, audit clean | Lands automatically |
| Curated-tier new page or update, audit clean | Lands automatically |
| Contradiction with any existing page | **Blocks** — resolve in-session or leave unwritten |
| Contradicts a canonical page | **Blocks** — logged to `canonical-challenges.md`, never merged silently |
| Deletion, merge, or rename of an existing page | **Blocks** |
| `confidence: low` on a curated page | **Blocks** |
| Any audit error (`exit 1`) | **Blocks the commit entirely** |

"Blocks" means: present the situation, propose a resolution, wait. Nothing is written until the user decides. A blocked item that the user does not resolve stays unwritten — the source stays in `raw/`, nothing is lost.

Run `tools/audit.mjs` **before** committing to the branch, not after. An error-level finding means the commit does not happen; fix the finding or drop the page from the batch.

## Handling contradictions

When new information contradicts what is already in the wiki:

1. **Surface it immediately.** Before proposing any change, present the contradiction clearly:
   - Quote the existing claim (page, section, source)
   - Quote the new claim (source file, page/section)
   - State what is incompatible and why
2. **Do not silently overwrite.** Never replace an existing claim with a contradicting one without flagging it.
3. **Propose a resolution:**
   - **Replace** — the new source is more authoritative or more recent (state why)
   - **Amend** — both can be true under different conditions — keep both with context
   - **Flag as disputed** — add both claims with their sources and mark the section `> Disputed — [brief reason]. See sources.`
   - **Reject the new data** — the existing source is stronger
4. **User decides.** The agent presents the options; the user picks. If the user doesn't decide, the new data stays in `raw/` (not lost) but does not enter the wiki.
5. **Record the edge.** A page that is incompatible with another names it in `relations.contradicts`. That is what makes this protocol machine-checkable instead of a convention — see *Typed relations* below.
6. **Log it.** Every resolved contradiction gets a line in `log.md` noting what was contradicted, what was decided, and why.

## Wiki page template

**Reserved slugs.** A page file must never be named like an agent instruction file, in any letter case: `claude`, `claude.local`, `agents`, `agent`, `gemini`, `skill`, `copilot-instructions`, or anything ending `.mdc`. On a case-insensitive file system `brain/wiki/claude.md` *is* the `CLAUDE.md` a harness loads as instructions, so the service refuses such a file anywhere in a proposal. Give the subject a longer slug (`claude-ai-assistant`, `agents-team`) and keep the short name in `aliases`.

Schema **v2**. Every wiki page must have this frontmatter:

```yaml
---
title: ""              # required
type: ""               # required — value from brain.config.yaml → page_types
tier: ""               # required — canonical | curated | evidence
origin: source         # required — source | self
status: ""             # required — stub | draft | evergreen
confidence: ""         # required — high | medium | low | unknown
tags: []               # lowercase, for filtering
aliases: []            # alternative names for this page's subject
owner: ""              # optional unless require_owner
date_created: ""       # ISO date
date_modified: ""      # ISO date
last_verified: ""      # ISO date — last human confirmation
sources: []            # list of OBJECTS — see below
related: []            # untyped "see also" [[wikilinks]]
relations:             # typed edges — all keys optional
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---
```

### Field definitions

- **title** — the page's human-readable name. For `type: claim`, a sentence, not a noun phrase.
- **type** — a value from `page_types`. Never a `type_fields` vocabulary value: an organisation is `type: entity` with `entity_type: organisation`, never `type: organisation`. The two vocabularies are separate and mixing them is audit check `SCHEMA-005`.
- **tier** — `canonical` | `curated` | `evidence`. Determines how strictly the page is protected. See *Content tiers*.
- **origin** — where the page's claims come from. `source` or `self`. See *`origin`* below. This is the field that decides whether inline citations are required, so getting it wrong is not cosmetic.
- **status** — `stub` | `draft` | `evergreen`. `stub` carries a tighter staleness threshold (30 days, vs 90).
- **confidence** — how well-sourced the page content is:
  - `high` — verified against a primary source (demo, release notes, contract, shipped product)
  - `medium` — inferred from a credible secondary source (presentation, call transcript, internal doc)
  - `low` — single unverified source or agent inference. On a curated page this **blocks** — see *Approval gates*
  - `unknown` — placeholder, needs verification
- **tags** — lowercase filter tags. No semantics; the audit does not check them.
- **aliases** — alternative names, abbreviations, and spellings for this page's subject. A **base field** now, on every type — it was previously `entity`-only, which meant a concept with three names had nowhere to say so. The audit emits every alias plus every lowercased title into `brain/.index/aliases.tsv`, so entity dedup during ingest is one grep instead of a judgment call.
- **owner** — the team responsible for keeping this page accurate. Owner reviews when the page is flagged stale. Optional unless `require_owner` is `true`, in which case the value must appear in `owner_teams` (`SCHEMA-004`).
- **date_created** / **date_modified** — ISO dates.
- **last_verified** — the date a human last confirmed the page is still correct. Distinct from `date_modified`: a page can be verified without being changed. Drives `STALE-001`.
- **sources** — every source that contributed to this page, as objects. See below.
- **related** — untyped "see also" `[[wikilinks]]`. Unchanged. Use it when the connection is real but has no direction and no logical force. When it *does* have force, use `relations`.
- **relations** — typed, directional edges. See *Typed relations*.

Additional fields by type: `brain.config.yaml` → `type_fields`. An entry prefixed `section:` names a required **body section**, not a frontmatter key.

### `sources` — object form

`sources` was a list of path strings. It is now a list of objects:

```yaml
sources:
  - id: kb-02-site-survey                                        # required, unique WITHIN the page
    path: brain/raw/extracted/kb-02-site-survey-report.pdf.txt   # required
    sha256: "9f2a…"                                              # required, 64 hex
    title: "MCA-SUR-0014 Site Survey Report"                     # optional, human label
```

| Key | Required | What |
|---|---|---|
| `id` | yes | Short kebab-case slug, unique within this page. **The whole reason for the change**: it is what an inline citation names, so citations can be checked mechanically instead of read |
| `path` | yes | The **sidecar** (`brain/raw/extracted/<name>.pdf.txt`) for binary sources; the original for text sources. Must exist on disk (`PROV-001`) |
| `sha256` | yes | 64 hex, of whatever `path` names. Must agree with `manifest.yaml` (`CITE-005`) — a disagreement means the source moved under the citations |
| `title` | no | Human label. This is where the old prose citation's descriptive text now lives |

An `origin: source` page with an empty `sources` is `CITE-004`. A source not present in `manifest.yaml` is `PROV-003`.

### Citation grammar — frozen and parseable

```
[source: <id>, <locator>]
[source: <id>, <locator>, (<date>)]
[source: unknown]
```

- `<id>` MUST match an `id` in that page's `sources`, or be the literal `unknown`. Anything else is `CITE-002`.
- `<locator>` is one of: `§<section name>` · `p.<n>` · `pp.<n>-<m>` · `row <n>` · `slide <n>` · `t <hh:mm:ss>` · `line <n>`. Anything else is `CITE-001`.
- `<date>` is optional and parenthesised: `(2026-03)` · `(v2.1, 2025-11)`.

```markdown
The system supports automatic failover with constraint-aware routing.
[source: kb-02-site-survey, §Failover]
```

**The old prose form is retired.** `[source: System Documentation / Architecture, §Failover, p.3]` no longer validates — it names a document by description, which no program can resolve to a file. The human label it carried lives in `sources[].title` now, and the citation names the `id`. A reader still sees the label: the site renders it from `sources`.

`[source: unknown]` is still the correct marking for a claim you cannot cite — and it still belongs in `## Open questions`, not in the body.

### `origin` — whose claim is this?

| Value | Means | Citation obligation |
|---|---|---|
| `source` (default) | Claims derive from ingested material | Every body claim carries an inline citation |
| `self` | The author's own conclusion | Body claims need no `[source:]`, but the page MUST have a `## Basis` section whose bullets are `[[wikilinks]]` to `origin: source` pages |

**Why this exists.** Under schema v1 every body claim needed a citation and every citation had to name a raw source, which made the author's own judgment a schema violation. A knowledge base whose owner cannot record a conclusion without laundering it through a document is a filing cabinet. `origin: self` makes your own reasoning first-class — and `## Basis` is the price: an uncited conclusion must still say what it stands on, so it can be re-checked when the ground moves.

`## Basis` bullets are `[[wikilinks]]` and nothing else. Prose in `## Basis`, or an empty one, is `CITE-006`. A missing `## Basis` on an `origin: self` page is the same check.

### Typed relations

`relations` records edges that carry logical force. All four keys are optional; each holds `[[wikilinks]]`.

| Key | Use it when | Direction |
|---|---|---|
| `supports` | This page argues **for** the target's claim | this → target |
| `contradicts` | This page is **incompatible** with the target. Both cannot be true | this → target, and the target should say it back |
| `supersedes` | This page **replaces** the target. The target stays, marked | this → target |
| `depends_on` | This page's claims **rest on** the target. If the target falls, this page falls | this → target |

`contradicts` is what makes the contradiction protocol machine-checkable. Before it, "surface contradictions, never overwrite them" was a behaviour nobody could verify after the fact; now a disputed pair is a graph edge the audit reads, the site renders, and a reviewer can enumerate. Record it on **both** pages when both are still standing.

A `relations` target that does not exist is `LINK-003`.

### Body sections

In order:

1. `## Summary` — 2-3 sentences, strongest claim first
2. `## Basis` — **required for `origin: self`**, forbidden nowhere else but pointless elsewhere. `[[wikilinks]]` only
3. Type-specific sections (as appropriate for the page type)
4. `## Open questions` — known unknowns

`## Summary`, `## Open questions`, and `## Basis` are exempt from the unsourced-claim check (`CITE-003`). Every other body block on an `origin: source` page needs a citation.

Evidence is captured via `sources:` and inline citations. A standalone `## Evidence` section is not required.

## Writing style

This is a machine-readable knowledge base, not a document for humans to read linearly. Every sentence must earn its place.

- **Fact-dense, not explanatory.** State the fact. Don't explain why it's interesting or what it means.
- **Answer-first.** Lead every section with the conclusion. Supporting detail follows, never precedes.
- **No filler.** Cut: "This means that", "It is important to note", "It is responsible for", "The key thing here is". If a sentence adds no new fact, delete it.
- **Prefer tables and lists over prose.** A three-column table beats three paragraphs.
- **One fact per bullet.** Don't chain multiple claims in one bullet point.
- **No redundancy across sections.** Don't repeat claims between Summary and detail sections.
- **Plain language.** No marketing tone, no superlatives ("industry-leading", "robust"), no hedging ("it should be noted that"). State what is shipped and what is not.

## Content tiers

Every wiki page carries a `tier` field. The tier determines how strictly the page is protected.

### Canonical — locked definitions

**What:** Agreed taxonomies, strategic decisions, fixed reference lists. Listed in `brain.config.yaml` → `canonical_pages`.

- The agent **cannot propose changes** to canonical pages. Only a human edits them, directly. This is unchanged and non-negotiable #4.
- Canonical pages are the **guardrails** for everything below.

**Contradicting evidence is recorded, not discarded.** When new data contradicts a canonical page:

1. Do **not** write it to the wiki, and do not modify the canonical page.
2. **Append a row to `brain/canonical-challenges.md`** — date, canonical page, the challenging claim, the source `id` and locator, status `open`.
3. Report it in the run summary and log it in `log.md`.
4. `tools/audit.mjs` reports outstanding rows as `CANON-001` (a warning) until a human resolves them.

The old rule said the new data "is treated as wrong — flag and move on", and moving on meant the evidence existed nowhere afterwards. That was the only place in this repo where a contradiction was thrown away, and it contradicted non-negotiable #3 outright. Canonical pages are guardrails against *unreviewed* change, not against being wrong: the ledger is how a canonical page that has drifted from reality becomes visible instead of merely unchallenged.

`canonical-challenges.md` lives **outside `brain/wiki/`** on purpose — the wiki write gate does not apply to it, so recording a challenge is never itself a wiki edit needing approval.

### Curated — synthesized knowledge

**What:** Assessed knowledge, comparisons, experience analysis. `claim` pages usually live here.

- Normal flow: lands on the ingest branch automatically when the audit is clean, and reaches `main` by human merge.
- Full contradiction handling applies.
- `confidence: low` **blocks** — a curated page is a page someone will trust; if you cannot get past `low`, propose it as evidence tier instead.
- Must be consistent with canonical pages.

### Evidence — raw observations

**What:** Ingested source material, data points, tickets, doc summaries.

- Additive evidence pages land on the branch automatically when the audit is clean.
- Contradictions against canonical go to `canonical-challenges.md` (above). Never silently dropped.
- Contradictions against curated pages are **flagged** but don't block the evidence from being stored.
- Contradictions within evidence are **noted on both pages** via `relations.contradicts` but don't require resolution — evidence is allowed to disagree.

## Audit checks

**The audit is a program: `tools/audit.mjs`.** Run it. Do not perform these checks by reading pages — an LLM re-deriving twenty structural checks over every page is slower, non-deterministic, and cannot be run in CI. The tool and the site share one parser — `tools/lib/wiki-core.mjs` is the single implementation of frontmatter, wikilinks, the backlink graph, and the citation grammar, and `site/src/lib/wiki.ts` is a thin typed wrapper around it — so what the audit parses is exactly what the site renders.

```
node tools/audit.mjs                 full audit, human report to stdout
node tools/audit.mjs --json          machine-readable findings
node tools/audit.mjs index           regenerate brain/.index/
node tools/audit.mjs --check-index   verify brain/.index/ is current (CI)
```

Exit codes: `0` clean (warnings allowed) · `1` violations found · `2` tool error.

Run it before every ingest commit, and on demand ("audit the wiki"). **The audit never changes files** — it produces a report. The human decides what to act on. The one exception is `index` mode, which writes `brain/.index/` and nothing else.

### Check IDs

Frozen. Rules, config, and reports reference them by ID.

| ID | Detects | Severity |
|---|---|---|
| `SCHEMA-001` | Missing required frontmatter field | error |
| `SCHEMA-002` | Invalid enum value (`type`/`tier`/`status`/`confidence`/`origin`) | error |
| `SCHEMA-003` | Missing `type_fields` entry required for this `type` | error |
| `SCHEMA-004` | `owner` missing or not in `owner_teams` while `require_owner: true` | error |
| `SCHEMA-005` | `type` carries a `type_fields` vocabulary value (e.g. `type: organisation`) | error |
| `LINK-001` | `[[wikilink]]` to a page that does not exist | error |
| `LINK-002` | Orphan — zero backlinks | warning |
| `LINK-003` | `relations` target does not exist | error |
| `CITE-001` | Citation does not parse against the frozen grammar | error |
| `CITE-002` | Citation `id` is not in that page's `sources` | error |
| `CITE-003` | Unsourced claim — a body block outside `## Summary`, `## Open questions`, and `## Basis` with no `[source:` and `origin: source` | error |
| `CITE-004` | `origin: source` page with empty `sources` | error |
| `CITE-005` | `sources[].sha256` disagrees with `manifest.yaml` — citations are stale | error |
| `CITE-006` | `origin: self` page with no `## Basis` section, or a `## Basis` bullet that is not a wikilink | error |
| `PROV-001` | `sources[].path` does not exist on disk | error |
| `PROV-002` | `manifest.yaml` entry names a `pages` slug that does not exist | error |
| `PROV-003` | A page's source is absent from `manifest.yaml` | error |
| `PROV-004` | `index.md` names a page that does not exist | error |
| `PROV-005` | A page exists in `brain/wiki/` with no `index.md` row | warning |
| `CANON-001` | Outstanding entries in `brain/canonical-challenges.md` | warning |
| `STALE-001` | `last_verified` past threshold (curated/evidence 90d, stub 30d) | warning |

Thresholds and severities are read from `brain.config.yaml` → `audit`, not hardcoded. Errors exit `1`; warnings do not. An error-level finding blocks the ingest commit — see *Approval gates*.

**One exemption, and it is a hole:** pages whose slug begins with `_` skip `PROV-001`, `PROV-003`, and `CITE-005` — the checks that reach out to the filesystem and `manifest.yaml`. It exists so the shipped `_example*` templates do not fail a fresh fork's first CI run. Every other check still applies to them. **Never give a real page a leading underscore**: it means "provenance unchecked", not "draft". See `docs/audit.md`.

### Terminal output format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔎 Wiki Audit — 47 pages scanned
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Schema (2)
  • wiki/concept-x.md — SCHEMA-001 missing `tier`
  • wiki/tool-y.md — SCHEMA-005 `type: organisation` is an entity_type

🔗 Broken links (1)
  • wiki/architecture.md — LINK-001 links to [[deployment-model]], page does not exist
    → Suggest: create stub or fix link

📎 Citations (2)
  • wiki/failover.md:31 — CITE-002 id `site-survey` not in this page's sources
  • wiki/warranty-risk.md — CITE-006 origin: self with no ## Basis section

🧾 Provenance (1)
  • wiki/data-pipeline.md — CITE-005 source `kb-02-site-survey` sha 9f2a10c… ≠ manifest b72fbfb…

🕸️ Stale (3)
  • wiki/data-pipeline.md — STALE-001 last verified 2026-03-15 (137 days, curated)
  • wiki/auth-strategy.md — STALE-001 last verified 2026-04-02 (119 days, curated)
  • wiki/api-gateway.md — STALE-001 stub since 2026-06-20 (40 days)

👻 Orphans (2)
  • wiki/legacy-connector.md — LINK-002 0 backlinks
    → Suggest: link from related topic or archive

🛡️ Canonical challenges (1)
  • CANON-001 taxonomy — 1 open row in canonical-challenges.md

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Audit summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📋 Schema:          2  ❌
  🔗 Broken links:    1  ❌
  📎 Citations:       2  ❌
  🧾 Provenance:      1  ❌
  🕸️ Stale:           3  ⚠️
  👻 Orphans:         2  ⚠️
  🛡️ Canonical:       1  ⚠️
  ──────────────────────
  ❌ Errors:          6   → exit 1
  ⚠️ Warnings:        6
  ⚡ Action items:   12

👉 What would you like to address?
```

**Emoji key:** 🔎 audit · 📋 schema · 🔗 broken link · 📎 citation · 🧾 provenance · 🕸️ stale · 👻 orphan · 🛡️ canonical challenge · ❌ error · ⚠️ warning · ⚡ action items · 👉 awaiting input.

### Actions after audit

| Command | What happens |
|---------|-------------|
| "fix schema" | Agent proposes frontmatter fixes — user approves |
| "fix citations" | Agent re-reads the cited sources and proposes corrected `id`/locator pairs — user approves |
| "fix broken links" | Agent proposes stub pages or link corrections — user approves |
| "resolve orphans" | Agent proposes backlinks or archive — user picks |
| "address stale" | Agent re-reads sources and proposes updates or marks archived — user approves |
| "resync provenance" | Agent reconciles `sources[].sha256`, `manifest.yaml`, and `index.md` — see `agent/rules/ingest.md` → *Drifted manifest* |
| "review challenges" | Agent lists open rows in `canonical-challenges.md` with their evidence — human decides per row |

Every one of these produces a proposal. None of them writes on its own, and none of them writes to `main`.
