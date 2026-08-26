# CLAUDE.md — Almagest

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
│   ├── agents.md          ← map of where the rules live (index)
│   └── CLAUDE.md          ← reader rules (auto-loaded)
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
├── CLAUDE.md              ← this file
├── LICENSE                ← MIT
└── .gitignore
```

## Hard rules

- **No generated content without confirmation.** Never create or delete wiki pages without user approval. This is the most important rule.
- **Data-backed only.** Every finding must cite its source or be flagged as a known unknown.
- **Source attribution mandatory.** Every factual claim cites where it came from.
- **Flag unknowns explicitly.** Missing data = say so, name what would resolve it.
- **Fingerprint, don't guess.** A source is unchanged only when its `sha256` or commit SHA matches `brain/manifest.yaml`. Same filename is not the same file.
- **Write-if-changed.** Don't rewrite files that haven't changed.

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

## Agent instructions

Agent rules are split by role and auto-loaded via Claude Code mechanisms:

| File | Who it's for | When it loads |
|------|-------------|---------------|
| `brain/CLAUDE.md` | Everyone (readers) | Auto — when touching any brain/ file |
| `.claude/rules/brain-ingest.md` | Operators (writers) | Auto — when touching brain/raw/ files |
| `.claude/rules/brain-wiki.md` | Operators (writers) | Auto — when touching brain/wiki/ files |
| `brain/agents.md` | Reference | Not auto-loaded — index of the above, plus model selection |
