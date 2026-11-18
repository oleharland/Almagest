# The Ingest Manifest

`brain/manifest.yaml` is a machine-readable record of every source ever ingested into a brain. It exists for one reason: **incremental re-ingest**. Before the agent does any work on a source it looks the source up in the manifest and gets one of three answers — new, unchanged, or changed — and only the first and the third cost anything.

The manifest is maintained by the agent. You will rarely edit it by hand, and the only good reason to do so is repairing drift.

It records two things that make a citation checkable years later: the fingerprint of the source as ingested, and — for binaries — the path and digest of the committed text sidecar the pages actually cite.

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
| `brain/raw/extracted/` | The **evidence**. One committed plain-text sidecar per binary source, with page markers, so a citation into a gitignored PDF can still be checked from a clone. |
| `brain/.index/` | **Generated** lookup tables (`tools/audit.mjs index`). `aliases.tsv` is what entity dedup greps instead of re-reading the catalog. |
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
    extracted: brain/raw/extracted/system-overview.pdf.txt
    extracted_sha256: 4c1d9a2e0f83b7615ad4c02e9f7188bb35c6d4a1e0927fb3c85d61ae4f20c7d9
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

  - id: "product-drive:1AbCdEfGhIjK"
    kind: connector
    connector: product-drive
    server: google-drive
    ref: 1AbCdEfGhIjK
    version: "2026-08-24T16:02:11Z"
    path: brain/raw/extracted/product-drive/1abcdefghijk-a24224a1.txt
    sha256: ac4e1a1a82cbda5cd119a77100ffd01aaa046bedfe855e512169979e0fb2aec2
    extracted: brain/raw/extracted/product-drive/1abcdefghijk-a24224a1.txt
    extracted_sha256: ac4e1a1a82cbda5cd119a77100ffd01aaa046bedfe855e512169979e0fb2aec2
    snapshot: commit
    label: product
    bytes: 427
    first_ingested: 2026-08-25
    last_ingested: 2026-08-25
    pages:
      - release-policy
    status: ingested
```

A fresh brain ships with `sources: []` and the same field reference in comments.

## Schema

### Common fields

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | yes | Stable identifier, assigned at first ingest and **never changed**. Convention: slugified filename (local), `provider:repo:path` (remote), `<connector-id>:<ref>` (connector). It survives renames — that is why it is separate from `path` |
| `kind` | yes | `local`, `remote`, or `connector` |
| `path` | yes | Local: path from the repo root to the **original** (gitignored, if binary). Remote: path within the repo. Connector: the snapshot path, same as `extracted` |
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
| `sha256` | yes | 64-character hex digest of the **original's** bytes at last ingest. This is what change detection compares |
| `extracted` | binary sources | Path to the committed text sidecar under `brain/raw/extracted/`. `none` when the source has no extractable text at all — `notes` says why. Text sources omit it: the original is committed and is cited directly |
| `extracted_sha256` | with `extracted` | 64-character hex digest of the **sidecar**. This is the value every citing page carries in `sources[].sha256` |
| `previous_paths` | no | Earlier locations of the same content: renames, filename sanitization, moves |

### Remote-only fields

| Field | Required | Meaning |
|-------|----------|---------|
| `provider` | yes | `github` or `gitlab` |
| `repo` | yes | `owner/repo` on GitHub, `namespace/project` on GitLab |
| `branch` | yes | Branch the file was read from |
| `commit` | yes | Commit SHA the file was read at |
| `label` | no | The `label` from `brain.config.yaml` → `sources.remote` |

### Connector-only fields

A `kind: connector` source is an item the Almagest service fetched from an MCP
server ([v2/connectors.md](v2/connectors.md)). There is no original on disk —
the provider holds it — so the rendered **snapshot** is both the thing
fingerprinted and the committed sidecar pages cite. `sha256` and
`extracted_sha256` are therefore the same digest, and `path` and `extracted`
the same file.

| Field | Required | Meaning |
|-------|----------|---------|
| `connector` | yes | The connector `id` from `brain.config.yaml` → `sources.connectors` |
| `server` | yes | The MCP server it was read from: the `.mcp.json` key, an inline server's `name`, its URL without the query string, or `stdio:<command>`. Never anything that can carry a credential |
| `ref` | yes | The provider's id for the item (Drive file id, issue id, resource URI, repo path) |
| `version` | no | The provider's revision marker at fetch time (`updatedAt`, etag, blob sha). An optimisation for skipping fetches, **never** the change detector |
| `commit` | no | For `github` / `gitlab` connectors: the commit the file was read at |
| `sha256` | yes | 64-character hex digest of the **snapshot file** — every byte, header included. Computed by the service, never by the agent |
| `extracted` | yes | The snapshot path: `brain/raw/extracted/<connector-id>/<slug>.txt` |
| `extracted_sha256` | yes | Same digest as `sha256`. This is the value every citing page carries in `sources[].sha256` |
| `snapshot` | no | `commit` (default) or `ephemeral`. An ephemeral snapshot is not committed, so its citations cannot be resolved from a clone — `PROV-001` reports them as a warning |
| `label` | no | The connector's `label` |

A v1 `sources.remote` repo now syncs as a connector (`github` / `gitlab` recipe). When one of its files already has a `kind: remote` entry, the new `kind: connector` entry replaces it: the old entry gets `status: superseded` and `superseded_by: <connector entry id>`, and its `pages` carry over.

### Status values

| Status | Meaning |
|--------|---------|
| `ingested` | Fully processed. The manifest matches reality |
| `partial` | The user approved some proposed pages and rejected others. `notes` says which |
| `skipped` | Deliberately not ingested — outside canonical scope. Recorded so it is not re-proposed on every run |
| `missing` | The original is gone from `raw/processed/`, the remote file is gone from the repo, or a full connector listing no longer contains the item. Pages stay, the entry stays, nothing is re-ingested — and the sidecar is committed, so citations into it still verify |
| `superseded` | Replaced by another entry, named in `superseded_by` |

## Extracted sidecars

A manifest entry is a receipt. On its own it proves an ingest happened; it does not let anyone check what the ingest claimed. The sidecar is the part that does.

Every binary source — PDF, deck, spreadsheet, audio, video — is extracted to plain text at `brain/raw/extracted/<original-filename>.txt` **before** any entity is pulled out of it, and that file is committed. The original stays in `brain/raw/processed/` and stays gitignored.

```
brain/raw/processed/system-overview.pdf         gitignored — the original
brain/raw/extracted/system-overview.pdf.txt     committed  — what pages cite
```

The sidecar carries markers so a locator resolves to a place in it. Each marker sits alone on its own line:

```
=== page 12 ===
=== slide 4 ===
=== sheet: Capability Matrix ===
=== t 00:14:32 ===
```

That buys three things at once:

| | |
|---|---|
| **Verifiable citations** | `[source: system-overview, p.12]` can be followed from a fresh clone with `grep`, with no PDF and no tooling |
| **Byte-level re-ingest** | A changed binary is diffed against its committed sidecar. The old "the comparison was semantic, not byte-level" caveat now applies only to sources with no extractable text at all |
| **A checkable audit** | `tools/audit.mjs` can resolve `sources[].path` (`PROV-001`) and compare digests (`CITE-005`) because the file it needs is in the repo |

Text sources get no sidecar: the original is already committed and is cited directly. Remote sources get none either — the `commit` pins the exact bytes. Connector sources are the opposite case: the snapshot is the *only* copy in the repo, written by the service under `brain/raw/extracted/<connector-id>/`, with `=== section: … ===`, `=== row n ===` and `=== t hh:mm:ss ===` markers as well as page markers.

### The digest appears twice, on purpose

The same sha256 is recorded in two places:

| Where | Field | What it is for |
|---|---|---|
| `brain/manifest.yaml` | `extracted_sha256` (binaries) / `sha256` (text) | The version of the source this brain has ingested |
| Every wiki page citing it | `sources[].sha256` | The version of the source *that page's citations were checked against* |

They are meant to be equal. When they are not, the page is citing a version the manifest has moved past — and `CITE-005` reports it:

```
CITE-005  wiki/system-architecture.md cites system-overview at b45968e…;
          manifest is at b72fbfb… — 4 citations unverified
```

This is the difference between a heuristic and a fact. `last_verified` says a date went by and invites you to guess whether anything moved. `CITE-005` says the bytes changed and names the four citations nobody has re-checked since. Staleness stops being a feeling about age and becomes a countable list of work.

Closing it out means correcting the locators against the sidecar diff and updating `sources[].sha256` on each page. A page left carrying the old digest keeps failing the audit, which is the point: the failure is the record that the check has not been done.

## How incremental re-ingest works

### The fingerprint

Local sources are fingerprinted by the sha256 of their bytes. No dependency, no tooling:

```bash
shasum -a 256 "brain/raw/system-overview.pdf" | cut -d' ' -f1   # macOS / BSD
sha256sum  "brain/raw/system-overview.pdf" | cut -d' ' -f1      # Linux
```

Binary sources are hashed twice, because two different files matter. The original's digest goes in `sha256` and is what change detection compares. The sidecar's digest goes in `extracted_sha256`, and that is the one wiki pages carry — a page cites the file its locators point into, which is the sidecar.

Remote sources are not hashed. The fingerprint is the commit SHA the file was read at, which the provider supplies over MCP.

Connector sources are hashed by the **service**: sha256 of the rendered snapshot bytes. The snapshot holds nothing volatile (no fetch time, no provider revision), so the same upstream content always produces the same digest, and `shasum -a 256` on the committed snapshot reproduces `extracted_sha256`. The provider's `version` only lets a sync skip re-fetching an item; it never decides that something is unchanged.

Filename, modification time, and file size are never used to decide whether a source changed. An edited file usually keeps its name and often keeps its size.

### Case 1 — New

No manifest entry matches. Normal full ingest: write the sidecar if the source is binary, extract entities, propose pages, write them to the ingest branch, then add a manifest entry with `first_ingested` and `last_ingested` both set to today — in the same commit as the pages.

### Case 2 — Unchanged

An entry matches and the `sha256` (or `commit`) is identical. The agent skips the source entirely — it does not re-read it, does not re-extract the sidecar, does not touch the wiki, and does not rewrite the entry. A no-op line goes into `log.md` so the skip is visible.

This is the case that makes re-running ingest over a large library cheap.

### Case 3 — Changed

An entry matches but the fingerprint differs. This is the interesting one, and it is **not** treated as a new source.

1. **The agent works out what changed — as a byte diff.** For text sources the previous version is still in `brain/raw/processed/`:
   ```bash
   git diff --no-index brain/raw/processed/notes.md brain/raw/notes.md
   ```
   For PDFs, decks, video, and spreadsheets the old original is often gitignored and absent, but its **sidecar is committed**. The agent extracts the new version to a scratch path and diffs it against the sidecar, which is a real diff of the same kind. Because the page markers are in the diff, a hunk crossing a `=== page 12 ===` line is a citation that needs re-checking.

   Only a source with no extractable text at all (`extracted: none` — an unOCR'd scan, silent footage) falls back to the old behaviour: re-read it, compare against the claims already on the wiki, and say in the summary that the comparison was semantic, not byte-level.

2. **Scope comes from the manifest.** The entry's `pages` list names the wiki pages that source is accountable for. Those get loaded first. Scope widens only if the new version introduces a genuinely new entity.

3. **Every difference is classified**, and the three kinds are handled differently:

   | Difference | Handling |
   |-----------|----------|
   | **Addition** — a new fact nothing disagrees with | Proposed as an additive update to the recorded page, or a new page if it is a new entity |
   | **Revision** — the source now says something different from what the wiki records from it | A contradiction. Routed through the contradiction protocol in `agent/rules/wiki.md`: both claims quoted with sources, a resolution proposed, you decide |
   | **Removal** — a claim the wiki cites is no longer in the source | Never deleted silently. Flagged, with amend / mark disputed / remove proposed |

4. **A newer version is not automatic authority.** "The source was edited since we ingested it" is a strong argument for replacing the old claim, and the agent will recommend that — but it is a recommendation, and the contradiction gate still runs.

5. **Citations get re-verified mechanically.** Page numbers, section names, row numbers, and timestamps move when a source is edited. `CITE-005` names exactly which pages are affected — it compares each page's `sources[].sha256` against the manifest and reports *"this page cites v1; the manifest is at v2 — 4 citations unverified"*. The agent corrects the locators against the sidecar diff, updates `sources[].sha256` on every touched page, and re-runs the audit. The re-ingest is not finished while `CITE-005` still fires for that source.

6. **On approval the entry is updated in place** — new fingerprint, new `bytes`, `last_ingested` set to today, `pages` extended with anything newly touched. `id` and `first_ingested` never change, and no second entry is created for the same source.

Nothing here bypasses review. Ingest writes to an `ingest/<source-slug>-<sha7>` branch, never to `main`, and `tools/audit.mjs` runs before the commit — an error blocks the whole commit. Reaching `main` takes a human merging the diff. Incremental re-ingest changes *what the agent proposes*; it never changes *who has to read it*.

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
| An entry whose `pages` name pages that no longer exist | The dangling slugs are dropped from `pages`. Deleted pages are **not** recreated — deletion is a blocking operation that a human reviewed, and undoing it silently would be worse than the drift |
| An entry whose `sha256` does not match the file at `path` | The file changed outside an ingest. Treated as a changed source: diff re-ingest |
| An entry whose `extracted_sha256` does not match the sidecar (`CITE-005` on its pages) | The sidecar was hand-edited or re-extracted. Affected citations are re-verified and every citing page's `sources[].sha256` updated in one proposal |
| An entry with no sidecar where one is required (`PROV-001`) | Re-extracted from the original if it is present. If it is not, the citations are unverifiable and the agent says so rather than quietly leaving them |
| A page citing a source with no manifest entry (`PROV-003`) | The entry is backfilled, or the page's `sources` corrected if the `id` is simply wrong |
| The manifest is missing entirely | Recreated as `version: 1` / `sources: []`, then backfilled from every row of `index.md`. Expect a loud report — the run after that must not be mistaken for a mass re-ingest |

### Sources that vanish

`brain/raw/processed/` is gitignored for binaries — PDFs, video, spreadsheets, images. On a fresh clone those originals are simply not there. That is deliberate: a repo is not a file server.

It used to mean something worse than it sounds. The manifest entry survived, so you kept the *receipt* — but the evidence was gone, and every `p.12` on every page citing that PDF became permanently uncheckable by anyone who had not been there. For a brain whose whole claim is verifiability, that was the deepest hole in it.

**The sidecar closes it.** `brain/raw/extracted/<name>.pdf.txt` is committed, carries the full text with page markers, and is the file `sources[].path` points at. A fresh clone can follow every citation, grep the passage, and diff the next version of the source against it — with no original present at all.

The agent still sets `status: missing` when the original goes, and still does **not** delete the pages it produced. Drop the same file back into `raw/` and its hash will match, so it resolves as unchanged and `status` returns to `ingested` with no wiki work and no re-extraction.

The exception is a source with no extractable text. There the sidecar is `none`, `sources[].path` points at the gitignored original, and `PROV-001` will fire on a fresh clone. That is honest reporting, not a bug: those citations really are unverifiable from a clone, and the audit says so rather than letting them look checked.

### Renames

A file whose sha256 matches an existing entry at a different path is a rename, not a new source. The agent updates `path`, appends the old one to `previous_paths`, and does not re-ingest anything — `last_ingested` stays where it was, because nothing was ingested.

The sidecar is renamed to match, `extracted` is updated, and so is `sources[].path` on every page in `pages` — otherwise `PROV-001` fires across all of them. No digest changes: the content did not.

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
