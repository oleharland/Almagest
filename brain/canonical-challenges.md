# Canonical challenges

**Append-only ledger of evidence that contradicts a canonical page.** Kept, never merged, never discarded.

Canonical pages (`brain.config.yaml` → `canonical_pages`) are agent-unwritable: the agent cannot propose a change to one, and nothing in this file ever reaches them. But "the agent cannot change it" is not "the evidence did not exist". When ingest turns up material that a canonical page contradicts, the material is recorded here and the canonical page is left alone. A human resolves it — or does not — in the open.

This is the fix for the only place in the repo where a contradiction used to be thrown away. The old rule flagged contradicting evidence as "outside canonical scope" and moved on, which left no trace anywhere; that discarded the contradiction, in direct breach of non-negotiable #3, *surface contradictions, never overwrite them*. A canonical page that has drifted from reality should become visible, not merely unchallenged.

**This file lives outside `brain/wiki/` deliberately.** The wiki write gate does not apply to it, so appending a row is never itself a wiki edit needing approval. The agent appends without asking; it still asks before anything reaches a page.

## How rows get here

1. Ingest finds a claim incompatible with a canonical page.
2. The claim does **not** enter the wiki. The canonical page is **not** modified.
3. A row is appended below, and the run summary and `log.md` both name it.
4. `tools/audit.mjs` reports open rows as `CANON-001` — a warning, not an error — until a human sets the row's status.

## Row format

| Column | What |
|---|---|
| `Date` | ISO date the challenge was recorded |
| `Canonical page` | `[[wikilink]]` to the canonical page being contradicted |
| `Challenging claim` | One sentence, quoted from or faithful to the source |
| `Source` | `<source id>, <locator>` — the frozen citation grammar without the brackets |
| `Status` | `open` · `accepted` (a human edited the canonical page) · `rejected` (evidence is wrong) · `superseded` (a later row replaces this one) |

Rows are appended, never edited away. Resolving a challenge changes its `Status` and nothing else. A rejected row stays: the next person to hit the same source deserves to know it was already weighed.

## Challenges

| Date | Canonical page | Challenging claim | Source | Status |
|---|---|---|---|---|
| | | | | |
