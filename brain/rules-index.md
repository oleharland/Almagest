---
title: "Agent Manual"
type: system
---

# Agent Manual

Map of the operating rules for AI agents working on this knowledge base.

**This file is an index, not a rulebook.** The rules themselves live in `agent/rules/`. Keeping the detail in exactly one place is what stops the copies from drifting apart — every `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc` and `.claude/rules/*.md` in this repo is a generated pointer, not a second copy.

## Where the rules live

| File | Scope | How it reaches you |
|------|-------|--------------------|
| `agent/rules/read.md` | **Reading** — query protocol, citation format for answers | Strong-loading harness: automatically on any `brain/` file, via the generated pointer. Weak-loading: open it yourself before answering |
| `agent/rules/ingest.md` | **Ingest** — raw → wiki, anonymization, filename sanitization, remote sources, terminal output | Strong: automatically on any `brain/raw/**` file. Weak: open it yourself before touching a source |
| `agent/rules/wiki.md` | **Writing** — approval gates, contradictions, page template, tiers, audit | Strong: automatically on any `brain/wiki/**` file. Weak: open it yourself before proposing a change |
| `brain.config.yaml` | **Instance config** — page types, canonical pages, ownership, sources, anonymization, agent profiles | Read it before any operation |
| `brain/manifest.yaml` | **Ingest record** — fingerprint and pages of every source already ingested | Read it before any ingest |

If you need the actual rule, open the file in the first column. Do not rely on this page.

Which paths route to which rule file: `agent/routing.md`. What a harness must provide before Almagest can run on it at all: `agent/contract.md` — requirement 5, an interactive human who can approve in-session, is not optional.

## Vault structure

```
brain/
├── raw/              <- intake queue (drop new files here)
│   └── processed/    <- archive of everything ever ingested
├── wiki/             <- flat knowledge pages (the source of truth)
├── index.md          <- catalog of all pages + all sources (for humans)
├── manifest.yaml     <- record of every ingested source (for the agent)
├── log.md            <- audit trail of all actions
├── rules-index.md    <- this file
└── CLAUDE.md         <- generated pointer to agent/rules/read.md
```

## The three operations

| Operation | Direction | Rules |
|-----------|-----------|-------|
| **Ingest** | `raw/` or a remote repo → `wiki/` | `agent/rules/ingest.md` |
| **Query** | `wiki/` → an answer with citations | `agent/rules/read.md` |
| **Audit** | `wiki/` → a report (never a file change) | `agent/rules/wiki.md` |

## Non-negotiables

These six hold across every operation, on every harness. Everything else is in the rules files.

<!-- SHIM:BEGIN non-negotiables -->
1. **No writes without approval.** The agent never creates, edits, or deletes a page in `wiki/` without an explicit "yes" from the user in the same conversation.
2. **No unsourced claims.** Every factual claim carries an inline citation. If it can't be cited, mark it `[source: unknown]` and add it to `## Open questions`.
3. **Surface contradictions, never overwrite them.** Quote both claims with their sources, propose a resolution, wait.
4. **Canonical pages are guardrails.** The agent cannot propose changes to them. Data that contradicts canonical is flagged as out of scope, not merged.
5. **Fingerprint, don't guess.** A source is unchanged only when its `sha256` or commit SHA matches `manifest.yaml`. Same filename is not the same file.
6. **Write-if-changed.** Don't rewrite a file whose content hasn't changed.
<!-- SHIM:END non-negotiables -->

## Capability tiers

Default to **mechanical**. Escalate to **judgment** when the task requires judgment rather than pattern matching.

| Task | Tier | Why |
|------|------|-----|
| Audit (all checks) | mechanical | Structural: parse frontmatter, count backlinks, compare strings, check dates |
| Ingest — manifest lookup / fingerprinting | mechanical | Hashing a file and comparing hex strings is mechanical |
| Ingest — extraction | mechanical | Pulling entities and facts from a source document is straightforward |
| Ingest — canonical validation | mechanical | String comparison against a fixed list |
| Ingest — entity dedup | mechanical | Matching slugs and titles is mechanical |
| Ingest — contradiction resolution | **judgment** | Weighing which source is stronger, recommending replace vs amend vs dispute |
| Ingest — merge proposals | **judgment** | Deciding whether two pages describe the same entity needs domain understanding |
| Ingest — diff classification | **judgment** | Deciding whether an edit to a re-ingested source is an addition, a revision, or a removal |
| Ingest — manifest drift repair | **judgment** | Reconciling manifest, `index.md`, and `wiki/` means deciding which record is wrong |
| Query — factual lookup | mechanical | Retrieve and cite, no synthesis needed |
| Query — cross-source synthesis | **judgment** | Connecting evidence across pages, building an argument, spotting gaps |
| Query — strategic questions | **judgment** | "What's the strongest case for/against X" needs depth |

**Rule of thumb:** comparing strings or checking structure → mechanical. Making a recommendation the user will act on → judgment.

Tiers map to concrete models via `brain.config.yaml` → `agent.profiles[agent.harness]`. This is advisory: steps marked **judgment** warrant your most capable available model; if your harness cannot switch models, run the whole session on it.

## Writing style

The wiki is a machine-readable knowledge base, not a document to be read linearly. Every sentence must earn its place. Full guidance in `agent/rules/wiki.md` → Writing style.

- Fact-dense, not explanatory. Answer-first. No filler.
- Tables and lists over prose. One fact per bullet.
- No marketing tone, no superlatives, no hedging.
