# The Ingest Manifest

`brain/manifest.yaml` is a machine-readable record of every source ever ingested into a brain. It exists for one reason: **incremental re-ingest**. Before the agent does any work on a source it looks the source up in the manifest and gets one of three answers — new, unchanged, or changed — and only the first and the third cost anything.

The manifest is maintained by the agent. You will rarely edit it by hand, and the only good reason to do so is repairing drift.

## Why it exists

Without a manifest, duplicate detection has to fall back on the filename. That is wrong in a way that loses data:

> Ingest `q3-roadmap.md`. Edit it. Drop it back into `brain/raw/`.
> Filename matching says "already processed" and skips it. Your edits never reach the wiki, and nothing tells you.

The manifest replaces filename matching with a content fingerprint. A file that changed has a different sha256, so it is a **changed source** — the agent diffs it against the version it ingested last time and proposes targeted updates to the pages that source already produced.

The same problem exists remotely, in a milder form. Remote ingest already compared commit SHAs, but it read them out of a prose table in `index.md`. The manifest gives both source kinds one machine-readable home.

## How it fits together

| Piece | Role |
|-------|------|
| `brain/index.md` | The **human-readable catalog**. What pages exist, what sources were ingested, in tables meant to be read. |
| `brain/manifest.yaml` | The **machine record**. Fingerprints, dates, and the page slugs each source produced. What the agent reads to decide what to do. |
| `agent/rules/ingest.md` | The protocol — how a lookup turns into work, and how a changed source is re-ingested. |
| `brain.config.yaml` → `manifest.path` | Where the file lives. The only knob. |

**The manifest supplements `index.md`. It does not replace it.** They record overlapping facts for different readers, and both are written on every ingest. Delete `index.md` and you lose the catalog humans and the query agent read first. Delete `manifest.yaml` and every source looks new again. Keep both.

The manifest is committed to git, so `git log -p brain/manifest.yaml` is its revision history. There is no separate history inside the file.

## The file

```yaml
version: 1

sources:
  - id: system-overview-pdf
    kind: local
    path: brain/raw/processed/system-overview.pdf
    sha256: b72fbfb7f607dc872d4ab091ca308a4f9c6d111e17e63ba81365c242d14e6c83
    bytes: 2481920
    first_ingested: 2026-07-14
    last_ingested: 2026-08-21
    previous_paths:
      - brain/raw/processed/System Overview.pdf
    pages:
      - system-architecture
      - data-pipeline
    status: ingested
    notes: "Re-ingested 2026-08-21 — §Failover rewritten upstream."

  - id: "github:acme/platform-docs:docs/architecture/overview.md"
    kind: remote
    provider: github
    repo: acme/platform-docs
    branch: main
    path: docs/architecture/overview.md
    commit: 9505cacb7c710ed17125fcc6cb3669e8ddca6c8c
    bytes: 18422
    first_ingested: 2026-06-02
    last_ingested: 2026-08-25
    label: platform
    pages:
      - architecture-overview
    status: ingested
```

A fresh brain ships with `sources: []` and the same field reference in comments.

## Schema

### Common fields

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | yes | Stable identifier, assigned at first ingest and **never changed**. Convention: slugified filename (local), `provider:repo:path` (remote). It survives renames — that is why it is separate from `path` |
| `kind` | yes | `local` or `remote` |
| `path` | yes | Local: path from the repo root. Remote: path within the repo |
| `bytes` | yes | Size at last ingest. Diagnostic only — never used for change detection |
| `first_ingested` | yes | ISO-8601 date of the first successful ingest. Never changes |
| `last_ingested` | yes | ISO-8601 date of the most recent successful ingest |
| `pages` | yes | Bare wiki slugs this source created or touched — no `.md`, no `[[brackets]]`. This is the field that makes a re-ingest targeted instead of a blind re-extraction |
| `status` | yes | See below |
| `superseded_by` | no | `id` of the replacing entry. Only with `status: superseded` |
| `notes` | no | Free text: why a source was skipped, what changed on the last re-ingest, that the entry was backfilled |

### Local-only fields

| Field | Required | Meaning |
|-------|----------|---------|
| `sha256` | yes | 64-character hex digest of the file's bytes at last ingest |
| `previous_paths` | no | Earlier locations of the same content: renames, filename sanitization, moves |

### Remote-only fields

| Field | Required | Meaning |
|-------|----------|---------|
| `provider` | yes | `github` or `gitlab` |
| `repo` | yes | `owner/repo` on GitHub, `namespace/project` on GitLab |
| `branch` | yes | Branch the file was read from |
| `commit` | yes | Commit SHA the file was read at |
| `label` | no | The `label` from `brain.config.yaml` → `sources.remote` |

### Status values

| Status | Meaning |
|--------|---------|
| `ingested` | Fully processed. The manifest matches reality |
| `partial` | The user approved some proposed pages and rejected others. `notes` says which |
| `skipped` | Deliberately not ingested — outside canonical scope. Recorded so it is not re-proposed on every run |
| `missing` | The source file is gone from `raw/processed/`, or the remote file is gone from the repo. Pages stay, the entry stays, nothing is re-ingested |
| `superseded` | Replaced by another entry, named in `superseded_by` |

## How incremental re-ingest works

### The fingerprint

Local sources are fingerprinted by the sha256 of their bytes. No dependency, no tooling:

```bash
shasum -a 256 "brain/raw/system-overview.pdf" | cut -d' ' -f1   # macOS / BSD
sha256sum  "brain/raw/system-overview.pdf" | cut -d' ' -f1      # Linux
```

Remote sources are not hashed. The fingerprint is the commit SHA the file was read at, which the provider supplies over MCP.

Filename, modification time, and file size are never used to decide whether a source changed. An edited file usually keeps its name and often keeps its size.

### Case 1 — New

No manifest entry matches. Normal full ingest: read, extract entities, propose pages, wait for approval, write the pages, then add a manifest entry with `first_ingested` and `last_ingested` both set to today.

### Case 2 — Unchanged

An entry matches and the `sha256` (or `commit`) is identical. The agent skips the source entirely — it does not re-read it, does not touch the wiki, and does not rewrite the entry. A no-op line goes into `log.md` so the skip is visible.

This is the case that makes re-running ingest over a large library cheap.

### Case 3 — Changed

An entry matches but the fingerprint differs. This is the interesting one, and it is **not** treated as a new source.

1. **The agent works out what changed.** For text sources the previous version is still in `brain/raw/processed/`, so it is a real diff:
   ```bash
   git diff --no-index brain/raw/processed/notes.md brain/raw/notes.md
   ```
   For PDFs, video, and spreadsheets the old copy is often gitignored and absent. The agent re-extracts and compares against the claims already on the wiki, and says so in the summary — the comparison is semantic, not byte-level.

2. **Scope comes from the manifest.** The entry's `pages` list names the wiki pages that source is accountable for. Those get loaded first. Scope widens only if the new version introduces a genuinely new entity.

3. **Every difference is classified**, and the three kinds are handled differently:

   | Difference | Handling |
   |-----------|----------|
   | **Addition** — a new fact nothing disagrees with | Proposed as an additive update to the recorded page, or a new page if it is a new entity |
   | **Revision** — the source now says something different from what the wiki records from it | A contradiction. Routed through the contradiction protocol in `agent/rules/wiki.md`: both claims quoted with sources, a resolution proposed, you decide |
   | **Removal** — a claim the wiki cites is no longer in the source | Never deleted silently. Flagged, with amend / mark disputed / remove proposed |

4. **A newer version is not automatic authority.** "The source was edited since we ingested it" is a strong argument for replacing the old claim, and the agent will recommend that — but it is a recommendation, and the contradiction gate still runs.

5. **Citations get re-verified.** Page numbers, section names, and row numbers move when a source is edited. Inline citations pointing at the changed source are checked against the new version and corrected in the same proposal.

6. **On approval the entry is updated in place** — new fingerprint, new `bytes`, `last_ingested` set to today, `pages` extended with anything newly touched. `id` and `first_ingested` never change, and no second entry is created for the same source.

Nothing here bypasses approval. Incremental re-ingest changes *what the agent proposes*; it never changes *whether you approve it*.

## Manifest vs. index.md

They record overlapping facts, deliberately.

| | `index.md` | `manifest.yaml` |
|---|---|---|
| Audience | Humans, and the query agent | The ingest agent |
| Format | Markdown tables | YAML |
| Granularity | One row per source, prose dates | Fingerprints, byte sizes, page slugs, status |
| Read when | Answering a question, browsing what exists | Deciding whether a source needs work |
| If it disappears | The catalog is gone; the agent has no cheap way to see what pages exist | Every source looks new again |

When the two disagree, the precedence is **`wiki/` > `index.md` > `manifest.yaml`**. The wiki is the source of truth. The manifest is a cache of decisions already taken, so it is the one that gets repaired.

## Repairing a drifted manifest

Drift is normal. It happens after a hand-edit, a merge, a partial ingest that was interrupted, or a fresh clone where gitignored binaries never arrived.

Ask the agent to reconcile:

> "Check the manifest against the wiki and index"

It reports what it found and proposes repairs. It never rewrites the manifest silently, and it never edits the wiki to match the manifest.

| Drift | Repair |
|-------|--------|
| A file in `raw/processed/` with no entry | Backfilled: hashed, its ingest date and pages taken from the `index.md` raw sources row, `notes: backfilled`. With no `index.md` row either, the file's mtime is used for `first_ingested` and `notes` says so |
| An entry with no row in `index.md` | The missing `index.md` row is proposed |
| An entry whose `pages` name pages that no longer exist | The dangling slugs are dropped from `pages`. Deleted pages are **not** recreated — deletion went through the approval gate, and undoing it silently would be worse than the drift |
| An entry whose `sha256` does not match the file at `path` | The file changed outside an ingest. Treated as a changed source: diff re-ingest |
| The manifest is missing entirely | Recreated as `version: 1` / `sources: []`, then backfilled from every row of `index.md`. Expect a loud report — the run after that must not be mistaken for a mass re-ingest |

### Sources that vanish

`brain/raw/processed/` is gitignored for binaries — PDFs, video, spreadsheets, images. On a fresh clone those files are simply not there, and the manifest entry is the only surviving record that they were ever ingested. That is a feature, not drift.

The agent sets `status: missing` and stops. It does **not** delete the wiki pages that source produced — the knowledge stays, only the receipt is gone. Drop the same file back into `raw/` and its hash will match, so it resolves as unchanged and `status` returns to `ingested` with no wiki work at all.

### Renames

A file whose sha256 matches an existing entry at a different path is a rename, not a new source. The agent updates `path`, appends the old one to `previous_paths`, and does not re-ingest anything — `last_ingested` stays where it was, because nothing was ingested.

If the old path still exists on disk too, it is a duplicate copy rather than a rename. The agent skips the new file, logs it, and asks whether you want the copy removed.

## Forcing a full re-ingest

To reprocess a source from scratch — after fixing a bad extraction, or after changing your `page_types`:

> "Re-ingest system-overview.pdf from scratch, ignore the manifest"

The agent ignores that entry for the run and treats the source as new. Two things still hold:

- The existing wiki pages are still there, so entity matching still routes to *update* rather than *create*. You will not get duplicate pages.
- Contradictions still go through the full protocol.

On approval the entry is refreshed rather than duplicated, and `first_ingested` is preserved — the record of when the source first entered the brain is not something a re-run should destroy.

To re-ingest everything, delete `brain/manifest.yaml` and let the agent recreate it. This is a heavy operation on a large brain and gives you the full approval queue again. Prefer the targeted form.

## Configuration

One knob, in `brain.config.yaml`:

```yaml
manifest:
  path: brain/manifest.yaml
```

The only reason to change it is a multi-brain setup, where each brain carries its own manifest next to its own `index.md` — see [Multi-Brain Expansion](multi-brain.md).

There is deliberately no enable/disable switch, no choice of hash algorithm, and no mtime-based mode. Filename and mtime matching are the bug the manifest exists to fix, so they are not offered as options, and sha256 needs no configuration.
