---
paths:
  - "brain/raw/**"
---

# Brain — Ingest Rules

Rules for processing new files from `raw/` into `wiki/`. These activate when working with raw source files.

**Before starting any ingest session, read `brain.config.yaml` for instance-specific configuration.**

## Name anonymization during ingest

**Controlled by `brain.config.yaml` → `anonymization.enabled`.**

- **`enabled: false` (the default)** — skip this whole section. Personal names in source files pass through to the wiki unchanged. This is the right setting for a personal or public knowledge base where names are part of the content.
- **`enabled: true`** — every step below is MANDATORY. Before extracting entities from any raw file, check for personal names.

1. **Check the filename** for personal names. If found, propose a content-based rename to the user (e.g., `meeting-notes-ux-strategy-2026.md`). Wait for approval before proceeding.

2. **Scan extracted content** for personal names before proposing wiki changes. Replace with role-based identifiers:
   - Refer to `brain.config.yaml` → `anonymization.role_patterns` for organization-specific role identifiers.
   - Show all replacements to the user in the extraction summary.

3. **The `sources:` field** in wiki frontmatter must use the anonymized filename. Never write a source path containing a personal name.

4. **Move step uses the clean name.** When moving `raw/` to `raw/processed/`, use the approved anonymized filename.

5. **Inline citations** (`[source: ...]`) must use role identifiers, not personal names.

Refer to `brain.config.yaml` → `anonymization.ignore_names` for company/product names that should NOT be flagged as personal data.

## Filename sanitization (MANDATORY)

All files in `raw/` must have cross-platform-safe filenames before processing. Windows is the strictest of the three major platforms, so these rules target it — a Windows-safe name is safe everywhere. Apply these replacements to every incoming filename:

| Character | Replacement | Example |
|-----------|-------------|---------|
| `%20` (URL-encoded space) | `_` | `Report%20Final.png` → `Report_Final.png` |
| ` ` (space) | `_` | `Done User Stories` → `Done_User_Stories` |
| `:` (colon) | `-` | `Community : District` → `Community_-_District` |
| `—` (em-dash U+2014) | `--` | `Decision — v2` → `Decision_--_v2` |

**Rules:**
- Sanitize the filename BEFORE moving to `raw/processed/`.
- Use `git mv` for renames so git tracks the change.
- If a collision would occur (target name already exists), append `_2`, `_3`, etc. before the extension.
- The `index.md` raw sources entry should use the **sanitized** filename.
- Leave `&`, `(`, `)`, `-`, `.` unchanged — they are safe on every platform.

## Local ingest workflow (raw/ → wiki/)

When new files appear in `raw/`:

1. **Read `index.md` first** — check if this source is already processed (raw sources table)
2. **If already processed** → log as duplicate in `log.md`, skip
3. **If new** → read the file and extract:
   - Entities (refer to `brain.config.yaml` → `page_types` for valid entity types)
   - Key facts and evidence
   - Open questions / unknowns
   - Source attribution (file name, page/section, date)
4. **For each extracted entity:**
   - Check if a wiki page already exists (via `index.md`)
   - If YES → **update** the existing page (add new evidence, refine claims, add backlinks)
   - If NO → **propose** a new wiki page to the user for confirmation before creating
5. **Cross-link** — add `[[wikilinks]]` between the new/updated page and related existing pages. Update those related pages with backlinks.
6. **Move** the original file from `raw/` to `raw/processed/`
7. **Update `index.md`** — add/update entries in both wiki pages and raw sources tables
8. **Log** the action in `log.md` (date, what was processed, pages created/updated)

## Remote ingest (via MCP)

Remote sources are read over MCP — no files are downloaded into `raw/`. Each entry in `sources.remote` names its `provider` (`github` or `gitlab`); see `docs/remote-sources.md` for server setup.

When the user requests remote ingest, or asks to "check [repo] for changes":

1. **Read `brain.config.yaml` → `sources.remote`** for configured repositories
2. **Connect via the provider's MCP server** — match the entry's `provider` field to the corresponding server in `.mcp.json`
3. **List files** in the configured paths/branches for each remote source
4. **Check `index.md` → Remote sources table** — compare commit SHAs to detect changes since last ingest
5. **For new or changed files** → read via MCP and extract entities using the same flow as local ingest (steps 3-5 above)
6. **Instead of moving files**, log the source reference in `index.md` → Remote sources table:
   - Provider and repo path (e.g., `github:acme/platform-docs`)
   - File path within the repo
   - Commit SHA at time of ingest
   - Ingest date
   - Pages created/updated
7. **Same approval flow** — propose changes, wait for user approval before writing to wiki
8. **Log** the action in `log.md`

### Remote ingest terminal output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 Remote ingest — acme/platform-docs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  📡 Connecting via github MCP...
  📂 Scanning docs/**/*.md — 12 files found
  🔄 3 changed since last ingest (commit abc1234)

  📄 [1/3] docs/architecture/overview.md
  🔍 Extracting entities...
  ✨ wiki/architecture-overview.md — NEW (topic, curated)

  📋 Summary: 1 new, 0 updated, 0 contradictions
  👉 Awaiting approval...
```

## Tier validation during ingest

Before writing any page, the agent checks:

1. **Does this entity match canonical definitions?** (refer to `brain.config.yaml` → `canonical_pages` for the reference list pages) — if not, flag and skip.
2. **Does this contradict a curated page?** — if yes, surface it to the user (full contradiction flow).
3. **Does this contradict other evidence?** — if yes, note it on the page, continue.

## Model selection for ingest

| Task | Model | Why |
|------|-------|-----|
| Extraction | Sonnet | Pulling entities and facts from a source document is straightforward |
| Contradiction resolution | **Opus** | Weighing which source is stronger requires judgment |
| Canonical validation | Sonnet | String comparison against a fixed list |
| Entity dedup | Sonnet | Matching slugs and titles is mechanical |
| Merge proposals | **Opus** | Deciding whether two pages describe the same entity requires domain understanding |

## Terminal output format

During ingest, provide clean, scannable status updates.

### Phase headers

```
📂 Scanning raw/ — 3 files found
📖 Reading index.md — 47 pages, 12 sources registered
```

### Per-file processing

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📄 [1/3] system-overview.pdf
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🔍 Extracting entities...
  📦 Found: 2 topics, 3 concepts, 1 decision

  ✅ wiki/system-architecture.md — updated (added 2 evidence items)
  ✨ wiki/data-pipeline.md — NEW (concept, curated)
  ⚠️ wiki/auth-strategy.md — CONTRADICTION detected

     Existing (auth-strategy.md, §Approach, source: design-doc.md):
       "Token-based auth with 24h expiry"
     New (system-overview.pdf, p.12):
       "Session-based auth with rolling refresh"
     → Recommend: Replace (newer source, more specific)

  ⏭️ wiki/api-gateway.md — no changes needed
  🚫 Skipped: "mobile" category not in canonical list

  📋 Summary: 1 updated, 1 new, 1 contradiction, 1 skipped
  👉 Awaiting approval...
```

### After approval

```
  ✅ Approved — writing 2 pages
  📁 Moved system-overview.pdf → raw/processed/
  📝 index.md updated
  📝 log.md updated
```

### Batch summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Ingest complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📄 Files processed:  3
  ✨ Pages created:    2
  ✅ Pages updated:    5
  ⚠️ Contradictions:   1 (resolved)
  🚫 Skipped:          1 (outside canonical scope)
  📊 Wiki total:       49 pages
```

### Terminal output rules

- **Always show progress** — `[n/total]` on every file so the user knows where things stand.
- **Surface contradictions inline** — quote both claims, recommend a resolution, then wait.
- **Group approval** — after presenting all changes for a file (or batch), pause for approval before writing.
- **No wall of text** — use the structured format above. Keep each line to one piece of information.
- **Emoji key:** 📂 scan · 📄 file · 🔍 extract · ✨ new · ✅ updated/done · ⚠️ contradiction · 🚫 skipped/rejected · ⏭️ no change · 📋 summary · 👉 awaiting input · 🌐 remote · 📡 connect · 🔄 changed.

## Inline citation format for wiki pages

When writing claims to wiki pages during ingest, use inline citations:

```markdown
The system supports automatic failover with constraint-aware routing.
[source: System Documentation / Architecture, §Failover, p.3]
```

The citation has three parts:

| Part | What | Examples |
|------|------|---------|
| **Source file** | The raw file it came from | `System Documentation / Overview` · `JIRA-4521` · `capability-matrix.xlsx` |
| **Location** | Where in that file | `§Section Name` · `p.12` · `row 45` · `slide 7` · `timestamp 14:32` |
| **Date** (if relevant) | When the source was created/updated | `(2026-03)` · `(v2.1, 2025-11)` |

### Citation rules for ingest

- **Propagate citations during ingest.** When writing a claim to a wiki page, include the inline citation at that point. Don't defer to a generic `sources:` list in frontmatter.
- **Frontmatter `sources` is the file-level index.** It lists every raw file that contributed to the page. Inline citations are the claim-level pointers. Both are required.
- **No unsourced claims.** If you can't cite it, mark it `[source: unknown]` and add to `## Open questions`.
- **Precision over brevity.** The reader should be able to find the passage in under 30 seconds.

## General ingest rules

- **Synthesis over atoms.** Update existing pages, don't create new files for every fact. Create a new page only when a genuinely new entity appears.
- **Flag unknowns explicitly.** If data is missing, say so and name what would resolve it.
- **`[[Wikilinks]]` liberally.** Every entity reference should be a link. This builds the graph.
- **Write-if-changed.** Don't rewrite files that haven't changed.
