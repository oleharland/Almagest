# Live lookup: one ask, cheapest source first

Status: built, and off by default. Set `mcp.lookup.enabled: true` to turn it
on. The ladder, the labels, the `search` block, enrichment and the telemetry
field are in the code and covered by tests against an in-memory MCP server. The
`search` block of the Drive recipe has not been checked against the real server.
[Before turning it on](#before-turning-it-on) lists what is not verified, and
[What is built and what is not](#what-is-built-and-what-is-not) lists the rest.

## Before turning it on

Lookup is off by default for these reasons:

- Nothing has run against a real provider. Every test uses an in-memory MCP
  server.
- The Drive `search` block is unverified, and the `fullText contains` syntax in
  it is an assumption.
- Drive is the only shipped recipe with a `search` block. A connector on any
  other recipe takes part in steps 1 and 2 only, unless you add an inline
  `search:` block.
- The feature has not been operated end to end with a running service.
- The review-state check and the staged retry were tested with fake ingest and
  stores only.

## The idea

Today a chat that asks the brain a question it cannot answer gets "not
covered", and the person or the chat then goes looking in Drive, Notion or
Linear by hand. That is the expensive path: the chat needs every one of those
MCP servers connected, reads their search results, and pulls whole documents
into its context.

With live lookup the chat still makes one call, `ask`. When no reviewed page
answers, the Almagest server does the looking itself, through the connectors it
already has. It returns only the passages that match, inside the same token
budget as a normal answer, marked as source or unreviewed text. A document it
fetched from a connector is queued for review, so the next person who asks gets
the answer from the brain. With lookup off, or when lookup finds nothing, `ask`
returns exactly what it returned before.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../diagrams/live-lookup-dark.png">
  <img src="../diagrams/live-lookup.png" alt="A chat makes one call, ask(question). The brain, the reviewed pages on main, is tried first; when it covers the question the matching sections are packed to the token budget and returned. When it does not, the server looks in three places, cheapest first: source text already committed, snapshots already fetched and waiting for review, and the connected MCP servers, where it searches and fetches at most 3 documents. The first hit is packed to the same budget, 2,500 tokens by default, and the answer in the chat is labelled reviewed or unreviewed. What was fetched from a connected MCP is queued for ingest, a person reviews and merges it, and the next ask is answered by the brain.">
</picture>

## Where the tokens go

Three costs disappear from the chat's context:

| Cost today | With live lookup |
|---|---|
| The tool definitions of every MCP server the chat has connected, sent with each request | The chat needs only the Almagest server |
| Search results from each provider, usually long JSON lists | Read by the server, never sent to the chat |
| Whole documents, fetched to find one paragraph | The server sends the matching passages, capped by the call's `max_tokens` (`mcp.ask.token_budget`, 2,500 by default) |

The fourth saving is over time. Each document a connector lookup used is queued
for ingest, so a question is answered from a connector once and from the
reviewed wiki after that.

No number is claimed here. "How to measure it" below says how to get one.

## What the chat gets back

`ask` keeps its shape. The context block gains a second kind of content, and
each kind says what it is. One answer carries one kind of lookup text: the
first step that finds a passage decides it.

| Kind | Where it comes from | How the chat must present it |
|---|---|---|
| Reviewed | A wiki page on `main` | As today: the page and its `[source: <id>, <locator>]` citation |
| Source passage | Text of a source the brain has ingested, where no page carries the claim yet | `From the source "<title>" (<id>), <locator>. Not yet on a reviewed page.` |
| Unreviewed | A document fetched from a connector, or one waiting for review | `From <connector>: "<title>", <locator>. Not reviewed.` |

The attribution lines come from the rule section "Answering from source and
unreviewed passages" in `agent/rules/read.md`. The server adds that section to
an answer only when the answer carries such passages, so a normal answer has no
extra rule text. A repo without the rule file gets an embedded copy.

Unreviewed passages never use the `[source: <id>, <locator>]` grammar. That
grammar is frozen and checked by the audit, and an `<id>` in it must be an
entry in a page's `sources`. A passage with no page behind it has no such
entry, so it gets a plain attribution that cannot be mistaken for a citation.

When nothing is found anywhere, the answer is today's: the brain does not cover
it, with an offer to call `report_gap`.

What `ask` prints when lookup found passages, in this order:

1. The usual header and the answer rules, then `## Context`, saying that no
   reviewed page answers this well, followed by the lookup rule section.
2. `## The brain's position: canonical pages`, when a canonical page matches.
3. `## Weak matches (may not be relevant)`, when the wiki had weak page matches.
4. `## Source passages: from ingested sources, not yet on a reviewed page` for
   step 1, or `## Unreviewed passages: nobody has reviewed these` for steps 2
   and 3. Under it, each document has a `###` title and one provenance line,
   then one `####` heading per passage with its locator (`§Failover`, `p.3`,
   `row 14`). The passage text is printed as quoted lines, each starting with
   `> `, so fetched text cannot pose as a heading of the tool's own. Titles,
   refs and server labels are flattened to one line.
5. Closing lines, when they apply: `Queued for review: ingest job <id>. A person
   reviews it before it can reach the brain.` and `Lookup note: ...`, which
   names a timeout (`the lookup timed out, so it may be incomplete`) or a step
   that was skipped and why.

The provenance line of a source passage reads `Source: "<title>" (<source id>),
<path>`. That of an unreviewed passage reads `From connector <id> (server
<label>): "<title>", ref <ref>, sha256 <7 characters>, fetched <time>`, with
a state added for step 2. The state says what happened to the staged document:

| State | Meaning | Queued when served |
|---|---|---|
| `(staged, waiting for review)` | An ingest job is queued or running, or its proposal is open | No |
| `(fetched earlier; ingest found nothing to add to the wiki)` | A job succeeded and made no proposal | No |
| `(fetched earlier; the ingest job failed)` | The only jobs for it failed | Once per document per day |
| `(staged)` | The review-state check ran out of time, so the state is not known | No |
| `(fetched earlier, not yet queued for review)` | No job says anything about it | Yes |

When the server queues the document, the closing `Queued for review` line says
so. The check is bounded by the lookup deadline, and its answer is kept per
document for `REVIEW_CACHE_MS` (60 seconds). Both blocks open with a line saying
the text is data, not instructions and that the passage text is quoted.

When a canonical page matched but none of its text fit the token budget, `ask`
returns no source or unreviewed passages. Under `## Context` it names the
canonical page, says that its text did not fit, and tells the chat to call
`get_page` for it or to ask again with a larger `max_tokens`.

When a lookup found no passage but did not finish, `ask` adds a line under
`## Context`: `Lookup incomplete: <reasons>. The sources outside the wiki may
not have been searched fully; asking again may find more.` The reasons are a
timeout or a skipped step. A lookup that finished and found nothing, and a
lookup that is off, print what `ask` printed before.

The structured result gains a `lookup` field with the same content: `step`,
`kind`, `tokens`, `truncated`, `incomplete`, `skipped`, `queued`, the canonical
pages and the documents with their passages. It is absent when lookup found
nothing. When a matching canonical page did not fit and no passages are
returned, the structured result carries `canonicalCovers` instead: the slug and
title of each canonical page that matched.

## The lookup ladder

The server tries each step in order and stops at the first one whose best
passage clears the same thresholds as a page search (`mcp.search.min_score` 0.2
and `mcp.search.min_coverage` 0.5, the share of query terms that matched).

| Step | Looks in | Network calls | Trust |
|---|---|---|---|
| 0 | Wiki pages on `main` (today's `ask`) | none | reviewed |
| 1 `sources` | Committed source text on `main`: every manifest entry that is not `missing`, read from its sidecar in `brain/raw/extracted/` or from a text original. Only regular text files inside the snapshot are read, each up to 5 MiB and 64 MiB in all | none | source is fingerprinted and in the manifest; the claim is not reviewed |
| 2 `staged` | Snapshots in `.almagest/connector-snapshots/<connector>/` of connectors with `lookup: true`, whose bytes are not yet in `main`'s manifest and whose proposal was not rejected | none | unreviewed |
| 3 `connectors` | Connected MCP servers with `lookup: true` and a recipe `search` block | one search, then up to `max_fetch` fetches | unreviewed |

Steps 1 and 2 cost no provider call and send nothing off the machine. They
share all the machinery step 3 needs (passage ranking, packing, labels).

Which steps run for whom:

- Step 1 runs for every caller, including a viewer. Its text is already on
  `main`.
- Steps 2 and 3 need a caller at or above `mcp.lookup.min_role`. Below it, the
  caller gets today's answer.
- With `anonymization.enabled: true` in `brain.config.yaml`, steps 2 and 3 are
  off for everyone, and the service logs why once at start. Step 1 then serves
  only the sidecars the ingest agent wrote. It skips committed connector
  snapshots, which are stored as fetched, and committed text originals, which
  nothing has anonymized.
- Step 3 is off over stdio (`almagest mcp`) and with `send_query: false`.
  Step 2 still runs over stdio.
- `mcp.lookup.steps` lists the steps that may run. Remove one to turn it off.

Step 1 covers a common case: a source was ingested, the page summarises it, and
the detail someone now asks for is in the source but was never written into a
page.

## Design decisions

### Finding candidates without a model on the server

The server does not call a language model today, and this design keeps it that
way. The query sent to a provider is built mechanically:

- `ask` gets one optional input, `keywords` (up to 12 strings of up to 64
  characters). The chat already is a language model, and a handful of keywords
  costs it a few tokens. It can translate, add synonyms and drop filler. The
  server uses them only when the wiki does not answer.
- When `keywords` is absent, the server splits the question into words and
  keeps those that survive the stopword filter of `tokenize` in
  `server/src/mcp/search.mjs`. It splits at spaces, so a question in a language
  written without spaces (Chinese, Japanese, Thai) works only when the chat
  supplies `keywords`.
- Before a term reaches a provider, `ctx.connectors.search` sanitises it. It
  keeps letters and digits in any script, spaces, hyphens, underscores and dots,
  and drops everything else, so a term cannot close a quote or add an operator
  in a provider's query syntax. A word that starts with `-` or `.` loses that
  prefix, and a word with no letter or digit is dropped. At most 8 terms, 64
  characters each and 200 characters in all go out. With no term left, the
  provider is not called.

### A `search` block in recipes

A recipe has `list` and `fetch`. Lookup adds an optional third block, `search`,
with the same shape as `list` (without `static`) plus two template variables,
`{{query}}` (the sanitised terms joined by a space) and `{{terms}}` (the list).
Only the first page of results is read, at most `limit` items (10 by default,
50 at most). The connector's `list.where` filters the results, so lookup stays
inside its scope, unless the `search` block has a `where` of its own. A
connector can also carry an inline `search:` that merges over the
recipe's, as it can for `list` and `fetch`.

```yaml
# server/src/connectors/recipes/google-drive.yaml (not verified)
search:
  tool: search_files
  args:
    query: "({{select.query | default:owner = 'me'}}) and fullText contains '{{query}}'"
    pageSize: 10
    excludeContentSnippets: true
  items: "files[*] | results[*] | items[*] | $[*]"
  ref: "id | fileId"
  version: "modifiedTime | modified_time | updatedAt"
  title: "title | name"
  mime: "mimeType | mime_type"
```

Inside a `search` block, `select.*` holds the connector's `lookup_select` when
it is set, and its `select` otherwise. A connector whose recipe has no `search`
block takes part in steps 1 and 2 only.

One recipe ships a `search` block, `google-drive`. It is not verified against
the real server. The block reuses the tool the recipe lists with, and the
`fullText contains` syntax is an assumption. Check a block with `almagest
connectors search <id> <words>`, which prints the candidates and fetches
nothing.

The `notion` recipe has no `search` block. `notion-search` would reach every
page the service's Notion token can see, and neither its arguments nor the
fields of its results are verified, so there is no way to hold it to `select`.
The recipe header says to add an inline `search:` block with a scoping `where`
once you have checked the tool against your workspace.

`ctx.connectors.search` and `fetchOne` hand back one-line strings: control
characters and line breaks become spaces, zero-width and bidirectional control
characters are removed, a title is cut at 200 characters, and a leading `#`,
`>` or `=` is escaped, so a title cannot carry a heading into an answer. A ref that flattening would change is not offered, because `fetchOne`
needs it unchanged. The snapshot bytes and fingerprints are not affected: the
snapshot header still uses the title as the provider gave it.

### Fetching is the sync's fetch

A looked-up document goes through exactly what a synced one does: `fetchItem`,
then `buildSnapshot`. That gives it the snapshot header, neutralised marker
lines, the `max_bytes` cap and a sha256, and stages it under
`.almagest/connector-snapshots/`. The `version` check that lets a sync skip an
unchanged item also lets a lookup skip a second fetch of the same document.

The fetch-and-stage part of `syncDetailed` in
`server/src/connectors/index.mjs` is one function, `stageItem`, that the sync
and `ctx.connectors.fetchOne` both call. `fetchOne` returns the text, its
sha256 and a SourceRef with `via: 'lookup'` and a `change` computed against
`main`'s manifest (`new`, `changed`, `reappeared` or `unchanged`). Because the
snapshot is staged, a later question can find it at step 2 while its proposal is
open.

### Passages, ranked and packed

A snapshot already carries locator markers (`=== page 3 ===`,
`=== section: Failover ===`). `server/src/mcp/passages.mjs` splits on them and
cuts any block longer than 1,500 characters into parts, at paragraph, line or
character boundaries. A line shaped like a marker but neutralised with a leading
backslash stays text, so fetched content cannot forge a locator.

Each passage is scored against the query terms with the same BM25 weighting as
page search (`k1` and `b` from `search.mjs`). The document title counts three
times, a section heading one and a half times and the body once. Passages below
the thresholds above do not answer. The packer is greedy by score. It counts
each passage's text plus 12 tokens for its label. A passage that does not fit is
cut to the room left when at least 200 characters remain, and ends in `[…]`;
otherwise it is skipped. The `> ` that `ask` prints in front of every line counts
toward the budget (the `linePrefix` option of `packPassages`), so a passage of
many short lines is cut further. Two limits keep marginal text out. After the best
passage, one is packed only when its score is at least `PACK_MIN_SHARE` (0.35)
of the best score, and passages come from at most `PACK_MAX_DOCS` (4)
documents. Both constants are in `server/src/mcp/passages.mjs`. Each passage
keeps its marker, so the attribution names a page or section.

The step 1 index is built from the committed text when `main` moves. The step 2
index is rebuilt when the set of staged files or their bytes change. The step 3
index holds only the documents fetched for that question.

### Enrichment

Every document fetched in step 3 that contributed a passage to the answer and
whose `change` is not `unchanged` is queued. So is a step 2 document that
contributed a passage and has no ingest job and no open proposal is queued too,
as is one whose only jobs failed, once per document per day (the
`lookup-ingest-retry` store namespace, key the UTC day). Both go through this
call:

```js
ctx.ingest.enqueue({
  kind: 'ingest',
  trigger: 'lookup',                       // the job trigger added for this
  source: ref,                             // the SourceRef fetchOne returned
  requestedBy: 'svc:lookup',
  onBehalfOf: '<human id>',
  instructions: 'Fetched by live lookup to answer a question asked in a chat.',
  lookupQuestion: '<question>',            // only when telemetry.store_queries is plain
});
```

The `instructions` are always that fixed sentence. The ingest agent follows its
instructions, and a chat wrote the question, so the question is never part of
them. Under `telemetry.store_queries: plain` the job carries it in its own
`lookupQuestion` field, cut at 500 characters, which only the proposal page
shows. The ingest prompt never includes it. With `hashed` or `none` the question
is not written down. Source passages are not queued, because the source is
already ingested.

Queueing never holds an answer past `timeout_ms`. If it runs long, the answer is
sent and the job is still queued in the background. The answer says so, unless
it already says the lookup is incomplete.

The job follows the normal path: agent job on an `ingest/` branch, audit,
proposal, a person approves, merge. Nothing about review changes. `lookup` is
one of the automatic triggers, so it shares their dedup: bytes whose proposal is
still under review, or that a run found unchanged, do not start a second job.
`ctx.ingest.enqueue` marks such a returned job with `deduplicated: true`.
`mcp.lookup.ingest: off` queues nothing.

A sync that lists a connector completely treats any manifest entry it did not
list as `missing`. A document found by lookup can sit outside the connector's
`select` scope, so `fetchOne` records it in the `connector-lookup` store
namespace (key `<connector id>:<ref>`, value `{ at, title, failures,
checkedAt }`). The rule for the mark: a lookup fetch leaves a mark unless the
sync is already responsible for the document. The sync is responsible in two
cases. Its own listing wrote the item record and `main` has no entry yet, so the
next listing will include it. Or `main` has an entry and the store holds no item
record at all. A record that only lookups wrote never counts, and neither does a
sync record once `main` has the entry: the document may have left `select`
since, and it has just been fetched, so it exists. The `connector-item` record
carries an optional `via` field for this. It is `lookup` when only lookup has
fetched the document, and absent when a sync listing wrote the record, as it is
on records from before the field. A lookup fetch keeps the owner a sync record
already has.

The sync's missing check skips a marked entry and fetches it again by ref, with
the title the search gave, so a changed document comes back as a `changed`
SourceRef. Without the mark the same entry is reported missing. A mark on a
document the sync does list costs nothing, because a complete listing that
includes it clears the mark.

The snapshot header carries the raw title, and flattening can change it. The
`connector-lookup-title` store namespace holds the raw title of a search hit
until the document is fetched, so a lookup fetch after a restart produces the
same fingerprint a sync does. `fetchOne` removes the entry once it has fetched.

- A complete listing that includes a marked ref clears the mark, because the
  sync tracks that document now.
- Re-checks go oldest first, by `checkedAt`, so a cap smaller than the number of
  marks still reaches every one over time.
- A fetch that fails is reported in `errors` and adds one to `failures`. At
  `LOOKUP_MAX_FAILURES` (3) failed re-checks in a row, the ref is reported as
  missing and its mark is removed.
- One consequence: a document that lookup fetched and that is then deleted
  upstream before the next complete sync is reported missing after three
  syncs. A document only a sync has seen is reported after one.

Re-checking applies to a complete listing only, is capped by the connector's
`max_items`, and needs a recipe whose `fetch` makes a tool or method call. The
design had this as a `via: lookup` marker in the manifest. The manifest is
untouched.

### Telemetry and gaps

A looked-up answer is still a miss for the brain: the event keeps
`answered: false`, so the gap stays open until a reviewed page answers it. The
`ask` tool hands the event a `lookup` summary whenever lookup ran, even when it
found nothing. It holds `step` (`sources`, `staged`, `connectors` or `null`),
`steps` (the steps tried), `connectorsAsked`, `connectors` (the ids of the
connectors asked), `fetched`, `cacheHits`, `latencyMs`, `incomplete`, `skipped`
(the names of the steps that were skipped) and `queued` (ingest job ids). It
carries counts and ids only: no passage text and no document titles. The gap list shows when lookup served
a gap and whether an ingest job is queued, and a proposal queued by lookup says
so.

## How lookup meets the brain's rules

Lookup brings text into an answer that no person has reviewed. The brain's
existing rules (tiers, canonical pages, contradictions, anonymization) apply to
it at two moments: when the answer is given, and when the fetched document is
ingested.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../diagrams/lookup-guardrails-dark.png">
  <img src="../diagrams/lookup-guardrails.png" alt="Two moments. When answering: an unreviewed passage found by lookup goes through a canonical check, where matching canonical pages go first and their statement is the brain's answer; the answer in the chat reports any disagreement with both sides attributed. When ingesting: the fetched document is queued as an ingest job on an ingest/ branch, and what it says decides the outcome. New facts become an evidence page in the proposal. A contradiction with a canonical page is never written to the wiki; a challenge is logged and the audit reports CANON-001. A contradiction with a reviewed page has both claims quoted and nothing is overwritten. In all three cases you decide: approve, log the challenge or dismiss.">
</picture>

### When the answer is given

The server has no language model, so it cannot tell whether a fetched passage
contradicts a page. What it can do is put the reviewed text next to the
unreviewed text and tell the chat which one wins.

**Canonical pages go first.** After lookup finds a passage, the server runs one
more local search over canonical pages only, using the question and the query
terms, at a lower threshold than a normal answer: a score of at least 0.1 and a
term coverage of at least 0.25, against 0.2 and 0.5. Up to 3 canonical pages
are packed. The whole `ask` context fits the call's token budget, which
`LOOKUP_BUDGET_SPLIT` in `server/src/mcp/config.mjs` divides: canonical sections
may use up to 25%, weak page matches up to 15%, and the passages get the rest,
at least 60%. The canonical share never falls below `CANONICAL_MIN_TOKENS` (64),
so a matching canonical page is always shown, at least as a truncated section.
Any canonical page that matches is placed above the passages and marked
as the brain's position, under the heading `The brain's position: canonical
pages`. The answer rules then say: state the canonical position as the
answer, and if an unreviewed passage disagrees, report that as a disagreement
with both sides attributed. The unreviewed passage never replaces it.

`brain.search` takes a `tier` filter, so this is one extra call on an index that
is in memory. The pass runs only when lookup found a passage.

Unreviewed text is never shown without the canonical text that outranks it. If
a canonical page matched and none of its text could be packed, `ask` returns no
source or unreviewed passages. It names the canonical page and tells the chat to
call `get_page` or to raise `max_tokens`.

**Reviewed text outranks unreviewed text.** `ask` already returns weak matches
from curated and evidence pages under "Weak matches (may not be relevant)".
Those stay, above anything lookup found, except that a page already shown as
canonical is not repeated there. A result lists them in this order:

| Order | Kind | Standing |
|---|---|---|
| 1 | Canonical page | The brain's position. Cannot be overridden by anything below |
| 2 | Curated page | Reviewed |
| 3 | Evidence page | Reviewed; evidence pages may disagree with each other |
| 4 | Source passage (step 1) | From an ingested source, not yet a reviewed claim |
| 5 | Unreviewed passage (steps 2 and 3) | Nobody has checked it |

**A disagreement is surfaced, never settled by the chat.** This is
non-negotiable 3 applied to answers: quote both, name both sources, and do not
pick the newer one because it is newer.

**Anonymization.** With `anonymization.enabled: true` in `brain.config.yaml`,
steps 2 and 3 are off. Staged snapshots and freshly fetched documents are raw
text, and the server cannot remove personal names mechanically. Step 1 stays
available for sidecars the ingest agent wrote, because the ingest rules
anonymize what the agent writes. Committed connector snapshots are skipped, and
so are committed text originals, because nothing has removed names from them
(`mayServe` in `server/src/mcp/lookup.mjs`). The switch is read from the instance config, and the service logs one line saying
why the steps are off.

**A rejected source is not served again.** When a reviewer rejects the proposal
of a connector document, the service remembers that document's sha256 in the
`lookup-rejected` store namespace, filled from the `proposal.rejected` event.
Steps 2 and 3 skip it until its content changes. A person has said no to it,
and lookup should not keep presenting it.

### When the fetched document is ingested

The ingest job that lookup queues is an ordinary one, so `agent/rules/ingest.md`
and `agent/rules/wiki.md` apply unchanged. Nothing in this design adds a
shortcut.

| What the document says | What happens | Rule |
|---|---|---|
| New facts | An evidence page on the `ingest/` branch, shown in the proposal for a person to approve | Evidence tier |
| Something that contradicts a canonical page | Not written to the wiki. The reviewer gets a `canonical_conflict` decision with two options, log the challenge or dismiss it. A logged challenge is a row in `brain/canonical-challenges.md`, and the audit reports `CANON-001` until a person resolves it | Non-negotiable 4 |
| Something that contradicts a curated or evidence page | Both claims are quoted with their sources and shown to the reviewer. Nothing is overwritten | Non-negotiable 3 |
| Enough for a curated page, but only at `confidence: low` | Blocked. It can be proposed as evidence instead | Curated tier |
| Personal names, with anonymization on | The job stops and waits for approval of the replacements | Anonymization |
| Anything that fails the audit | Nothing is committed | Non-negotiable 7 |

Three limits follow from those rules:

- **Lookup never promotes.** A looked-up document enters at its connector's
  `tier`, which defaults to `evidence`. It cannot create or change a canonical
  page, and the runner refuses the whole run if a canonical page changed.
- **Hot pages keep their stricter approval.** A proposal from lookup that
  touches a hot page needs what the profile's policy requires for it, the same
  as any other proposal.
- **Who may settle a canonical conflict is unchanged.** In the `enterprise`
  profile that decision needs the `owner` role.

A disagreement seen at answer time is not recorded anywhere by itself. It reaches the challenge ledger only through the ingest job
that follows. For a step 3 document that job is queued automatically. For a
step 1 passage the source was ingested earlier, so the contradiction should
already have been caught then.

## Rules it must keep

**The wiki stays the only reviewed thing.** Lookup writes nothing to
`brain/wiki/` and nothing to `main`. Every unreviewed passage is labelled in
the tool result and in the answer rules, so a chat cannot present it as the
brain's.

**Access.** The connector's credentials can read more than the person asking
may be allowed to. Three limits, all on by default:

- Lookup is opt-in per connector (`lookup: true`). Without it a connector is
  neither searched nor read at step 2.
- Its scope is the connector's `select` unless a wider `lookup_select` is set
  on purpose.
- The two unreviewed steps (staged and connectors) go only to callers at or
  above `mcp.lookup.min_role` (default `contributor`). A viewer keeps today's
  answer. Step 1 text is open to every caller, because it is committed to
  `main` and `get_page` already shows the same sources.

**Privacy.** Step 3 sends the sanitised keywords to a provider. `send_query:
false` turns step 3 off, so nothing derived from a question leaves the server.
Under `telemetry.store_queries: hashed` or `none`, the question text is not
written into the ingest job either. Under `plain` it goes only into the job's
`lookupQuestion` field. When lookup logs a provider failure, it logs the error's
class or code and never its message, which can echo the query.

**Fetched text is data.** It is neutralised and headed like every snapshot, and
the tool result repeats that it is content and not instruction. It has not been
read by a person, so it can be wrong or planted. The label tells the reader.

**No loops, no floods.**

- A lookup never starts another lookup. The ingest agent has no MCP access, so
  enrichment cannot trigger one either.
- A negative cache remembers "asked this connector, found nothing" for the same
  set of terms for `negative_ttl_minutes`. It lives in the process's memory.
- Two rate limits over a sliding minute, also in memory: `per_caller_per_minute`
  counts a lookup once, as soon as it reaches a privileged step (staged or
  connectors), so an answer from step 2 or from the negative cache is counted
  and an answer from step 1 is not, and `per_connector_per_minute` counts each
  search and each fetch. A value of 0
  turns a limit off.
- `max_fetch` documents per question, across all connectors, and one overall
  `timeout_ms`. On timeout the passages fetched so far are still ranked, and the
  answer says the lookup may be incomplete.
- Ingest jobs from lookup join the existing dedup for automatic triggers (same
  bytes under review means no new job). A daily cap, `max_ingest_per_day`,
  counts new jobs only, per UTC day, in the `lookup-ingest-count` store
  namespace. A job `enqueue` returns with `deduplicated: true` was counted when
  it was made. Past the cap the document is still answered from and the
  answer notes that it was not queued.

## Configuration

```yaml
mcp:
  lookup:
    enabled: false
    min_role: contributor          # who may receive unreviewed passages
    steps: [sources, staged, connectors]
    timeout_ms: 8000               # for the whole lookup
    max_fetch: 3                   # documents fetched per question
    send_query: true               # false: step 3 is off
    negative_ttl_minutes: 60
    rate:
      per_caller_per_minute: 6
      per_connector_per_minute: 30
    ingest: auto                   # auto | off
    max_ingest_per_day: 20

sources:
  connectors:
    - id: team-drive
      mcp: google-drive
      recipe: google-drive
      schedule: "@daily"
      lookup: true                 # this connector may be searched on a miss
      # lookup_select:             # optional, wider than `select`
      #   query: "'0AbC…' in parents"
```

`steps` takes `sources`, `staged` and `connectors`. `min_role` is one of
`viewer`, `contributor`, `reviewer`, `owner`, `admin`. With a value that is none
of these, the two unreviewed steps are off and the service logs a warning. The
token budget is the call's `max_tokens`, `mcp.ask.token_budget` by default.
Lookup has no budget of its own: canonical sections, weak page matches and
passages share it as described under "When the answer is given". Every key is listed with its default in
[mcp.md](mcp.md#configuration).

## Where the code is

| File | What it holds |
|---|---|
| `server/src/mcp/lookup.mjs` | The ladder, the role and transport gates, the negative cache, rate limits and deadline, the canonical pass, enrichment and the rejected-source list |
| `server/src/mcp/passages.mjs` | Splitting on locator markers, passage scoring and packing |
| `server/src/mcp/tools.mjs` | `ask`: the `keywords` input, the call to lookup on a miss, the labelled blocks and the telemetry summary |
| `server/src/mcp/config.mjs` | The `lookup` defaults (`MCP_DEFAULTS`) and `LOOKUP_BUDGET_SPLIT` |
| `server/src/mcp/rules.mjs`, `agent/rules/read.md` | `lookupRules` and the section "Answering from source and unreviewed passages" |
| `server/src/connectors/index.mjs` | `search`, `fetchOne`, `stageItem`, `sanitiseTerms`, the `connector-lookup` and `connector-lookup-title` namespaces, the missing check and the `connectors search` command |
| `server/src/connectors/render.mjs` | `flattenField`, the one-line form of provider strings |
| `server/src/connectors/execute.mjs`, `recipes.mjs` | `searchItems`; validation of the `search` block |
| `server/src/connectors/recipes/google-drive.yaml` | The one shipped `search` block (`notion.yaml` has none) |
| `server/src/core/schemas.mjs`, `server/src/ingest/queue.mjs` | The `lookup` job trigger and its dedup |
| `server/test/mcp/lookup.test.mjs`, `server/test/connectors/lookup.test.mjs` | The intended behaviour, against an in-memory MCP server |

## What is built and what is not

Built: the passage ranking and labels, steps 1 to 3 with the canonical pass,
the role, anonymization, `send_query` and stdio gates, the timeout, negative
cache and rate limits, the `search` block and `connectors search`, `fetchOne`,
enrichment through the `lookup` trigger with its dedup, daily cap and rejected
list, and the `lookup` summary on telemetry events. The gap list and the
proposal page show where lookup was involved.

Not built:

- A live check of the Drive `search` block, and `search` blocks for the other
  shipped recipes. Only the in-memory test server has run it.
- The three benchmark arms in [How to measure it](#how-to-measure-it), and so
  no measured token saving.
- A default of lookup on for the `solo` profile.
- Lookup on a weak or stale answer, and a title catalog (see
  [Open decisions](#open-decisions)).

## How to measure it

`benchmarks/lookup-context.mjs` measures context size with and without lookup on
the fixture corpus, with no model calls and no cost. For each fixture question
that has expected sources it compares the tokens in the whole source documents
with the tokens `ask` would pack as passages, and checks mechanically that the
expected literals are in the packed text. It measures context size only, on a
small fictional corpus with a characters-per-four estimate. It does not
measure answer quality, dollars, or the full lookup path. Its method and limits
are in [benchmarks/README.md](../../benchmarks/README.md#live-lookup-context-size).

The model-run measurement has not been done. The benchmark harness in
`benchmarks/` already records cost and latency per arm. Add three arms over the same questions and the same connector fixture:

| Arm | Setup |
|---|---|
| Direct | The chat has the provider's MCP server connected and no brain |
| Brain only | The chat has Almagest, lookup off |
| Brain with lookup | The chat has Almagest, lookup on |

Report input tokens per answered question, share of questions answered, and
cost. Run it twice: once cold, and once after the proposals from the first run
are merged, to show the second-ask saving.

## Open decisions

1. **Who gets unreviewed passages by default.** The default is `contributor`
   and above. On a solo brain the owner is the only user, so the `solo` profile
   could turn lookup on by default.
2. **Partial answers.** Lookup runs when the brain has no answer. Whether it
   should also run when the brain answers weakly, or when the page is stale, is
   left out here.
3. **A title catalog.** Listing titles over a wide scope without fetching
   content would let the server find a document with no provider search and no
   keywords leaving the machine. It is a further step between 2 and 3, and it
   raises its own question: a title alone can reveal that a document exists.

Settled since the design: stdio. `almagest mcp` runs without the background
service, so step 3 is off there and steps 1 and 2 work. Step 3 opens provider
connections only under `almagest serve`.
