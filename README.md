# Almagest

An AI-powered knowledge base framework built for Claude Code.

Fork it, point it at your domain, and drop in source material. Claude reads what you give it, proposes structured wiki pages, and refuses to write a single claim it can't trace back to a source. The result is a cross-linked markdown wiki that both you and an agent can query — plus a static site to read it in.

## What makes it different

Most AI note-taking tools optimise for capture. Almagest optimises for **trust**:

- **Nothing gets written without your approval.** The agent drafts, you decide. Every create, update, and delete passes through an explicit approval gate.
- **Every claim cites its source** — down to the section, page, or timestamp. A page with no sources is flagged as a defect, in the wiki and on the site.
- **Contradictions surface instead of silently overwriting.** When a new source disagrees with what's already there, the agent quotes both, recommends a resolution, and waits.
- **Unknowns are first-class.** Missing data gets named in an `## Open questions` section, not quietly omitted.
- **Canonical pages are locked.** Your agreed taxonomies and definitions are guardrails the agent cannot edit — data that contradicts them is rejected, not merged.

## Features

- **AI-assisted ingest** — drop files in `brain/raw/` or pull from GitHub/GitLab repos over MCP. The agent extracts entities, proposes pages, handles contradictions, and cites sources.
- **Structured wiki** — flat markdown with typed frontmatter, three content tiers (canonical / curated / evidence), and automatic `[[wikilink]]` cross-linking.
- **Built-in audit** — stale pages, orphans, broken links, schema violations, coverage gaps. Produces a report; never edits your files.
- **Query protocol** — ask questions, get answers traceable to the original source, with synthesis explicitly flagged as synthesis.
- **Static site** — an Astro frontend that builds straight from `brain/wiki/`. Backlinks, filtering, dark mode, zero configuration.
- **Upstream updates** — pull framework improvements with `git merge`. Your content and customisation live in files upstream never touches.

## Quick start

```bash
git clone <this-repo> my-brain && cd my-brain
```

1. **Configure** `brain.config.yaml` — page types, canonical pages, and whether you want anonymization and page ownership turned on (both ship off).
2. **Drop files** into `brain/raw/` — PDFs, docs, spreadsheets, transcripts, notes.
3. **Run Claude Code** — `claude` in the repo root. It loads the rules automatically and starts proposing pages.
4. **Read it** — `cd site && npm install && npm run dev`.

Full walkthrough in [Getting Started](docs/getting-started.md).

## Documentation

- [Getting Started](docs/getting-started.md) — setup and configuration
- [Page Types](docs/page-types.md) — defining custom wiki page types
- [Remote Sources](docs/remote-sources.md) — ingesting from GitHub or GitLab over MCP
- [Multi-Brain](docs/multi-brain.md) — running several knowledge domains side by side
- [Upstream Updates](docs/upstream-updates.md) — pulling framework improvements

## Structure

| Path | Purpose |
|------|---------|
| `brain/wiki/` | Flat markdown pages — the source of truth |
| `brain/raw/` | Intake queue for new source files |
| `brain/index.md` | Catalog of every page and every source |
| `brain/log.md` | Audit trail of every action |
| `site/` | Astro frontend, reads from `brain/wiki/` |
| `.claude/rules/` | Auto-loaded agent rules (ingest, wiki write) |
| `docs/` | Framework documentation |
| `brain.config.yaml` | Instance configuration |
| `.mcp.json` | MCP servers for remote sources |

## Requirements

- [Claude Code](https://claude.com/claude-code)
- Node.js 18+ (only for the site)

## License

MIT — see [LICENSE](LICENSE).
