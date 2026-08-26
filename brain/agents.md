---
title: "Agent Manual"
type: system
---

# Agent Manual

Map of the operating rules for AI agents working on this knowledge base.

**This file is an index, not a rulebook.** The rules themselves live in the files below and are auto-loaded by Claude Code when you touch the matching paths. Keeping the detail in exactly one place is what stops the two copies from drifting apart.

## Where the rules live

| File | Scope | Loads when |
|------|-------|-----------|
| `brain/CLAUDE.md` | **Reading** — query protocol, citation format for answers | Auto — any `brain/` file |
| `.claude/rules/brain-ingest.md` | **Ingest** — raw → wiki, anonymization, filename sanitization, remote sources, terminal output | Auto — any `brain/raw/**` file |
| `.claude/rules/brain-wiki.md` | **Writing** — approval gates, contradictions, page template, tiers, audit | Auto — any `brain/wiki/**` file |
| `brain.config.yaml` | **Instance config** — page types, canonical pages, ownership, sources, anonymization | Read it before any operation |
| `brain/manifest.yaml` | **Ingest record** — fingerprint and pages of every source already ingested | Read it before any ingest |

If you need the actual rule, open the file in the third column. Do not rely on this page.

## Vault structure

```
brain/
├── raw/              <- intake queue (drop new files here)
│   └── processed/    <- archive of everything ever ingested
├── wiki/             <- flat knowledge pages (the source of truth)
├── index.md          <- catalog of all pages + all sources (for humans)
├── manifest.yaml     <- record of every ingested source (for the agent)
├── log.md            <- audit trail of all actions
├── agents.md         <- this file
└── CLAUDE.md         <- reader rules
```

## The three operations

| Operation | Direction | Rules |
|-----------|-----------|-------|
| **Ingest** | `raw/` or a remote repo → `wiki/` | `.claude/rules/brain-ingest.md` |
| **Query** | `wiki/` → an answer with citations | `brain/CLAUDE.md` |
| **Audit** | `wiki/` → a report (never a file change) | `.claude/rules/brain-wiki.md` |

## Non-negotiables

These six hold across every operation. Everything else is in the rules files.

1. **No writes without approval.** The agent never creates, edits, or deletes a page in `wiki/` without an explicit "yes" from the user in the same conversation.
2. **No unsourced claims.** Every factual claim carries an inline citation. If it can't be cited, mark it `[source: unknown]` and add it to `## Open questions`.
3. **Surface contradictions, never overwrite them.** Quote both claims with their sources, propose a resolution, wait.
4. **Canonical pages are guardrails.** The agent cannot propose changes to them. Data that contradicts canonical is flagged as out of scope, not merged.
5. **Fingerprint, don't guess.** A source is unchanged only when its `sha256` or commit SHA matches `manifest.yaml`. Same filename is not the same file.
6. **Write-if-changed.** Don't rewrite a file whose content hasn't changed.

## Model selection

Default to **Sonnet**. Escalate to **Opus** when the task requires judgment rather than pattern matching.

| Task | Model | Why |
|------|-------|-----|
| Audit (all checks) | Sonnet | Structural: parse frontmatter, count backlinks, compare strings, check dates |
| Ingest — manifest lookup / fingerprinting | Sonnet | Hashing a file and comparing hex strings is mechanical |
| Ingest — extraction | Sonnet | Pulling entities and facts from a source document is straightforward |
| Ingest — canonical validation | Sonnet | String comparison against a fixed list |
| Ingest — entity dedup | Sonnet | Matching slugs and titles is mechanical |
| Ingest — contradiction resolution | **Opus** | Weighing which source is stronger, recommending replace vs amend vs dispute |
| Ingest — merge proposals | **Opus** | Deciding whether two pages describe the same entity needs domain understanding |
| Ingest — diff classification | **Opus** | Deciding whether an edit to a re-ingested source is an addition, a revision, or a removal |
| Ingest — manifest drift repair | **Opus** | Reconciling manifest, `index.md`, and `wiki/` means deciding which record is wrong |
| Query — factual lookup | Sonnet | Retrieve and cite, no synthesis needed |
| Query — cross-source synthesis | **Opus** | Connecting evidence across pages, building an argument, spotting gaps |
| Query — strategic questions | **Opus** | "What's the strongest case for/against X" needs depth |

**Rule of thumb:** comparing strings or checking structure → Sonnet. Making a recommendation the user will act on → Opus.

## Writing style

The wiki is a machine-readable knowledge base, not a document to be read linearly. Every sentence must earn its place. Full guidance in `.claude/rules/brain-wiki.md` → Writing style.

- Fact-dense, not explanatory. Answer-first. No filler.
- Tables and lists over prose. One fact per bullet.
- No marketing tone, no superlatives, no hedging.
