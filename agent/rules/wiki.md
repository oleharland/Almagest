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
3. **Propose a role-based replacement** — refer to `brain.config.yaml` → `anonymization.role_patterns` for valid role identifiers.
4. **Wait for approval** before writing the anonymized version.

### What counts as a name

- First names, last names, full names
- **Source file paths in `sources:` must also be anonymized** — if a raw file has a name in its filename, it must be renamed during ingest before the reference is written
- Names in inline citations like `[source: ...]` must use role identifiers, not personal names
- No personal names anywhere — body text, frontmatter, source paths, inline citations

## Approval gates

Every change to `wiki/` must pass through human approval. No exceptions.

| Action | What the agent does | What requires approval |
|--------|--------------------|-----------------------|
| **New page** | Draft the full page (frontmatter + body) and present it | The page itself — user confirms before it is written |
| **Update (additive)** | Show the proposed additions in context | The diff — user confirms before the file is modified |
| **Update (corrective)** | Flag the contradiction first, then propose a resolution | Both the contradiction flag AND the resolution |
| **Delete / merge** | Explain why, propose where content moves | The deletion and any receiving page's changes |
| **Bulk ingest** | Present a summary table of all proposed creates/updates | The full set — user can approve, reject, or cherry-pick |

The agent must never write to `wiki/` without an explicit "yes" / "go ahead" / approval from the user in the same conversation.

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
5. **Log it.** Every resolved contradiction gets a line in `log.md` noting what was contradicted, what was decided, and why.

## Wiki page template

Every wiki page must have this structure:

```yaml
---
title: ""
type: ""            # see brain.config.yaml → page_types
tier: ""            # canonical | curated | evidence
tags: []            # lowercase, for filtering
status: ""          # stub | draft | evergreen
confidence: ""      # high | medium | low | unknown
owner: ""           # optional — see brain.config.yaml → require_owner
date_created: ""    # ISO date
date_modified: ""   # ISO date
last_verified: ""   # ISO date — last human confirmation that content is still accurate
sources: []         # paths to raw/processed/ files
related: []         # explicit [[wikilinks]]
---
```

### Field definitions

- **confidence** — how well-sourced the page content is:
  - `high` — verified against a primary source (demo, release notes, contract, shipped product)
  - `medium` — inferred from a credible secondary source (presentation, call transcript, internal doc)
  - `low` — single unverified source or agent inference
  - `unknown` — placeholder, needs verification
- **owner** — the team responsible for keeping this page accurate. Owner reviews when the page is flagged as stale. Optional unless `brain.config.yaml` → `require_owner` is `true`, in which case the value must appear in `owner_teams`.
- **last_verified** — the date a human last confirmed the page is still correct. Distinct from `date_modified`: a page can be verified without being changed.

Additional fields by type: refer to `brain.config.yaml` → `type_fields` for type-specific frontmatter fields.

Body sections (in order):

1. `## Summary` — 2-3 sentences, strongest claim first
2. Type-specific sections (as appropriate for the page type)
3. `## Open questions` — known unknowns

Evidence is captured via the `sources:` frontmatter field and inline citations in the body text. A standalone `## Evidence` section is not required.

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

**What:** Agreed taxonomies, strategic decisions, fixed reference lists.

- The agent **cannot propose changes** to canonical pages. If new data contradicts a canonical page, the new data is treated as wrong — flag as "evidence outside canonical scope" and move on.
- Only a human can edit canonical pages directly.
- Canonical pages are the **guardrails** for everything below.

### Curated — synthesized knowledge

**What:** Assessed knowledge, comparisons, experience analysis.

- Normal approval flow. Agent proposes, human approves.
- Full contradiction handling applies.
- Must be consistent with canonical pages.

### Evidence — raw observations

**What:** Ingested source material, data points, tickets, doc summaries.

- Lighter approval. Agent can propose in bulk, user can approve the batch.
- Contradictions against canonical are **rejected automatically** with a log entry.
- Contradictions against curated pages are **flagged** but don't block the evidence from being stored.
- Contradictions within evidence are **noted on both pages** but don't require resolution — evidence is allowed to disagree.

## Audit checks

Run on demand ("audit the wiki"). The audit **never changes files** — it produces a report. The human decides what to act on.

| Check | What it detects | Threshold |
|-------|----------------|-----------|
| **Stale pages** | `last_verified` older than threshold | Curated/evidence: 90 days, Stubs: 30 days |
| **Orphans** | Pages with zero incoming `[[wikilinks]]` | Any page with 0 backlinks |
| **Broken links** | `[[wikilinks]]` pointing to pages that don't exist | Any broken link |
| **Schema violations** | Missing required frontmatter (`tier`, `type`, `status`), empty `sources`, or a missing/unlisted `owner` when `require_owner` is `true` | Any violation |
| **Canonical drift** | References to entities not in canonical pages | Any mismatch |
| **Unresolved unknowns** | `## Open questions` sections older than 30 days | Any unresolved |
| **Coverage gaps** | Pages with `?` coverage for any entity | Any `?` |
| **Tier balance** | Ratio of canonical / curated / evidence pages | Informational |

### How audit runs

1. Load all wiki pages and parse frontmatter
2. Load canonical pages to build reference lists
3. Build the backlink graph
4. Run each check against every page
5. Output the report
6. **Do not auto-fix anything.** Present findings, wait for instructions.

### Terminal output format

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔎 Wiki Audit — 47 pages scanned
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🕸️ Stale pages (3)
  • wiki/data-pipeline.md — last verified 2026-03-15 (137 days, curated)
  • wiki/auth-strategy.md — last verified 2026-04-02 (119 days, curated)
  • wiki/api-gateway.md — stub since 2026-06-20 (40 days)

👻 Orphans (2)
  • wiki/legacy-connector.md — 0 backlinks
    → Suggest: link from related topic or archive

🔗 Broken links (1)
  • wiki/architecture.md links to [[deployment-model]] — page does not exist
    → Suggest: create stub or fix link

📋 Schema violations (2)
  • wiki/concept-x.md — missing `tier`
  • wiki/tool-y.md — empty `sources`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Audit summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🕸️ Stale:          3
  👻 Orphans:         2
  🔗 Broken links:    1
  📋 Schema issues:   2
  ──────────────────────
  ⚡ Action items:    8

👉 What would you like to address?
```

**Emoji key:** 🔎 audit · 🕸️ stale · 👻 orphan · 🔗 broken link · 📋 schema · 🧭 drift · ❓ unknown · 🕳️ gap · 📊 stats · ⚡ action items · 👉 awaiting input.

### Actions after audit

| Command | What happens |
|---------|-------------|
| "fix schema" | Agent proposes frontmatter fixes — user approves |
| "resolve orphans" | Agent proposes backlinks or archive — user picks |
| "fix broken links" | Agent proposes stub pages or link corrections — user approves |
| "address stale" | Agent re-reads sources and proposes updates or marks archived — user approves |
| "show coverage gaps" | Agent lists what data would fill each `?` |
| "fix drift" | Agent shows canonical vs page — user decides |
