# Agent routing

Which rule file applies to which paths, and how that rule file reaches the agent.

This file is the source of the two blocks every always-on shim carries: the
project overview and the routing table. `tools/agent-shims.sh` extracts them
between the `SHIM:BEGIN` / `SHIM:END` markers below and writes them into
`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and `.github/copilot-instructions.md`.
Edit them here, then run `tools/agent-shims.sh generate`. Do not edit the shims.

The seven non-negotiables those shims also carry come from `brain/rules-index.md`.

## Routing table

<!-- SHIM:BEGIN routing -->
| Before you… | Read |
|---|---|
| answer a question from the wiki | `agent/rules/read.md` |
| process anything in `brain/raw/` | `agent/rules/ingest.md` |
| create/edit/delete anything in `brain/wiki/` | `agent/rules/wiki.md` |
| run `tools/audit.mjs`, or act on a finding | `agent/rules/wiki.md` → Audit, `docs/audit.md` |
| write to `brain/canonical-challenges.md` | `agent/rules/wiki.md` → Canonical |
| regenerate `brain/.index/` | `docs/audit.md` — run `tools/audit.mjs index`, never hand-edit the files |
| print a run summary to the terminal | `agent/rules/ingest.md`, `docs/terminal-output.md` |
| anything at all | `brain.config.yaml`, `brain/.index/pages.tsv`, `brain/index.md`, `brain/manifest.yaml` |
<!-- SHIM:END routing -->

Read the named file **before** the operation, not after. Each rule file stands
alone — it opens with a "Load this when" line stating exactly which operations
it governs.

## Which file owns which path

| Path | Owned by | Written by |
|------|----------|-----------|
| `brain/wiki/**` | `agent/rules/wiki.md` | the agent, on an `ingest/…` branch only |
| `brain/raw/**` | `agent/rules/ingest.md` | you (drop) and the agent (move to `processed/`) |
| `brain/raw/extracted/**` | `agent/rules/ingest.md` | the agent — committed text sidecars for binary sources |
| `brain/manifest.yaml` | `agent/rules/ingest.md`, `docs/manifest.md` | the agent, every ingest |
| `brain/index.md`, `brain/log.md` | `agent/rules/ingest.md` | the agent, every ingest |
| `brain/canonical-challenges.md` | `agent/rules/wiki.md` | the agent, when a source contradicts a canonical page |
| `brain/.index/**` | `docs/audit.md` | `tools/audit.mjs index` only — generated, committed, never hand-edited |

## How a rule file reaches the agent

| Loading | Harness behaviour | Consequence |
|---------|-------------------|-------------|
| **Strong** | Harness loads a rule file when a matching path is touched (`.claude/rules/*.md` `paths:`, `.cursor/rules/*.mdc` `globs:`) | The rule arrives on its own. The routing table is a backstop |
| **Weak** | Harness loads one always-on file per session and nothing else | The routing table is the mechanism. The agent must open the named rule file by hand |

Both modes are correct. Weak loading is weaker only in that it is instruction,
not enforcement — an agent that ignores the routing table gets no second chance.
What backstops both now is `tools/audit.mjs`: a page written without the rules
usually fails a check, and a failing check blocks the commit.

## Shim map

| Shim | Harness | Loading | Carries |
|------|---------|---------|---------|
| `CLAUDE.md` | Claude Code | weak (always-on) | overview + non-negotiables + routing table |
| `AGENTS.md` | Codex, Antigravity, Amp, Jules, Cursor, others | weak (always-on) | overview + non-negotiables + routing table |
| `GEMINI.md` | Gemini CLI | weak (always-on) | overview + non-negotiables + routing table |
| `.github/copilot-instructions.md` | Copilot | weak (always-on) | overview + non-negotiables + routing table |
| `.claude/rules/brain-ingest.md` | Claude Code | strong — `paths: brain/raw/**` | pointer to `agent/rules/ingest.md` |
| `.claude/rules/brain-wiki.md` | Claude Code | strong — `paths: brain/wiki/**` | pointer to `agent/rules/wiki.md` |
| `brain/CLAUDE.md` | Claude Code | strong — path-scoped | pointer to `agent/rules/read.md` |
| `.cursor/rules/almagest-ingest.mdc` | Cursor | strong — `globs: brain/raw/**` | pointer to `agent/rules/ingest.md` |
| `.cursor/rules/almagest-wiki.mdc` | Cursor | strong — `globs: brain/wiki/**` | pointer to `agent/rules/wiki.md` |
| `.cursor/rules/almagest-read.mdc` | Cursor | strong — `globs: brain/**` | pointer to `agent/rules/read.md` |

A pointer shim never duplicates rule content. Duplicated rules drift; a pointer
cannot.

Antigravity (`agy`) gets no shim of its own. It reads `AGENTS.md`, so the root
shim already covers it, and inventing a `.antigravity/` or `ANTIGRAVITY.md` file
would ship a filename nothing has been shown to read. What it actually does with
`AGENTS.md` is unconfirmed: on this repo it found and followed the routing table,
but in a scratch directory holding a decoy `AGENTS.md` it reported having no
project instructions — which would mean it opens the file rather than being
handed it. Either way the routing table is what reaches it, and naming the rule
file in your first message is the mitigation. A run in a registered Antigravity
project, with a decoy codeword in `AGENTS.md`, would settle it.

There is deliberately no `brain/AGENTS.md`: it is the same file as the
hand-written `brain/rules-index.md` on any case-insensitive filesystem (macOS,
Windows), and generating it destroys the index. Harnesses that read `AGENTS.md`
are weak-loading, so they already have the routing table from the root
`AGENTS.md`. `tools/agent-shims.sh` refuses to write any shim that collides
this way.

## Project overview

The block below is what every always-on shim opens with.

<!-- SHIM:BEGIN overview -->
AI-powered knowledge base framework. Fork this repo to build your own brain.

## Structure

```
almagest/
├── brain/                 ← content (the knowledge base)
│   ├── raw/               ← intake queue (drop files here)
│   │   ├── extracted/     ← committed text sidecars for binary sources
│   │   └── processed/     ← originals after ingest (binaries gitignored)
│   ├── wiki/              ← flat .md pages — THE source of truth
│   ├── .index/            ← pages.tsv + aliases.tsv (generated, committed)
│   ├── index.md           ← catalog of all pages + sources (for humans)
│   ├── manifest.yaml      ← record of every ingested source (for the agent)
│   ├── canonical-challenges.md ← data that contradicts canonical, never merged
│   ├── log.md             ← audit trail
│   ├── rules-index.md     ← map of where the rules live (index)
│   └── CLAUDE.md          ← pointer to the reader rules (generated)
├── agent/                 ← the rules themselves — single source of truth
│   ├── contract.md        ← the minimum harness contract
│   ├── routing.md         ← which rule file applies to which paths
│   └── rules/             ← read.md · ingest.md · wiki.md
├── tools/                 ← agent-shims.sh (pointer files) · audit.mjs (the checker)
├── site/                  ← Astro frontend (reads from brain/wiki/)
│   ├── src/
│   │   ├── lib/wiki.ts    ← typed wrapper over tools/lib/wiki-core.mjs
│   │   ├── pages/         ← routes
│   │   ├── components/    ← UI components
│   │   ├── layouts/       ← page layouts
│   │   └── styles/        ← base.css (framework) + theme.css (yours)
│   ├── site.config.ts     ← title, description, index grouping
│   └── package.json
├── benchmarks/            ← benchmark harness (fixtures, questions, runner)
├── docs/                  ← framework documentation
├── brain.config.yaml      ← instance configuration (page types, sources, etc.)
├── .mcp.json              ← MCP server config (GitHub + GitLab)
├── LICENSE                ← MIT
└── .gitignore
```

## How content flows

### Local ingest (raw/ drop)

1. Drop a file (PDF, video, Excel, doc) into `brain/raw/`
2. Agent greps `brain/.index/pages.tsv` and `aliases.tsv` to check what's already known
3. Agent fingerprints the file (sha256) against `brain/manifest.yaml` — new, unchanged, or changed. Unchanged is skipped; changed is re-ingested as a diff against the pages it already produced
4. Binary sources get a committed text sidecar at `brain/raw/extracted/<name>.<ext>.txt` with `=== page N ===` markers. Citations point at the sidecar, so a locator can be checked
5. Agent creates an `ingest/<source-slug>-<sha7>` branch, extracts entities, and writes pages there. Contradictions, canonical conflicts, deletions/merges/renames, and `confidence: low` curated pages stop for an in-session decision instead of being written
6. `tools/audit.mjs` runs before the commit. Exit `1` blocks it
7. Agent commits to the branch, updates `index.md`, `manifest.yaml`, `log.md`, and `brain/.index/`. **You review the diff and merge.** Nothing reaches `main` any other way
8. `site/` builds from `brain/wiki/` — `npm run build` in `site/`

### Remote ingest (GitHub / GitLab over MCP)

1. Agent reads `brain.config.yaml` → `sources.remote` for configured repos
2. Agent connects via the MCP server matching each entry's `provider` (`.mcp.json`)
3. Agent reads files from remote repos, runs the same extraction flow
4. Source reference logged in `index.md` and `manifest.yaml` (provider, repo, path, commit SHA, date) — no local copy. The recorded commit SHA is what makes the next run incremental
5. Same branch, audit, and merge flow as local ingest. This is the one path that can run unattended end to end: a scheduled sync ingests onto a branch and leaves you a diff

## Wiki page types

Defined in `brain.config.yaml` → `page_types`. Configure this file to match your domain before starting ingest.

Every page carries `origin`: `source` (claims derive from ingested material — each one cites a source) or `self` (the author's own conclusion — no inline citations, but a `## Basis` section of wikilinks to `origin: source` pages). A `claim` page is the normal home for `origin: self`; its title is a sentence, not a noun.

Two behaviours ship **off** and are opt-in via config:

- `anonymization.enabled` — when on, the agent stops on every personal name and waits for approval before writing a role-based replacement. Turn on for shared vaults or sources containing real personal data.
- `require_owner` — when on, every page must name an owning team from `owner_teams`.

## Citations

One grammar, frozen so it can be checked by machine:

```
[source: <id>, <locator>]            [source: <id>, <locator>, (<date>)]            [source: unknown]
```

`<id>` matches an `id` in that page's `sources` list, or is the literal `unknown`. `<locator>` is one of `§<section>` · `p.<n>` · `pp.<n>-<m>` · `row <n>` · `slide <n>` · `t <hh:mm:ss>` · `line <n>`. The human-readable label lives in `sources[].title`, not in the citation.

## The audit

`tools/audit.mjs` (Node 22+) checks the wiki mechanically — schema, links, citation grammar, citation targets, provenance against `manifest.yaml`, staleness. Findings have stable IDs (`CITE-002`, `LINK-001`, …) that the rule files reference. `tools/audit.mjs index` regenerates `brain/.index/`; `--check-index` verifies it is current. Exit `0` clean, `1` violations, `2` tool error. An exit `1` blocks the commit.

## Capability tiers

Rules name two tiers, never a model: `mechanical` (parsing, hashing, string and
slug comparison, structural checks, straightforward extraction) and `judgment`
(weighing which source is stronger, classifying a diff, deciding two pages
describe the same entity, cross-source synthesis). They map to concrete models
via `brain.config.yaml` → `agent.profiles[agent.harness]`. This is advisory:
steps marked **judgment** warrant your most capable available model; if your
harness cannot switch models, run the whole session on it.
<!-- SHIM:END overview -->
