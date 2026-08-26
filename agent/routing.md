# Agent routing

Which rule file applies to which paths, and how that rule file reaches the agent.

This file is the source of the two blocks every always-on shim carries: the
project overview and the routing table. `tools/agent-shims.sh` extracts them
between the `SHIM:BEGIN` / `SHIM:END` markers below and writes them into
`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and `.github/copilot-instructions.md`.
Edit them here, then run `tools/agent-shims.sh generate`. Do not edit the shims.

The six non-negotiables those shims also carry come from `brain/rules-index.md`.

## Routing table

<!-- SHIM:BEGIN routing -->
| Before you… | Read |
|---|---|
| answer a question from the wiki | `agent/rules/read.md` |
| process anything in `brain/raw/` | `agent/rules/ingest.md` |
| create/edit/delete anything in `brain/wiki/` | `agent/rules/wiki.md` |
| anything at all | `brain.config.yaml`, `brain/index.md`, `brain/manifest.yaml` |
<!-- SHIM:END routing -->

Read the named file **before** the operation, not after. Each rule file stands
alone — it opens with a "Load this when" line stating exactly which operations
it governs.

## How a rule file reaches the agent

| Loading | Harness behaviour | Consequence |
|---------|-------------------|-------------|
| **Strong** | Harness loads a rule file when a matching path is touched (`.claude/rules/*.md` `paths:`, `.cursor/rules/*.mdc` `globs:`) | The rule arrives on its own. The routing table is a backstop |
| **Weak** | Harness loads one always-on file per session and nothing else | The routing table is the mechanism. The agent must open the named rule file by hand |

Both modes are correct. Weak loading is weaker only in that it is instruction,
not enforcement — an agent that ignores the routing table gets no second chance.

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
│   │   └── processed/     ← originals after ingest
│   ├── wiki/              ← flat .md pages — THE source of truth
│   ├── index.md           ← catalog of all pages + sources (for humans)
│   ├── manifest.yaml      ← record of every ingested source (for the agent)
│   ├── log.md             ← audit trail
│   ├── rules-index.md     ← map of where the rules live (index)
│   └── CLAUDE.md          ← pointer to the reader rules (generated)
├── agent/                 ← the rules themselves — single source of truth
│   ├── contract.md        ← the minimum harness contract
│   ├── routing.md         ← which rule file applies to which paths
│   └── rules/             ← read.md · ingest.md · wiki.md
├── tools/                 ← agent-shims.sh (generates every pointer file)
├── site/                  ← Astro frontend (reads from brain/wiki/)
│   ├── src/
│   │   ├── lib/wiki.ts    ← wiki loader (frontmatter, wikilinks, backlinks)
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
2. Agent reads `brain/index.md` to check what's already known
3. Agent fingerprints the file (sha256) against `brain/manifest.yaml` — new, unchanged, or changed. Unchanged is skipped; changed is re-ingested as a diff against the pages it already produced
4. Agent extracts entities, proposes new/updated wiki pages to user
5. On approval: creates/updates `brain/wiki/` pages, cross-links with `[[wikilinks]]`
6. Moves original to `brain/raw/processed/`, updates `index.md`, `manifest.yaml`, and `log.md`
7. `site/` builds from `brain/wiki/` — `npm run build` in `site/`

### Remote ingest (GitHub / GitLab over MCP)

1. Agent reads `brain.config.yaml` → `sources.remote` for configured repos
2. Agent connects via the MCP server matching each entry's `provider` (`.mcp.json`)
3. Agent reads files from remote repos, runs the same extraction flow
4. Source reference logged in `index.md` and `manifest.yaml` (provider, repo, path, commit SHA, date) — no local copy. The recorded commit SHA is what makes the next run incremental
5. Same proposal + approval flow as local ingest

## Wiki page types

Defined in `brain.config.yaml` → `page_types`. Configure this file to match your domain before starting ingest.

Two behaviours ship **off** and are opt-in via config:

- `anonymization.enabled` — when on, the agent stops on every personal name and waits for approval before writing a role-based replacement. Turn on for shared vaults or sources containing real personal data.
- `require_owner` — when on, every page must name an owning team from `owner_teams`.

## Capability tiers

Rules name two tiers, never a model: `mechanical` (parsing, hashing, string and
slug comparison, structural checks, straightforward extraction) and `judgment`
(weighing which source is stronger, classifying a diff, deciding two pages
describe the same entity, cross-source synthesis). They map to concrete models
via `brain.config.yaml` → `agent.profiles[agent.harness]`. This is advisory:
steps marked **judgment** warrant your most capable available model; if your
harness cannot switch models, run the whole session on it.
<!-- SHIM:END overview -->
