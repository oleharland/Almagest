# Brain — Ingest Rules

**Load this when** you are about to process anything in `brain/raw/`, or ingest a remote source listed in `brain.config.yaml` → `sources.remote`. Read it in full before touching a source file; it is the authoritative version. Writing the resulting pages is governed by `agent/rules/wiki.md` — load that too.

Rules for processing new files from `raw/` into `wiki/`. These activate when working with raw source files.

**Before starting any ingest session, read `brain.config.yaml` for instance-specific configuration.**

## The approval model

The first non-negotiable is **no unreviewed writes** — not "no writes without an in-session yes".

- The agent **never writes to `brain/wiki/` on `main`.** Ingest works on a branch named `ingest/<source-slug>-<sha7>` and commits there. `<source-slug>` is the manifest `id`; `<sha7>` is the first 7 characters of the source's `sha256` (local) or `commit` (remote). A batch of several sources uses the first source's slug and hash.
- **Reaching `main` requires a human merging a reviewed diff.** That is the gate. Unattended ingest onto a branch is permitted and supported; unattended merge to `main` is forbidden and there is no flag for it.
- **`tools/audit.mjs` runs before every commit.** Exit 1 blocks it.

### Risk tiers — what still needs an in-session yes

| Situation | On the ingest branch |
|---|---|
| Evidence-tier additive page, audit clean | Lands automatically |
| Curated-tier new page or update, audit clean | Lands automatically |
| Contradiction with any existing page | **Blocks** — resolve in-session or leave unwritten |
| Contradicts a canonical page | **Blocks** — logged to `brain/canonical-challenges.md`, never merged silently |
| Deletion, merge, or rename of an existing page | **Blocks** |
| `confidence: low` on a curated page | **Blocks** |
| Any audit error (`exit 1`) | **Blocks the commit entirely** |

**Blocked means unwritten.** Not written-provisionally, not written-with-a-TODO. The rest of the batch still lands; the blocked item is reported in the summary and recorded in `log.md` so the next session sees it.

An audit error blocks the *whole commit*, clean pages included. A branch that does not pass the audit is not a reviewable diff — it is a mess someone else has to fix.

`index.md`, `manifest.yaml`, and `log.md` are written in the same commit as the pages they describe. A source is never recorded as ingested by a commit that does not also carry its pages.

## Name anonymization during ingest

**Controlled by `brain.config.yaml` → `anonymization.enabled`.**

- **`enabled: false` (the default)** — skip this whole section. Personal names in source files pass through to the wiki unchanged. This is the right setting for a personal or public knowledge base where names are part of the content.
- **`enabled: true`** — every step below is MANDATORY. Before extracting entities from any raw file, check for personal names.

1. **Check the filename** for personal names. If found, propose a content-based rename to the user (e.g., `meeting-notes-ux-strategy-2026.md`). Wait for approval before proceeding.

2. **Run a named-entity pass over the source** before proposing wiki changes, and stop on every personal name you find. There is no pattern list to consult — you read the text and decide. For each name, propose a role-based replacement (`the site lead`, `the vendor PM`) and **wait for approval before writing it.** Show every replacement in the extraction summary.

3. **The `sources:` field** in wiki frontmatter must use the anonymized filename — in `path` and in `title`. Never write a source reference containing a personal name.

4. **Move step uses the clean name.** When moving `raw/` to `raw/processed/`, use the approved anonymized filename. The extracted sidecar inherits it.

5. **The sidecar is not exempt.** `brain/raw/extracted/` is **committed**, so an un-anonymized sidecar publishes exactly what anonymization exists to withhold. Anonymize the extracted text before writing the sidecar, not after — and never commit a sidecar and "clean it up next commit", because git keeps the first one.

6. **Inline citations** (`[source: ...]`) must use role identifiers, not personal names. The `id` is a slug, so it carries a name just as easily as prose did.

7. **The manifest is not exempt.** `path`, `extracted`, and `previous_paths` in `brain/manifest.yaml` must use the approved anonymized filename. Never record a pre-anonymization filename there — `previous_paths` exists for renames, not as a back door to the original name.

Refer to `brain.config.yaml` → `anonymization.ignore_names` for company/product names that should NOT be flagged as personal data.

### This is best-effort, and saying otherwise would be the dangerous part

The named-entity pass is a model reading text. It misses names. It will miss initials, transliterations, names that look like ordinary words, names in a table header, names in an image the extraction flattened. It replaced a list of regexes precisely because three patterns matching `Firstname Lastname, Role` caught a small fraction of real names while producing the one thing you cannot afford here — the confidence that stops people checking.

**`enabled: true` is not compliance.** It is a first pass that makes the human review tractable. **The control is the review of the diff**, which the approval model already forces: nothing reaches `main` without a person reading what is in it. When the reason for turning this on is personal data under GDPR, read the diff — the branch, the pages, and the sidecar — and read it as the control it is, not as a formality after an automated step you are trusting.

## Filename sanitization (MANDATORY)

All files in `raw/` must have cross-platform-safe filenames before processing. Windows is the strictest of the three major platforms, so these rules target it — a Windows-safe name is safe everywhere. Apply these replacements to every incoming filename:

| Character | Replacement | Example |
|-----------|-------------|---------|
| `%20` (URL-encoded space) | `_` | `Report%20Final.png` → `Report_Final.png` |
| ` ` (space) | `_` | `Done User Stories` → `Done_User_Stories` |
| `:` (colon) | `-` | `Community : District` → `Community_-_District` |
| `—` (em-dash U+2014) | `--` | `Decision — v2` → `Decision_--_v2` |

**Rules:**
- Sanitize the filename BEFORE moving to `raw/processed/`, and BEFORE writing the sidecar — the sidecar name is derived from the sanitized name and renaming it afterwards invalidates every `sources[].path` pointing at it.
- Use `git mv` for renames so git tracks the change.
- If a collision would occur (target name already exists), append `_2`, `_3`, etc. before the extension.
- The `index.md` raw sources entry should use the **sanitized** filename.
- Sanitize BEFORE fingerprinting the file for the manifest. Renaming does not change the bytes, so the `sha256` is the same either way — but `path` must record the sanitized name, and the original goes in `previous_paths`.
- Leave `&`, `(`, `)`, `-`, `.` unchanged — they are safe on every platform.

## Extracted-source sidecars (MANDATORY)

**Every binary source gets a committed plain-text sidecar before a single entity is extracted from it.** No sidecar, no ingest.

`brain/raw/processed/` binaries are gitignored, so on a fresh clone the PDF a page cites is not there. Without a sidecar every citation into that source is permanently unverifiable — the receipt in `manifest.yaml` survives, the evidence does not. For a brain whose entire claim is verifiability that is the deepest hole in it. The sidecar closes it: full text, committed, diffable, greppable, hashable.

### The rule

| | |
|---|---|
| **Which sources** | Anything not already plain text: PDF, DOCX, PPTX, XLSX, audio, video, images. Text sources (`.md`, `.txt`, `.csv`, `.json`, `.srt`) need no sidecar — the original is committed in `raw/processed/` and is cited directly |
| **Where** | `brain/raw/extracted/<original-filename>.txt` — the whole original filename, extension included, plus `.txt`. `system-overview.pdf` → `brain/raw/extracted/system-overview.pdf.txt` |
| **When** | Immediately after fingerprinting, before extraction. It is step 4a of the workflow, not a cleanup pass |
| **What** | The **full** extractable text. Not a summary, not the interesting parts. A summarised sidecar cannot verify a citation, which is the only reason it exists |
| **Cited** | `sources[].path` points at the **sidecar**; `sources[].sha256` is the digest of the **sidecar**, not of the original |
| **Committed** | Yes — `.gitignore` re-includes `brain/raw/extracted/` explicitly |
| **Recorded** | `manifest.yaml` gets `extracted:` (the sidecar path) and `extracted_sha256:` alongside the original's `path` and `sha256` |

### Page markers

A locator has to resolve to a place in the sidecar, so the extraction carries markers. A marker occupies its own line and contains exactly:

```
=== page 12 ===
=== slide 4 ===
=== sheet: Capability Matrix ===
=== t 00:14:32 ===
```

The vocabulary is frozen. Do not invent `--- page 12 ---`, `[page 12]`, or `=== Page 12 ===`. Markers precede the content they label.

| Source kind | Marker | Locator to cite with |
|---|---|---|
| PDF, DOCX | `=== page 12 ===` | `p.12` · `pp.12-14` |
| PPTX | `=== slide 4 ===` | `slide 4` |
| XLSX, CSV export | `=== sheet: Capability Matrix ===` | `row 45` for a row, `§Capability Matrix` for the sheet as a whole |
| Audio, video | `=== t 00:14:32 ===` | `t 00:14:32` |
| Any source with headings | Headings are kept as written | `§Section Name` |
| Plain text, no structure | none | `line <n>` |

Emit a marker for every page, slide, sheet, or timestamp interval — not only the ones you happen to cite. The next re-ingest diffs this file, and a marker that only sometimes appears makes that diff unreadable.

### Extraction

Use whatever your harness has: a native document reader, `pdftotext -layout`, a transcription tool. Record which one in the manifest entry's `notes` — a sidecar re-extracted with a different tool will diff wholesale against the old one, and `notes` is what tells the next session that the diff is noise rather than an edited source.

Then hash the sidecar, because that is the digest pages will cite:

```bash
shasum -a 256 "brain/raw/extracted/system-overview.pdf.txt" | cut -d' ' -f1
```

### Sources with no extractable text

Some sources yield nothing: a scanned PDF with no OCR available, a photograph, audio your harness cannot transcribe.

- If the harness **can** OCR or transcribe, that output **is** the sidecar. Note the method in `notes` and cap `confidence` at `medium` on pages built from it — OCR is a lossy witness.
- If it genuinely cannot, no sidecar exists. Record `extracted: none` with `notes` saying why, point `sources[].path` at the original in `raw/processed/`, and **say plainly in the summary that citations into this source cannot be verified from a clone.**

These are the only sources where the old semantic-comparison caveat still applies — and the only ones where `PROV-001` firing on a fresh clone is expected rather than a bug. Everything else diffs and verifies byte for byte.

## The ingest manifest

`brain/manifest.yaml` is the machine-readable record of every source ever ingested. It exists to make re-ingest incremental: the agent looks a source up before doing any work and gets one of three answers.

**It supplements `index.md` — it does not replace it.** `index.md` is the human-readable catalog; the manifest is the machine record the agent reads to decide whether a source needs work at all. Both are maintained on every ingest. Neither is redundant, and deleting either one breaks something.

Field reference: the header comment in `brain/manifest.yaml`. Full documentation: `docs/manifest.md`.

Manifest writes land in the same branch commit as the pages they describe — never in a commit of their own, never ahead of the pages. The manifest changes *what gets proposed*, never *whether it is reviewable*.

### Computing the fingerprint

Local sources — sha256 of the file's bytes. Nothing to install:

```bash
shasum -a 256 "brain/raw/system-overview.pdf" | cut -d' ' -f1   # macOS / BSD
sha256sum  "brain/raw/system-overview.pdf" | cut -d' ' -f1      # Linux
wc -c < "brain/raw/system-overview.pdf" | tr -d ' '             # bytes
```

Binary sources are hashed **twice**: the original's digest goes in `sha256` and is what change detection compares; the sidecar's digest goes in `extracted_sha256` and is what pages cite in `sources[].sha256`. They are different files and never share a digest.

Remote sources — no hashing. The fingerprint is the commit SHA the file was read at, taken from the MCP file listing.

**Never fingerprint by filename, mtime, or size.** A file that was ingested, edited, and dropped back into `raw/` keeps its name and often its size. Filename matching is exactly what silently loses those edits.

### The three outcomes

Every source resolves to exactly one:

| Outcome | Test | What the agent does |
|---------|------|--------------------|
| **New** | no manifest entry matches | Full ingest — extract to a sidecar, extract entities, propose, write a new entry |
| **Unchanged** | entry found, `sha256` / `commit` identical | Skip. Log a no-op in `log.md`. Do not re-read the source, do not re-extract the sidecar, do not touch the wiki, do not rewrite the entry |
| **Changed** | entry found, `sha256` / `commit` differs | **Diff re-ingest** — see below. Never a fresh page |

Match order for local files is **hash first, path second**:

1. Hash matches an entry → **unchanged**, even if the path differs (that is a rename — see edge cases).
2. Hash matches nothing, path matches an entry → **changed**.
3. Neither matches → **new**.

Remote files match on `id` (`provider:repo:path`), then compare `commit`.

### Diff re-ingest — the `changed` path

A changed source has already produced wiki pages, and the manifest entry's `pages` list names them. The job is to bring those pages up to date — not to re-derive them from scratch, and never to create a second page for an entity that already has one.

1. **Establish what changed in the source — as a byte diff.**
   - **Text sources**: the previous version is still in `raw/processed/`. Diff it directly.
     ```bash
     git diff --no-index brain/raw/processed/notes.md brain/raw/notes.md
     ```
   - **Binary sources**: the previous *sidecar* is committed, so this is also a real diff. Extract the new version to a scratch path, diff against the committed sidecar, and only overwrite the sidecar once the proposal is approved.
     ```bash
     # extract the new version to a scratch path first, then:
     git diff --no-index brain/raw/extracted/system-overview.pdf.txt \
                         /tmp/system-overview.pdf.txt
     ```
     Because the markers are in the diff, a hunk that crosses a `=== page n ===` line tells you which citations moved. Report the diff as byte-level and say how many hunks crossed a marker.
   - **Sources with no extractable text** (`extracted: none`): no sidecar, so no byte diff. Only here does the old rule apply — re-read the source, compare against the claims already on the recorded pages, and state in the summary that the comparison was semantic, not byte-level.
2. **Scope to the recorded pages first.** Load every slug in `pages` before proposing anything. Those pages are what this source is accountable for. Widen scope only if the new version introduces a genuinely new entity.
3. **Classify every difference**, and handle each kind differently:

| Difference | What it means | Action |
|-----------|---------------|--------|
| **Addition** | New fact; nothing on the recorded pages disagrees | Propose an additive update to the recorded page. A genuinely new entity → propose a new page through the normal gate |
| **Revision** | The source now says something different from what the wiki records *from that same source* | **Contradiction.** Route through `agent/rules/wiki.md` → *Handling contradictions*. Blocks. Do not shortcut it |
| **Removal** | A claim the wiki cites from this source is no longer in the source | Never delete silently. Flag it, propose amend / mark disputed / remove, wait |

4. **A newer version of the same source is not automatic authority.** The contradiction protocol runs in full — quote both claims, propose a resolution, let the user pick. "The source was edited since we ingested it" is a strong argument for **Replace** and should be stated as the recommendation; it is not a licence to skip the gate.
5. **Re-verify citations mechanically, not by eye.** Page numbers, section names, row numbers, and timestamps shift when a source is edited. Checking them is now a tool run, not a reading exercise — which matters, because the thing being checked is often a binary you cannot read at all:
   - **`CITE-005` names the work.** It fires on every page whose `sources[].sha256` for this source disagrees with the manifest — *"this page cites v1; the manifest is at v2 — 4 citations unverified"*. That list is exactly what this re-ingest is accountable for. Staleness is a fact here, not a date heuristic.
   - **The sidecar diff shows what moved.** Every hunk crossing a marker line is a locator to re-check.
   - **`tools/audit.mjs` checks the rest.** `CITE-001` for a citation that does not parse, `CITE-002` for an `id` with no matching entry in `sources`.
   - **Then close it out.** Correct the locators, update `sources[].sha256` on every touched page to the new digest, re-run the audit. The re-ingest is not finished while `CITE-005` still fires for this source — a page left citing the old digest is a page whose citations nobody has checked.
6. **Tier rules still apply.** A changed source that contradicts a canonical page is still out of scope — flag and skip, exactly as on first ingest.
7. **After approval, update the entry in place** — never append a second entry for the same source: new `sha256`, new `extracted_sha256`, new `bytes`, `last_ingested` set to today, `pages` set to the union of the old list and any newly touched slugs. `id` and `first_ingested` never change.

### Manifest edge cases

**Source deleted from `raw/processed/`.** Binaries there are gitignored, so on a fresh clone most non-text originals are simply absent. The manifest entry and the **committed sidecar** survive, so the evidence does too — that is the point.

- Set `status: missing`. **Do not delete the wiki pages it produced** — the knowledge stays, and with the sidecar present the citations still verify.
- Do not re-ingest, and do not treat it as new next time it appears.
- If the same file reappears in `raw/` and its `sha256` matches → **unchanged**: restore `path`, set `status: ingested`, no wiki work, no re-extraction.
- If it reappears with a different hash → **changed**, and the byte diff still works: the committed sidecar is the previous version.

**Sidecar missing for a source that should have one.** The entry names an `extracted` path that is not on disk, or has no `extracted` field at all despite being a binary.

- Citations into that source are unverifiable until it is back. Say so.
- Re-extract from the original if it is present, hash it, update `extracted_sha256`. If the digest matches what the citing pages record, nothing else changes.
- If the original is gone too, the source is unrecoverable: leave the pages, set `status: missing`, note it, and do not silently drop the citations.

**Manifest entry whose wiki pages were deleted.** The `pages` list names slugs that no longer exist.

- Do not recreate them. A deleted page was deleted deliberately — deletion is a blocking operation and went through review.
- Report the dangling slugs, propose dropping them from `pages`, and record why in `notes`. `PROV-002` finds these.
- If that source is later re-ingested and the entity reappears, it is a **new page** proposal and goes through the full new-page gate. Never a silent resurrection.

**Rename with identical content.** A file in `raw/` whose `sha256` matches an existing entry at a different path.

- This is a rename or a re-drop, not a new source. **Do not re-ingest and do not re-propose anything.**
- Update `path`, append the old path to `previous_paths`, leave `last_ingested` alone (nothing was ingested), log it as a rename.
- Rename the sidecar to match with `git mv`, update `extracted`, and update `sources[].path` on every page in `pages` — otherwise `PROV-001` fires across all of them. The content did not change, so `extracted_sha256` and every `sources[].sha256` stay exactly as they are.
- If the old path still exists on disk as well, it is a **duplicate copy**, not a rename: skip the new file, log as duplicate, leave the entry untouched, and ask the user whether to remove the copy.
- Filename sanitization is the usual cause. A sanitized rename updates `previous_paths` and `index.md` but never triggers re-extraction.

**Drifted manifest.** The manifest disagrees with the filesystem, `index.md`, or `wiki/`.

- **Precedence: `wiki/` > `index.md` > `manifest.yaml`.** The wiki is the source of truth; the manifest is a cache of decisions already taken. Repair the manifest to match reality — never edit the wiki to match the manifest.
- Never silently rewrite. Present the findings, propose repairs, wait for approval.
- `tools/audit.mjs` finds most of this for you: `PROV-002`, `PROV-003`, `PROV-004`, `CITE-005`.

| Drift | Repair |
|-------|--------|
| File in `raw/processed/` with no entry | Backfill: hash it, take its ingest date and pages from the `index.md` raw sources row, add the entry with `notes: backfilled`. If `index.md` has no row either, use the file's mtime for `first_ingested` and say so in `notes` |
| Entry with no row in `index.md` (`PROV-004`) | Propose the missing `index.md` row |
| Entry whose `pages` name pages that do not exist (`PROV-002`) | See *wiki pages were deleted* above |
| Page citing a source with no entry (`PROV-003`) | Backfill the entry, or correct the page's `sources` if the `id` is simply wrong |
| Entry whose `sha256` does not match the file at `path` | The file changed outside an ingest. Treat as **changed** — diff re-ingest |
| Entry whose `extracted_sha256` does not match the sidecar | The sidecar was hand-edited. Re-verify affected citations and update every citing page's `sources[].sha256` in one proposal |
| Pages citing a digest the manifest has moved past (`CITE-005`) | Diff re-ingest, or — if the source did not change and only the pages are behind — re-verify the locators and update `sources[].sha256` |
| Manifest missing entirely (fresh fork, deleted file) | Recreate it with `version: 1` and `sources: []`, then backfill every row of `index.md`. Report this loudly: the next run must not be mistaken for a mass re-ingest |

**Forced full re-ingest.** When the user explicitly asks to re-ingest a source from scratch, ignore its entry for that run and treat the source as new. The wiki pages still exist, so entity matching (step 6 of the local workflow) still routes to *update* rather than *create*, and contradictions still block. On approval the entry is refreshed, not duplicated — `first_ingested` is preserved.

## Local ingest workflow (raw/ → wiki/)

When new files appear in `raw/`:

1. **Read `index.md` first** — the catalog of existing pages and registered sources. This is orientation: what the brain covers and what shape it is in. It is **not** the dedup mechanism (step 6)
2. **Read `manifest.yaml`** — the machine record of every source already ingested
3. **Fingerprint each file in `raw/`** — sha256 + byte size, then look it up in the manifest (see *The three outcomes* above):
   - **Unchanged** → log a no-op in `log.md`, skip the file entirely
   - **Changed** → go to step 5
   - **New** → go to step 4
4. **If new** → create the branch `ingest/<source-slug>-<sha7>`, then:
   - **4a. Write the sidecar** if the source is binary (see *Extracted-source sidecars*): full text to `brain/raw/extracted/<filename>.txt`, page markers in, sidecar hashed. This happens before extraction, not after
   - **4b. Read the source** — the sidecar for binaries, the original for text — and extract:
     - Entities. Each one becomes a page whose `type` is a value from
       `brain.config.yaml` → `page_types`. Do not put a `type_fields` value there:
       an organisation is `type: entity` with `entity_type: organisation`, never
       `type: organisation`. The two vocabularies are separate and a page carrying
       the wrong one fails `SCHEMA-005`.
     - Key facts and evidence, each with the locator it came from
     - Open questions / unknowns
     - Source attribution — the `sources[]` object: `id`, `path`, `sha256`, `title`
5. **If changed** → diff re-ingest (see *Diff re-ingest* above): byte-diff against the previous version — the copy in `raw/processed/` for text, the committed sidecar for binaries — scope to the pages named in the manifest entry, classify each difference as addition / revision / removal
6. **For each extracted entity, resolve it against `brain/.index/aliases.tsv`** — the generated alias→slug map, one row per alias and one per lowercased title:

   ```bash
   awk -F'\t' 'tolower($1) == "acme corporation" { print $2 }' brain/.index/aliases.tsv
   ```

   - **Hit** → **update** the named page (add new evidence, refine claims, add backlinks).
   - **No hit** → try every alternative name the source uses for the entity, and its slugified title, before concluding it is new.
   - **Still no hit** → **propose** a new page.

   Then write the alternative names into the new or updated page's `aliases`. That field is this lookup's input on the next ingest; leaving it empty is how a wiki forks into two pages for one entity.

   If `brain/.index/` is missing or stale, run `tools/audit.mjs index` first. **Do not fall back to scanning `index.md` for the name.** That is O(corpus) context on every ingest and it depends on recalling a table read tens of thousands of tokens ago — precisely the failure that produces the duplicate page.
7. **Cross-link** — add `[[wikilinks]]` between the new/updated page and related existing pages, and set `relations` where the source states a typed relationship. Update those related pages with backlinks
8. **Move** the original file from `raw/` to `raw/processed/`, and commit the sidecar alongside it
9. **Update `index.md`** — add/update entries in both wiki pages and raw sources tables
10. **Update `manifest.yaml`** — add the entry (new source) or update it in place (changed source): `sha256`, `extracted`, `extracted_sha256`, `bytes`, `last_ingested`, `pages`, `status`
11. **Run `tools/audit.mjs`.** Exit 1 blocks the commit — fix, do not commit around it. Then run `tools/audit.mjs index` so `brain/.index/` matches what you just wrote
12. **Log** the action in `log.md` (date, what was processed, pages created/updated, sources skipped as unchanged, anything blocked)
13. **Commit to the ingest branch** and hand the user the branch name. Merging to `main` is theirs

## Remote ingest (via MCP)

Remote sources are read over MCP — no files are downloaded into `raw/`. Each entry in `sources.remote` names its `provider` (`github` or `gitlab`); see `docs/remote-sources.md` for server setup.

When the user requests remote ingest, or asks to "check [repo] for changes":

1. **Read `brain.config.yaml` → `sources.remote`** for configured repositories
2. **Read `manifest.yaml`** — the commit SHA each remote file was last read at
3. **Connect via the provider's MCP server** — match the entry's `provider` field to the corresponding server in `.mcp.json`
4. **List files** in the configured paths/branches for each remote source
5. **Compare commit SHAs against the manifest** — resolve every file to new / unchanged / changed (see *The three outcomes* above). `index.md` → Remote sources stays the human-readable view of the same facts; the manifest is what the comparison reads
6. **For new files** → read via MCP and extract entities using the same flow as local ingest (steps 4b, 6-7 above)
7. **For changed files** → diff re-ingest (see *Diff re-ingest* above). No previous copy exists locally, so diff via the provider — compare the file between the recorded `commit` and the current one over MCP — and fall back to comparing against the recorded pages if that is unavailable
8. **Instead of moving files**, log the source reference in `index.md` → Remote sources table:
   - Provider and repo path (e.g., `github:acme/platform-docs`)
   - File path within the repo
   - Commit SHA at time of ingest
   - Ingest date
   - Pages created/updated
9. **Same approval model** — ingest branch, blocking risk tiers, audit before commit, human merges
10. **Update `manifest.yaml`** — add or update the entry in place: `commit`, `bytes`, `last_ingested`, `pages`, `status`
11. **Run the audit, regenerate `brain/.index/`, log** the action in `log.md`

**Remote sources take no sidecar.** They are text, they are already versioned, and the `commit` pins the exact bytes — `sources[].path` is the path within the repo and `sources[].sha256` is the digest of the file content as read. A binary in a remote repo is ingested by pulling it into `raw/` and running the local flow, sidecar included.

A remote file that disappears from the repo is the remote equivalent of a deleted `raw/processed/` source: set `status: missing`, keep the entry and the pages, do not re-ingest.

## What ingest writes into a page

Page structure and the full frontmatter schema are `agent/rules/wiki.md`'s job. Four fields are set during ingest, and are the ones most often set wrong.

### `sources` — objects, not path strings

```yaml
sources:
  - id: kb-02-site-survey
    path: brain/raw/extracted/kb-02-site-survey-report.pdf.txt
    sha256: "9f2ac41b8e6d5027f3a1c9be44d70e18ba52c6f0d93e17a4c8bb205e6f31d7a9"
    title: "MCA-SUR-0014 Site Survey Report"
```

| Field | Rule |
|---|---|
| `id` | Short kebab-case slug, unique **within the page**. It exists so citations can be checked mechanically — that is the entire reason for the shape. Keep it stable across re-ingests |
| `path` | The **sidecar** for binary sources; the original in `raw/processed/` for text sources; the in-repo path for remote sources. `PROV-001` if it is not on disk |
| `sha256` | 64 hex, the digest of whatever `path` names — so `extracted_sha256` for binaries, `sha256` for text. It must equal the manifest's value; `CITE-005` compares them |
| `title` | Optional human label. The prose that used to sit inside the citation lives here now |

`origin: source` with an empty `sources` is `CITE-004`. A source cited by a page but absent from the manifest is `PROV-003`.

### `origin`

Ingested pages are **`origin: source`**. Every body claim outside `## Summary`, `## Open questions`, and `## Basis` then needs an inline citation, or `CITE-003` fires. Ingest never produces `origin: self` — that is for conclusions you write yourself, which carry a `## Basis` section of wikilinks instead (`CITE-006`).

### `aliases`

Every alternative name the source uses for the entity. This is not documentation courtesy — it is the input to step 6's dedup lookup, and an empty `aliases` is how the same entity ends up with two pages.

### `relations`

Typed edges, set when the source states the relationship: `supports`, `contradicts`, `supersedes`, `depends_on`. `related` stays the untyped "see also" list. Targets must exist (`LINK-003`); a target you are proposing in the same batch is fine, because both land in the same commit.

## Inline citation format

The grammar is frozen and parseable. `tools/audit.mjs` reads it; anything else is `CITE-001`.

```
[source: <id>, <locator>]
[source: <id>, <locator>, (<date>)]
[source: unknown]
```

```markdown
The system supports automatic failover with constraint-aware routing.
[source: system-overview, p.12]
```

| Part | Rule |
|------|------|
| `<id>` | Must match an `id` in that page's `sources`, or be the literal `unknown`. `CITE-002` catches an id with no entry |
| `<locator>` | Exactly one of: `§<section name>` · `p.<n>` · `pp.<n>-<m>` · `row <n>` · `slide <n>` · `t <hh:mm:ss>` · `line <n>` |
| `<date>` | Optional, parenthesised, last: `(2026-03)` · `(v2.1, 2025-11)` |

**The old prose form is retired.** `[source: System Documentation / Architecture, §Failover, p.3]` does not parse. The human label moved to `sources[].title`, the file moved to `sources[].path`, and what is left is two machine-checkable tokens.

### Citation rules for ingest

- **Propagate citations during ingest.** Write the inline citation at the claim, not afterwards. Don't defer to the frontmatter `sources` list.
- **Both layers are required.** `sources` is the page-level index of what contributed; inline citations are the claim-level pointers into it. Neither substitutes for the other.
- **The locator must resolve in the file at `path`.** Cite `p.12` only if `=== page 12 ===` exists in the sidecar. A locator nobody can follow is worse than none, because it looks checked.
- **No unsourced claims.** If you can't cite it, mark it `[source: unknown]` and add it to `## Open questions`.
- **Precision over brevity.** The reader should find the passage in under 30 seconds — now by grepping the sidecar.

## Tier validation during ingest

Before writing any page, the agent checks:

1. **Does this entity match canonical definitions?** (refer to `brain.config.yaml` → `canonical_pages` for the reference list pages) — if not, flag and skip.
2. **Does this contradict a canonical page?** — if yes, it is out of scope: log it to `brain/canonical-challenges.md` and block. Never merge it into the canonical page.
3. **Does this contradict a curated page?** — if yes, surface it to the user (full contradiction flow). Blocks.
4. **Does this contradict other evidence?** — if yes, note it on the page, continue.

## Capability tiers for ingest

| Task | Tier | Why |
|------|------|-----|
| Manifest lookup / fingerprinting | mechanical | Hashing a file and comparing hex strings is mechanical |
| Sidecar extraction | mechanical | Getting text out of a document with markers in the right places is parsing |
| Extraction | mechanical | Pulling entities and facts from a source document is straightforward |
| Entity dedup | mechanical | A grep against `brain/.index/aliases.tsv` |
| Citation re-verification | mechanical | The audit and the sidecar diff decide it; no weighing involved |
| Canonical validation | mechanical | String comparison against a fixed list |
| Diff classification (changed source) | **judgment** | Deciding whether an edit is an addition, a revision, or a removal — and what it does to existing pages — is judgment, not diffing |
| Contradiction resolution | **judgment** | Weighing which source is stronger requires judgment |
| Manifest drift repair | **judgment** | Reconciling manifest, `index.md`, and `wiki/` means deciding which record is wrong |
| Merge proposals | **judgment** | Deciding whether two pages describe the same entity requires domain understanding |

Tiers map to concrete models via `brain.config.yaml` → `agent.profiles[agent.harness]`. This is advisory: steps marked **judgment** warrant your most capable available model; if your harness cannot switch models, run the whole session on it.

## Terminal output

Formats — phase headers, per-file blocks, the emoji key, sample transcripts, the audit and drift reports — are in `docs/terminal-output.md`. Read it once; it is a reference, not a rule.

Five things there change behaviour and are binding:

- **Verdict before work** — every file states new / changed / unchanged before any extraction output, so the reader sees what was skipped and why.
- **Always show progress** — `[n/total]` on every file.
- **Truncate hashes to 7 characters** followed by `…` — `b72fbfb…`, never the full 64. The full digest lives in `manifest.yaml` and in each page's `sources[].sha256`.
- **Surface contradictions inline** — quote both claims with their citations, recommend a resolution, then stop. A contradiction blocks.
- **Group approval** — present every change for a file or batch, then pause once. Never one prompt per page.

## General ingest rules

- **No sidecar, no ingest.** A binary source without extractable text committed alongside it produces citations nobody can check.
- **Synthesis over atoms.** Update existing pages, don't create new files for every fact. Create a new page only when a genuinely new entity appears.
- **Fingerprint, don't guess.** A source is unchanged only when its `sha256` or `commit` matches the manifest. Same filename is not the same file.
- **The manifest never gates review.** It decides what the agent proposes. The human still decides what reaches `main`.
- **Flag unknowns explicitly.** If data is missing, say so and name what would resolve it.
- **`[[Wikilinks]]` liberally.** Every entity reference should be a link. This builds the graph.
- **Write-if-changed.** Don't rewrite files that haven't changed — sidecars included.
