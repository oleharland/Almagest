<div align="center">

```
    ▄▄▄       ██▓     ███▄ ▄███▓ ▄▄▄        ▄████ ▓█████   ██████ ▄▄▄█████▓
   ▒████▄    ▓██▒    ▓██▒▀█▀ ██▒▒████▄     ██▒ ▀█▒▓█   ▀ ▒██    ▒ ▓  ██▒ ▓▒
   ▒██  ▀█▄  ▒██░    ▓██    ▓██░▒██  ▀█▄  ▒██░▄▄▄░▒███   ░ ▓██▄   ▒ ▓██░ ▒░
   ░██▄▄▄▄██ ▒██░    ▒██    ▒██ ░██▄▄▄▄██ ░▓█  ██▓▒▓█  ▄   ▒   ██▒░ ▓██▓ ░
    ▓█   ▓██▒░██████▒▒██▒   ░██▒ ▓█   ▓██▒░▒▓███▀▒░▒████▒▒██████▒▒  ▒██▒ ░
    ▒▒   ▓▒█░░ ▒░▓  ░░ ▒░   ░  ░ ▒▒   ▓▒█░ ░▒   ▒ ░░ ▒░ ░▒ ▒▓▒ ▒ ░  ▒ ░░
     ▒   ▒▒ ░░ ░ ▒  ░░  ░      ░  ▒   ▒▒ ░  ░   ░  ░ ░  ░░ ░▒  ░ ░    ░
     ░   ▒     ░ ░   ░      ░     ░   ▒   ░ ░   ░    ░   ░  ░  ░    ░
         ░  ░    ░  ░       ░         ░  ░      ░    ░  ░      ░
```

**A knowledge base your agent can't lie to you about.**

</div>

An AI-powered knowledge base framework for coding agents.

Fork it, point it at your domain, and drop in source material. Your agent reads what you give it, proposes structured wiki pages, and refuses to write a single claim it can't trace back to a source. The result is a cross-linked markdown wiki that both you and an agent can query — plus a static site to read it in.

It runs on Claude Code, Codex, Cursor, Gemini CLI, Antigravity, or any agent that meets the [harness contract](agent/contract.md).

## How it works

```
    ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
    │   PDFs·docs  │   │  transcripts │   │ GitHub/GitLab│
    │  spreadsheets│   │    videos    │   │   over MCP   │
    └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
           └──────────────────┼──────────────────┘
                              ▼
                     ╔══════════════════╗
                     ║   brain/raw/     ║   ← drop anything here
                     ╚════════╤═════════╝
                              ▼
              ┌───────────────────────────────┐
              │   FINGERPRINT vs manifest     │
              │   new · changed · unchanged   │  ← unchanged is skipped
              └───────────────┬───────────────┘
                              ▼
              ┌───────────────────────────────┐
              │        AI CODING AGENT        │
              │  reads index → extracts       │
              │  entities → diffs changed     │
              │  sources → checks for         │
              │  contradictions → drafts      │
              └───────────────┬───────────────┘
                              ▼
              ╭ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─╮
              │         YOU APPROVE          │
              │  nothing is written without  │
              │   an explicit yes   [y/n]    │
              ╰ ─ ─ ─ ─ ─ ─ ─ ┬ ─ ─ ─ ─ ─ ─ ─╯
                              ▼
     ┌────────────────────────────────────────────────┐
     │  brain/wiki/     flat .md · typed frontmatter  │
     │                  [[wikilinks]] · sources cited │
     │  manifest.yaml   fingerprints · page slugs     │
     └───────┬────────────────────────────────┬───────┘
             ▼                                ▼
      ┌─────────────┐                  ┌─────────────┐
      │  you query  │                  │ static site │
      │  the agent  │                  │  (Astro)    │
      └─────────────┘                  └─────────────┘
```

## What makes it different

Most AI note-taking tools optimise for capture. Almagest optimises for **trust**:

```
   ┌───────────────────────────┐      ┌───────────────────────────┐
   │     MOST AI NOTE TOOLS    │      │          ALMAGEST         │
   ├───────────────────────────┤      ├───────────────────────────┤
   │ ✗ writes on its own       │      │ ✓ drafts, then asks       │
   │ ✗ claims float free of    │      │ ✓ every claim carries a   │
   │    any source             │      │    citation               │
   │ ✗ newest note wins,       │      │ ✓ conflicts stop and      │
   │    silently               │      │    ask you                │
   │ ✗ gaps look like facts    │      │ ✓ gaps become questions   │
   │ ✗ you re-verify by hand   │      │ ✓ you trust the page      │
   │ ✗ re-drop an edited file, │      │ ✓ content fingerprint     │
   │    it's skipped as a dupe │      │    catches the edit       │
   └───────────────────────────┘      └───────────────────────────┘
```

- **Nothing gets written without your approval.** The agent drafts, you decide. Every create, update, and delete passes through an explicit approval gate.
- **Every claim cites its source** — down to the section, page, or timestamp. A page with no sources is flagged as a defect, in the wiki and on the site.
- **Contradictions surface instead of silently overwriting.** When a new source disagrees with what's already there, the agent quotes both, recommends a resolution, and waits.
- **Unknowns are first-class.** Missing data gets named in an `## Open questions` section, not quietly omitted.
- **Canonical pages are locked.** Your agreed taxonomies and definitions are guardrails the agent cannot edit — data that contradicts them is rejected, not merged.

What that looks like in practice:

```
  $ <your agent>            # claude · codex · cursor-agent · gemini · agy

  ● Read brain/index.md (142 pages, 61 sources)
  ● Read brain/raw/q3-architecture-review.pdf (38 pages)

    Proposed: 2 new pages, 1 update, 1 conflict

    + wiki/service-ledger.md          type: system    5 sources
    + wiki/retention-policy.md        type: policy    2 sources
    ~ wiki/data-platform.md           +3 claims, +2 [[links]]

    ! CONFLICT — wiki/retention-policy.md
        existing  "retained for 30 days"      source: runbook.md §4
        incoming  "retained for 90 days"      source: q3-review.pdf p.12
        → incoming source is newer. Recommend update, keep both cited.

    ? Open question logged: no source states who owns the ledger.

    Apply these changes? (y / n / edit)  ▏
```

## Features

- **AI-assisted ingest** — drop files in `brain/raw/` or pull from GitHub/GitLab repos over MCP. The agent extracts entities, proposes pages, handles contradictions, and cites sources.
- **Structured wiki** — flat markdown with typed frontmatter, three content tiers (canonical / curated / evidence), and automatic `[[wikilink]]` cross-linking.
- **Incremental re-ingest** — sources are fingerprinted by content, not filename. Edit a source, drop it back in, and the agent proposes a targeted diff against the pages it already produced instead of skipping it as a duplicate.
- **Built-in audit** — stale pages, orphans, broken links, schema violations, coverage gaps. Produces a report; never edits your files.
- **Benchmark harness** — a fixture corpus and question set that measure citation validity, contradiction surfacing, and whether the agent declines questions the corpus can't answer. Ships unrun; the numbers are yours to produce.
- **Query protocol** — ask questions, get answers traceable to the original source, with synthesis explicitly flagged as synthesis.
- **Static site** — an Astro frontend that builds straight from `brain/wiki/`. Backlinks, filtering, dark mode, zero configuration.
- **Harness portability** — one set of rules in `agent/rules/`, projected into each agent's own format (`CLAUDE.md`, `AGENTS.md`, `.cursor/rules/`, `GEMINI.md`) by a single generator. One source of truth, no drift. Claude Code is the reference harness.
- **Upstream updates** — pull framework improvements with `git merge`. Your content and customisation live in files upstream never touches.

## Quick start

```bash
git clone <this-repo> my-brain && cd my-brain
```

1. **Configure** `brain.config.yaml` — page types, canonical pages, and whether you want anonymization and page ownership turned on (both ship off).
2. **Drop files** into `brain/raw/` — PDFs, docs, spreadsheets, transcripts, notes.
3. **Start your agent** in the repo root — `claude`, `codex`, `cursor-agent`, `gemini`, `agy`, whichever you use. It picks up the rules from the repo and starts proposing pages. Per-harness setup in [Agent Harnesses](docs/agent-harnesses.md).
4. **Read it** — `cd site && npm install && npm run dev`.

Full walkthrough in [Getting Started](docs/getting-started.md).

## Documentation

- [Getting Started](docs/getting-started.md) — setup and configuration
- [Agent Harnesses](docs/agent-harnesses.md) — running it on Claude Code, Codex, Cursor, Gemini CLI, Antigravity, or Copilot
- [Page Types](docs/page-types.md) — defining custom wiki page types
- [Remote Sources](docs/remote-sources.md) — ingesting from GitHub or GitLab over MCP
- [The Ingest Manifest](docs/manifest.md) — how re-ingest stays incremental
- [Benchmarks](docs/benchmarks.md) — measuring whether the wiki actually helps
- [Multi-Brain](docs/multi-brain.md) — running several knowledge domains side by side
- [Upstream Updates](docs/upstream-updates.md) — pulling framework improvements

## Structure

| Path | Purpose |
|------|---------|
| `brain/wiki/` | Flat markdown pages — the source of truth |
| `brain/raw/` | Intake queue for new source files |
| `brain/index.md` | Catalog of every page and every source (for humans) |
| `brain/manifest.yaml` | Fingerprint record of every ingested source (for the agent) |
| `brain/log.md` | Audit trail of every action |
| `site/` | Astro frontend, reads from `brain/wiki/` |
| `agent/contract.md` | The minimum capabilities a harness must have to run Almagest |
| `agent/rules/` | The agent rules — read, ingest, wiki write. One copy, every harness |
| `tools/agent-shims.sh` | Generates the per-harness rule files from `agent/rules/` |
| `.claude/rules/` | Claude Code rule shims (generated) |
| `benchmarks/` | Benchmark harness, fixture corpus, and question set |
| `benchmarks/drivers/` | One driver per harness — how the benchmark invokes an agent |
| `docs/` | Framework documentation |
| `brain.config.yaml` | Instance configuration |
| `.mcp.json` | MCP servers for remote sources |

## Requirements

- **An AI coding agent** meeting [`agent/contract.md`](agent/contract.md). Known-good: [Claude Code](https://claude.com/claude-code) (the reference harness), Codex, Cursor, Gemini CLI, Antigravity, Copilot in an interactive editor session. Setup per harness in [Agent Harnesses](docs/agent-harnesses.md).
- **A human at the keyboard.** The approval gate is a person saying yes — nothing else enforces it. Almagest must not be run by a headless or unattended agent.
- Node.js 18+ (only for the site)

## License

MIT — see [LICENSE](LICENSE).
