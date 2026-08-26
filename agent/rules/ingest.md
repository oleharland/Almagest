# Brain — Ingest Rules

**Load this when** you are about to process anything in `brain/raw/`, or ingest a remote source listed in `brain.config.yaml` → `sources.remote`. Read it in full before touching a source file; it is the authoritative version. Writing the resulting pages is governed by `agent/rules/wiki.md` — load that too.

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

6. **The manifest is not exempt.** `path` and `previous_paths` in `brain/manifest.yaml` must use the approved anonymized filename. Never record a pre-anonymization filename there — `previous_paths` exists for renames, not as a back door to the original name.

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
- Sanitize BEFORE fingerprinting the file for the manifest. Renaming does not change the bytes, so the `sha256` is the same either way — but `path` must record the sanitized name, and the original goes in `previous_paths`.
- Leave `&`, `(`, `)`, `-`, `.` unchanged — they are safe on every platform.

## The ingest manifest

`brain/manifest.yaml` is the machine-readable record of every source ever ingested. It exists to make re-ingest incremental: the agent looks a source up before doing any work and gets one of three answers.

**It supplements `index.md` — it does not replace it.** `index.md` is the human-readable catalog; the manifest is the machine record the agent reads to decide whether a source needs work at all. Both are maintained on every ingest. Neither is redundant, and deleting either one breaks something.

Field reference: the header comment in `brain/manifest.yaml`. Full documentation: `docs/manifest.md`.

Manifest writes follow the same rule as `index.md` and `log.md` — they happen **after** the user approves the ingest, never ahead of it. The manifest changes *what gets proposed*, never *whether the user approves it*.

### Computing the fingerprint

Local sources — sha256 of the file's bytes. Nothing to install:

```bash
shasum -a 256 "brain/raw/system-overview.pdf" | cut -d' ' -f1   # macOS / BSD
sha256sum  "brain/raw/system-overview.pdf" | cut -d' ' -f1      # Linux
wc -c < "brain/raw/system-overview.pdf" | tr -d ' '             # bytes
```

Remote sources — no hashing. The fingerprint is the commit SHA the file was read at, taken from the MCP file listing.

**Never fingerprint by filename, mtime, or size.** A file that was ingested, edited, and dropped back into `raw/` keeps its name and often its size. Filename matching is exactly what silently loses those edits.

### The three outcomes

Every source resolves to exactly one:

| Outcome | Test | What the agent does |
|---------|------|--------------------|
| **New** | no manifest entry matches | Full ingest — extract, propose, approve, write a new entry |
| **Unchanged** | entry found, `sha256` / `commit` identical | Skip. Log a no-op in `log.md`. Do not re-read the source, do not touch the wiki, do not rewrite the entry |
| **Changed** | entry found, `sha256` / `commit` differs | **Diff re-ingest** — see below. Never a fresh page |

Match order for local files is **hash first, path second**:

1. Hash matches an entry → **unchanged**, even if the path differs (that is a rename — see edge cases).
2. Hash matches nothing, path matches an entry → **changed**.
3. Neither matches → **new**.

Remote files match on `id` (`provider:repo:path`), then compare `commit`.

### Diff re-ingest — the `changed` path

A changed source has already produced wiki pages, and the manifest entry's `pages` list names them. The job is to bring those pages up to date — not to re-derive them from scratch, and never to create a second page for an entity that already has one.

1. **Establish what changed in the source.**
   - Text sources: the previous version is still in `raw/processed/`. Diff it directly.
     ```bash
     git diff --no-index brain/raw/processed/notes.md brain/raw/notes.md
     ```
   - Binary or extracted sources (PDF, video, spreadsheet): the previous copy is often gitignored and absent. Re-extract the new version and compare the extraction against the claims already on the recorded pages. State in the summary that the comparison was semantic, not byte-level.
2. **Scope to the recorded pages first.** Load every slug in `pages` before proposing anything. Those pages are what this source is accountable for. Widen scope only if the new version introduces a genuinely new entity.
3. **Classify every difference**, and handle each kind differently:

| Difference | What it means | Action |
|-----------|---------------|--------|
| **Addition** | New fact; nothing on the recorded pages disagrees | Propose an additive update to the recorded page. A genuinely new entity → propose a new page through the normal gate |
| **Revision** | The source now says something different from what the wiki records *from that same source* | **Contradiction.** Route through `agent/rules/wiki.md` → *Handling contradictions*. Do not shortcut it |
| **Removal** | A claim the wiki cites from this source is no longer in the source | Never delete silently. Flag it, propose amend / mark disputed / remove, wait |

4. **A newer version of the same source is not automatic authority.** The contradiction protocol runs in full — quote both claims, propose a resolution, let the user pick. "The source was edited since we ingested it" is a strong argument for **Replace** and should be stated as the recommendation; it is not a licence to skip the gate.
5. **Re-verify citations, not only claims.** Page numbers, section names, row numbers, and timestamps shift when a source is edited. Every inline citation on a recorded page that points at this source must be checked against the new version and corrected in the same proposal.
6. **Tier rules still apply.** A changed source that contradicts a canonical page is still out of scope — flag and skip, exactly as on first ingest.
7. **After approval, update the entry in place** — never append a second entry for the same source: new `sha256` / `commit`, new `bytes`, `last_ingested` set to today, `pages` set to the union of the old list and any newly touched slugs. `id` and `first_ingested` never change.

### Manifest edge cases

**Source deleted from `raw/processed/`.** Binaries there are gitignored, so on a fresh clone most non-text sources are simply absent — the manifest entry is then the only surviving record of the ingest, which is the point.

- Set `status: missing`. **Do not delete the wiki pages it produced** — the knowledge stays, only the receipt is gone.
- Do not re-ingest, and do not treat it as new next time it appears.
- If the same file reappears in `raw/` and its `sha256` matches → **unchanged**: restore `path`, set `status: ingested`, no wiki work.
- If it reappears with a different hash → **changed**, but note in the summary that no byte diff is possible; the comparison runs against the recorded pages.

**Manifest entry whose wiki pages were deleted.** The `pages` list names slugs that no longer exist.

- Do not recreate them. A deleted page was deleted deliberately — deletion passes through the approval gate.
- Report the dangling slugs, propose dropping them from `pages`, and record why in `notes`.
- If that source is later re-ingested and the entity reappears, it is a **new page** proposal and goes through the full new-page gate. Never a silent resurrection.

**Rename with identical content.** A file in `raw/` whose `sha256` matches an existing entry at a different path.

- This is a rename or a re-drop, not a new source. **Do not re-ingest and do not re-propose anything.**
- Update `path`, append the old path to `previous_paths`, leave `last_ingested` alone (nothing was ingested), log it as a rename.
- If the old path still exists on disk as well, it is a **duplicate copy**, not a rename: skip the new file, log as duplicate, leave the entry untouched, and ask the user whether to remove the copy.
- Filename sanitization is the usual cause. A sanitized rename updates `previous_paths` and `index.md` but never triggers re-extraction.

**Drifted manifest.** The manifest disagrees with the filesystem, `index.md`, or `wiki/`.

- **Precedence: `wiki/` > `index.md` > `manifest.yaml`.** The wiki is the source of truth; the manifest is a cache of decisions already taken. Repair the manifest to match reality — never edit the wiki to match the manifest.
- Never silently rewrite. Present the findings, propose repairs, wait for approval.

| Drift | Repair |
|-------|--------|
| File in `raw/processed/` with no entry | Backfill: hash it, take its ingest date and pages from the `index.md` raw sources row, add the entry with `notes: backfilled`. If `index.md` has no row either, use the file's mtime for `first_ingested` and say so in `notes` |
| Entry with no row in `index.md` | Propose the missing `index.md` row |
| Entry whose `pages` name pages that do not exist | See *wiki pages were deleted* above |
| Entry whose `sha256` does not match the file at `path` | The file changed outside an ingest. Treat as **changed** — diff re-ingest |
| Manifest missing entirely (fresh fork, deleted file) | Recreate it with `version: 1` and `sources: []`, then backfill every row of `index.md`. Report this loudly: the next run must not be mistaken for a mass re-ingest |

**Forced full re-ingest.** When the user explicitly asks to re-ingest a source from scratch, ignore its entry for that run and treat the source as new. The wiki pages still exist, so entity matching (step 6 of the local workflow) still routes to *update* rather than *create*, and contradictions still go through the protocol. On approval the entry is refreshed, not duplicated — `first_ingested` is preserved.

## Local ingest workflow (raw/ → wiki/)

When new files appear in `raw/`:

1. **Read `index.md` first** — the catalog of existing pages and registered sources
2. **Read `manifest.yaml`** — the machine record of every source already ingested
3. **Fingerprint each file in `raw/`** — sha256 + byte size, then look it up in the manifest (see *The three outcomes* above):
   - **Unchanged** → log a no-op in `log.md`, skip the file entirely
   - **Changed** → go to step 5
   - **New** → go to step 4
4. **If new** → read the file and extract:
   - Entities. Each one becomes a page whose `type` is a value from
     `brain.config.yaml` → `page_types`. Do not put a `type_fields` value there:
     an organisation is `type: entity` with `entity_type: organisation`, never
     `type: organisation`. The two vocabularies are separate and a page carrying
     the wrong one fails the audit's schema check.
   - Key facts and evidence
   - Open questions / unknowns
   - Source attribution (file name, page/section, date)
5. **If changed** → diff re-ingest (see *Diff re-ingest* above): diff against the copy in `raw/processed/`, scope to the pages named in the manifest entry, classify each difference as addition / revision / removal
6. **For each extracted entity:**
   - Check if a wiki page already exists (via `index.md`)
   - If YES → **update** the existing page (add new evidence, refine claims, add backlinks)
   - If NO → **propose** a new wiki page to the user for confirmation before creating
7. **Cross-link** — add `[[wikilinks]]` between the new/updated page and related existing pages. Update those related pages with backlinks.
8. **Move** the original file from `raw/` to `raw/processed/`
9. **Update `index.md`** — add/update entries in both wiki pages and raw sources tables
10. **Update `manifest.yaml`** — add the entry (new source) or update it in place (changed source): `sha256`, `bytes`, `last_ingested`, `pages`, `status`
11. **Log** the action in `log.md` (date, what was processed, pages created/updated, sources skipped as unchanged)

## Remote ingest (via MCP)

Remote sources are read over MCP — no files are downloaded into `raw/`. Each entry in `sources.remote` names its `provider` (`github` or `gitlab`); see `docs/remote-sources.md` for server setup.

When the user requests remote ingest, or asks to "check [repo] for changes":

1. **Read `brain.config.yaml` → `sources.remote`** for configured repositories
2. **Read `manifest.yaml`** — the commit SHA each remote file was last read at
3. **Connect via the provider's MCP server** — match the entry's `provider` field to the corresponding server in `.mcp.json`
4. **List files** in the configured paths/branches for each remote source
5. **Compare commit SHAs against the manifest** — resolve every file to new / unchanged / changed (see *The three outcomes* above). `index.md` → Remote sources stays the human-readable view of the same facts; the manifest is what the comparison reads
6. **For new files** → read via MCP and extract entities using the same flow as local ingest (steps 4, 6-7 above)
7. **For changed files** → diff re-ingest (see *Diff re-ingest* above). No previous copy exists locally, so diff via the provider — compare the file between the recorded `commit` and the current one over MCP — and fall back to comparing against the recorded pages if that is unavailable
8. **Instead of moving files**, log the source reference in `index.md` → Remote sources table:
   - Provider and repo path (e.g., `github:acme/platform-docs`)
   - File path within the repo
   - Commit SHA at time of ingest
   - Ingest date
   - Pages created/updated
9. **Same approval flow** — propose changes, wait for user approval before writing to wiki
10. **Update `manifest.yaml`** — add or update the entry in place: `commit`, `bytes`, `last_ingested`, `pages`, `status`
11. **Log** the action in `log.md`

A remote file that disappears from the repo is the remote equivalent of a deleted `raw/processed/` source: set `status: missing`, keep the entry and the pages, do not re-ingest.

### Remote ingest terminal output

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌐 Remote ingest — acme/platform-docs
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🧾 Reading manifest.yaml — 8 files tracked for this repo
  📡 Connecting via github MCP...
  📂 Scanning docs/**/*.md — 12 files found
  🔄 3 changed since last ingest (abc1234 → 9505cac)
  ⏭️ 8 unchanged — skipping
  ✨ 1 new

  📄 [1/4] docs/architecture/overview.md
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

## Capability tiers for ingest

| Task | Tier | Why |
|------|------|-----|
| Manifest lookup / fingerprinting | mechanical | Hashing a file and comparing hex strings is mechanical |
| Extraction | mechanical | Pulling entities and facts from a source document is straightforward |
| Diff classification (changed source) | **judgment** | Deciding whether an edit is an addition, a revision, or a removal — and what it does to existing pages — is judgment, not diffing |
| Contradiction resolution | **judgment** | Weighing which source is stronger requires judgment |
| Manifest drift repair | **judgment** | Reconciling manifest, `index.md`, and `wiki/` means deciding which record is wrong |
| Canonical validation | mechanical | String comparison against a fixed list |
| Entity dedup | mechanical | Matching slugs and titles is mechanical |
| Merge proposals | **judgment** | Deciding whether two pages describe the same entity requires domain understanding |

Tiers map to concrete models via `brain.config.yaml` → `agent.profiles[agent.harness]`. This is advisory: steps marked **judgment** warrant your most capable available model; if your harness cannot switch models, run the whole session on it.

## Terminal output format

During ingest, provide clean, scannable status updates.

### Phase headers

```
📂 Scanning raw/ — 3 files found
📖 Reading index.md — 47 pages, 12 sources registered
🧾 Reading manifest.yaml — 12 sources tracked
🧾 Fingerprinting — 1 new, 1 changed, 1 unchanged
```

### Per-file processing

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📄 [1/3] system-overview.pdf
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🔄 CHANGED since 2026-07-14 (sha b45968e… → b72fbfb…)
  🧾 Recorded pages: system-architecture, data-pipeline
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

An unchanged source never gets a block of its own — one line is enough:

```
  ⏭️ [2/3] capability-matrix.xlsx — unchanged (sha 4f2a10c…), skipping
```

### After approval

```
  ✅ Approved — writing 2 pages
  📁 Moved system-overview.pdf → raw/processed/
  📝 index.md updated
  🧾 manifest.yaml updated — 1 entry added, 1 refreshed
  📝 log.md updated
```

### Manifest drift

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧭 Manifest drift — 3 findings
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🧭 raw/processed/legacy-spec.md — on disk, no manifest entry
     → Backfill from index.md (ingested 2026-05-02, pages: legacy-protocol)
  🧭 system-overview-pdf → data-pipeline — page no longer exists
     → Drop the slug from `pages`
  🧭 notes-2026-q2-md — sha on disk differs from the manifest
     → Changed outside an ingest; re-ingest as a diff

  👉 Approve repairs?
```

### Batch summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Ingest complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📄 Files processed:  3
  ✨ Pages created:    2
  ✅ Pages updated:    5
  🔄 Re-ingested:      1 (changed source)
  ⏭️ Unchanged:        1 (skipped)
  ⚠️ Contradictions:   1 (resolved)
  🚫 Skipped:          1 (outside canonical scope)
  📊 Wiki total:       49 pages
  🧾 Sources tracked:  13
```

### Terminal output rules

- **Always show progress** — `[n/total]` on every file so the user knows where things stand.
- **Verdict before work** — every file states new / changed / unchanged before any extraction output, so the user can see what was skipped and why.
- **Truncate hashes to 7 characters** followed by `…` — `b72fbfb…`, never the full 64. The full digest lives in `manifest.yaml`.
- **Surface contradictions inline** — quote both claims, recommend a resolution, then wait.
- **Group approval** — after presenting all changes for a file (or batch), pause for approval before writing.
- **No wall of text** — use the structured format above. Keep each line to one piece of information.
- **Emoji key:** 📂 scan · 📄 file · 🔍 extract · ✨ new · ✅ updated/done · ⚠️ contradiction · 🚫 skipped/rejected · ⏭️ no change/unchanged · 📋 summary · 👉 awaiting input · 🌐 remote · 📡 connect · 🔄 changed · 🧾 manifest · 🧭 manifest drift.

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
- **Fingerprint, don't guess.** A source is unchanged only when its `sha256` or `commit` matches the manifest. Same filename is not the same file.
- **The manifest never gates approval.** It decides what the agent proposes. The user still decides what gets written.
- **Flag unknowns explicitly.** If data is missing, say so and name what would resolve it.
- **`[[Wikilinks]]` liberally.** Every entity reference should be a link. This builds the graph.
- **Write-if-changed.** Don't rewrite files that haven't changed.
