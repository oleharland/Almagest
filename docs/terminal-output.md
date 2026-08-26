# Terminal Output

What an Almagest session looks like while it runs. Formats only — the rules that
change agent behaviour live in `agent/rules/ingest.md` → *Terminal output* and
`agent/rules/wiki.md`, and are repeated at the bottom of this page for reference.

This file is a reference, not a rule file. Nothing here is loaded before an
operation; read it once to know what the shapes mean.

## Why the format is specified at all

Ingest is a long-running operation that ends in a decision. The reader has to see,
without scrolling back, what was skipped and why, what is being proposed, and what
is blocked. Structured output does that; a paragraph of prose does not.

**Emoji key**

| | | | |
|---|---|---|---|
| 📂 scan | 📄 file | 🔍 extract | 📦 extraction counts |
| ✨ new | ✅ updated / done | ⏭️ no change / unchanged | 🚫 skipped / rejected |
| ⚠️ contradiction | 🛑 blocked | 📋 summary | 👉 awaiting input |
| 🌐 remote | 📡 connect | 🔄 changed | 🧾 manifest |
| 🧭 manifest drift | 📝 file written | 📁 file moved | 🌿 branch |
| 🔎 audit | 🕸️ stale | 👻 orphan | 🔗 broken link |
| ❓ unknown | 🕳️ gap | 📊 stats | ⚡ action items |

## Ingest

### Phase headers

```
📂 Scanning raw/ — 3 files found
📖 Reading index.md — 47 pages, 12 sources registered
🧾 Reading manifest.yaml — 12 sources tracked
🧾 Fingerprinting — 1 new, 1 changed, 1 unchanged
🌿 Branch ingest/system-overview-pdf-b72fbfb
```

### Extraction of a binary source

The sidecar is written before any entity extraction, so it gets its own lines.

```
  📄 [1/3] system-overview.pdf
  🔍 Extracting text → raw/extracted/system-overview.pdf.txt
  📦 214 pages, 118 KB of text, 214 page markers
  🧾 sidecar sha 4c1d9a2…
```

### Per-file processing

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📄 [1/3] system-overview.pdf
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🔄 CHANGED since 2026-07-14 (sha b45968e… → b72fbfb…)
  🧾 Recorded pages: system-architecture, data-pipeline
  🔍 Extracting text → raw/extracted/system-overview.pdf.txt
  🔍 Diffing against committed sidecar — 3 hunks, 2 cross a page marker
  📦 Found: 2 topics, 3 concepts, 1 decision

  ✅ wiki/system-architecture.md — updated (added 2 evidence items)
  ✨ wiki/data-pipeline.md — NEW (concept, curated)
  ⚠️ wiki/auth-strategy.md — CONTRADICTION detected

     Existing (auth-strategy.md, §Approach):
       "Token-based auth with 24h expiry"
       [source: design-doc, §Auth]
     New (system-overview.pdf, p.12):
       "Session-based auth with rolling refresh"
     → Recommend: Replace (newer source, more specific)
     🛑 Blocks — resolve here or the page stays unwritten

  ⏭️ wiki/api-gateway.md — no changes needed
  🚫 Skipped: "mobile" category not in canonical list

  📋 Summary: 1 updated, 1 new, 1 contradiction, 1 skipped
  👉 Awaiting approval...
```

An unchanged source never gets a block of its own — one line is enough:

```
  ⏭️ [2/3] capability-matrix.xlsx — unchanged (sha 4f2a10c…), skipping
```

### Citation re-verification on a changed source

```
  🔎 Citation check — tools/audit.mjs
  ⚠️ CITE-005  wiki/system-architecture.md cites system-overview at b45968e…;
               manifest is at b72fbfb… — 4 citations unverified
  ✅ p.11 → p.12  "constraint-aware routing"      [source: system-overview, p.12]
  ✅ §Failover unchanged                          [source: system-overview, §Failover]
  ⚠️ row 45 no longer exists in the sidecar       → propose: mark disputed
```

### After approval

```
  ✅ Approved — writing 2 pages
  📁 Moved system-overview.pdf → raw/processed/
  📝 raw/extracted/system-overview.pdf.txt written (118 KB)
  📝 index.md updated
  🧾 manifest.yaml updated — 1 entry added, 1 refreshed
  📝 log.md updated
  🔎 Audit clean — 0 errors, 2 warnings
  🌿 Committed to ingest/system-overview-pdf-b72fbfb (7 files)
  👉 Review the diff and merge to main
```

### Blocked by the audit

An audit error blocks the commit entirely. Nothing lands, including the clean pages.

```
  🛑 Audit failed — commit blocked (exit 1)
     CITE-002  wiki/data-pipeline.md — [source: sys-overview] not in `sources`
     PROV-001  wiki/data-pipeline.md — sources[0].path does not exist on disk
  👉 Fix both, then re-run. Nothing was committed.
```

### Manifest drift

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧭 Manifest drift — 4 findings
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  🧭 raw/processed/legacy-spec.md — on disk, no manifest entry
     → Backfill from index.md (ingested 2026-05-02, pages: legacy-protocol)
  🧭 system-overview-pdf → data-pipeline — page no longer exists
     → Drop the slug from `pages`
  🧭 notes-2026-q2-md — sha on disk differs from the manifest
     → Changed outside an ingest; re-ingest as a diff
  🧭 capability-matrix-xlsx — no sidecar at raw/extracted/
     → Re-extract; citations into this source are unverifiable meanwhile

  👉 Approve repairs?
```

### Batch summary

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Ingest complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📄 Files processed:  3
  📝 Sidecars written: 2
  ✨ Pages created:    2
  ✅ Pages updated:    5
  🔄 Re-ingested:      1 (changed source)
  ⏭️ Unchanged:        1 (skipped)
  ⚠️ Contradictions:   1 (resolved)
  🛑 Blocked:          0
  🚫 Skipped:          1 (outside canonical scope)
  📊 Wiki total:       49 pages
  🧾 Sources tracked:  13
  🌿 Branch:           ingest/system-overview-pdf-b72fbfb
```

## Remote ingest

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

## Audit

`tools/audit.mjs` prints this. Findings carry their check ID so the rule files and
the report say the same word — the IDs are frozen; see `docs/audit.md`.

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔎 Wiki Audit — 47 pages scanned
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 Schema (2 errors)
  • SCHEMA-001  wiki/concept-x.md — missing `tier`
  • SCHEMA-005  wiki/acme-corp.md — `type: organisation` is a type_fields value
                → Use `type: entity` with `entity_type: organisation`

🔗 Links (1 error, 2 warnings)
  • LINK-001    wiki/architecture.md → [[deployment-model]] does not exist
  • LINK-002    wiki/legacy-connector.md — 0 backlinks
  • LINK-002    wiki/vendor-b.md — 0 backlinks

📎 Citations (3 errors)
  • CITE-002    wiki/data-pipeline.md — [source: sys-overview] not in `sources`
  • CITE-003    wiki/auth-strategy.md §Approach ¶2 — unsourced claim
  • CITE-005    wiki/system-architecture.md cites system-overview at b45968e…;
                manifest is at b72fbfb… — 4 citations unverified

🧾 Provenance (1 error)
  • PROV-001    wiki/site-survey.md — sources[0].path missing on disk
                brain/raw/extracted/kb-02-site-survey.pdf.txt

🕸️ Stale (3 warnings)
  • STALE-001   wiki/data-pipeline.md — verified 2026-03-15 (137d, curated)
  • STALE-001   wiki/auth-strategy.md — verified 2026-04-02 (119d, curated)
  • STALE-001   wiki/api-gateway.md — stub since 2026-06-20 (40d)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 Audit summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📋 Schema:          2 errors
  🔗 Links:           1 error, 2 warnings
  📎 Citations:       3 errors
  🧾 Provenance:      1 error
  🕸️ Stale:           3 warnings
  ──────────────────────────────
  ⚡ Errors:          7   (exit 1)
  ⚡ Warnings:        5

👉 What would you like to address?
```

Clean run:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔎 Wiki Audit — 47 pages scanned
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ 0 errors
  ⚠️ 4 warnings (3 stale, 1 orphan)
```

## The rules that actually bind

Everything above is shape. These change behaviour, and they are stated in the rule
files:

- **Verdict before work** — every file states new / changed / unchanged before any
  extraction output, so the reader can see what was skipped and why.
- **Always show progress** — `[n/total]` on every file.
- **Truncate hashes to 7 characters** followed by `…` — `b72fbfb…`, never the full
  64. The full digest lives in `manifest.yaml` and in each page's
  `sources[].sha256`.
- **Surface contradictions inline** — quote both claims with their citations,
  recommend a resolution, then stop.
- **Group approval** — present every change for a file or batch, then pause once.
  Never one prompt per page.
- **No wall of text** — one piece of information per line.
