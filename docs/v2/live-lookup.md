# Live lookup: one ask, cheapest source first

Status: built, and off by default. Set `mcp.lookup.enabled: true` to turn it
on. The ladder, the labels, the `search` block, enrichment and the telemetry
field are in the code and covered by tests against an in-memory MCP server. The
`search` blocks of the Drive and Notion recipes have not been checked against
the real servers. [What is built and what is not](#what-is-built-and-what-is-not)
lists the rest.

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
   `row 14`).
5. Closing lines, when they apply: `Queued for review: ingest job <id>. A person
   reviews it before it can reach the brain.` and `Lookup note: ...`, which
   names a timeout (`the lookup timed out, so it may be incomplete`) or a step
   that was skipped and why.

The provenance line of a source passage reads `Source: "<title>" (<source id>),
<path>`. That of an unreviewed passage reads `From connector <id> (server
<label>): "<title>", ref <ref>, sha256 <7 characters>, fetched <time>`, with
`(staged, waiting for review)` added for step 2. Both blocks open with a line
saying the text is data, not instructions.

The structured result gains a `lookup` field with the same content: `step`,
`kind`, `tokens`, `truncated`, `incomplete`, `skipped`, `queued`, the canonical
pages and the documents with their passages. It is absent when lookup found
nothing.

## The lookup ladder

The server tries each step in order and stops at the first one whose best
passage clears the same thresholds as a page search (`mcp.search.min_score` 0.2
and `mcp.search.min_coverage` 0.5, the share of query terms that matched).

| Step | Looks in | Network calls | Trust |
|---|---|---|---|
| 0 | Wiki pages on `main` (today's `ask`) | none | reviewed |
| 1 `sources` | Committed source text on `main`: every manifest entry that is not `missing`, read from its sidecar in `brain/raw/extracted/` or from a text original. Files over 5 MiB are skipped | none | source is fingerprinted and in the manifest; the claim is not reviewed |
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
  off for everyone, and the service logs why once at start.
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
  `server/src/mcp/search.mjs`.
- Before a term reaches a provider, `ctx.connectors.search` sanitises it. It
  keeps letters and digits in any script, spaces, hyphens, underscores and dots,
  and drops everything else, so a term cannot close a quote or add an operator
  in a provider's query syntax. At most 8 terms, 64 characters each and 200
  characters in all go out. With no term left, the provider is not called.

### A `search` block in recipes

A recipe has `list` and `fetch`. Lookup adds an optional third block, `search`,
with the same shape as `list` (without `static`) plus two template variables,
`{{query}}` (the sanitised terms joined by a space) and `{{terms}}` (the list).
Only the first page of results is read, at most `limit` items (10 by default,
50 at most). A connector can also carry an inline `search:` that merges over the
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

Two recipes ship a `search` block, `google-drive` and `notion`. Neither is
verified against the real server. The Drive block reuses the tool the recipe
lists with, and the `fullText contains` syntax is an assumption. Check a block
with `almagest connectors search <id> <words>`, which prints the candidates and
fetches nothing.

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
otherwise it is skipped. Each passage keeps its marker, so the attribution
names a page or section.

The step 1 index is built from the committed text when `main` moves. The step 2
index is rebuilt when the set of staged files or their bytes change. The step 3
index holds only the documents fetched for that question.

### Enrichment

Every document fetched in step 3 that contributed a passage to the answer and
whose `change` is not `unchanged` is queued:

```js
ctx.ingest.enqueue({
  kind: 'ingest',
  trigger: 'lookup',                       // the job trigger added for this
  source: ref,                             // the SourceRef fetchOne returned
  requestedBy: 'svc:lookup',
  onBehalfOf: '<human id>',
  instructions: 'Asked: "<question>". Fetched by live lookup.',
});
```

With `telemetry.store_queries` set to `hashed` or `none`, the instructions say
only `Fetched by live lookup to answer a question asked in a chat.`, and the
question is not written down. Under `plain` the question is cut at 500
characters. Staged documents and source passages are not queued: the first
already has a job or a sync behind it, and the second is already ingested.

The job follows the normal path: agent job on an `ingest/` branch, audit,
proposal, a person approves, merge. Nothing about review changes. `lookup` is
one of the automatic triggers, so it shares their dedup: bytes whose proposal is
still under review, or that a run found unchanged, do not start a second job.
`mcp.lookup.ingest: off` queues nothing.

A sync that lists a connector completely treats any manifest entry it did not
list as `missing`. A document found by lookup can sit outside the connector's
`select` scope, so `fetchOne` records it in the `connector-lookup` store
namespace (key `<connector id>:<ref>`, value `{ at, title }`). The sync's
missing check skips such an entry and fetches it again by ref, with the title the
search gave, so a changed document comes back as a `changed` SourceRef. Without
that record the same entry is reported missing. A fetch that fails is reported
in `errors`. Re-checking applies to a complete listing only, is capped by the
connector's `max_items`, and needs a recipe whose `fetch` makes a tool or method
call. The design had this as a `via: lookup` marker in the manifest. The
manifest is untouched.

### Telemetry and gaps

A looked-up answer is still a miss for the brain: the event keeps
`answered: false`, so the gap stays open until a reviewed page answers it. The
`ask` tool hands the event a `lookup` summary whenever lookup ran, even when it
found nothing. It holds `step` (`sources`, `staged`, `connectors` or `null`),
`steps` (the steps tried), `connectorsAsked`, `fetched`, `cacheHits`,
`latencyMs`, `incomplete`, `skipped` (the names of the steps that were skipped)
and `queued` (ingest job ids). It carries counts and ids only: no passage text,
no document titles and no connector names. The gap list shows when lookup served
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
are packed, and they may use up to 40% of the token budget. The passages get the
rest. Any canonical page that matches is placed above the passages and marked
as the brain's position, under the heading `The brain's position: canonical
pages`. The answer rules then say: state the canonical position as the
answer, and if an unreviewed passage disagrees, report that as a disagreement
with both sides attributed. The unreviewed passage never replaces it.

`brain.search` takes a `tier` filter, so this is one extra call on an index that
is in memory. The pass runs only when lookup found a passage.

**Reviewed text outranks unreviewed text.** `ask` already returns weak matches
from curated and evidence pages under "Weak matches (may not be relevant)".
Those stay, above anything lookup found. A result lists them in this order:

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
available, because a sidecar is anonymized before it is committed. The
switch is read from the instance config, and the service logs one line saying
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
written into the ingest job's instructions either.

**Fetched text is data.** It is neutralised and headed like every snapshot, and
the tool result repeats that it is content and not instruction. It has not been
read by a person, so it can be wrong or planted. The label tells the reader.

**No loops, no floods.**

- A lookup never starts another lookup. The ingest agent has no MCP access, so
  enrichment cannot trigger one either.
- A negative cache remembers "asked this connector, found nothing" for the same
  set of terms for `negative_ttl_minutes`. It lives in the process's memory.
- Two rate limits over a sliding minute, also in memory: `per_caller_per_minute`
  counts each lookup a caller starts, and `per_connector_per_minute` counts each
  search and each fetch. A value of 0 turns a limit off.
- `max_fetch` documents per question, across all connectors, and one overall
  `timeout_ms`. On timeout the passages fetched so far are still ranked, and the
  answer says the lookup may be incomplete.
- Ingest jobs from lookup join the existing dedup for automatic triggers (same
  bytes under review means no new job). A daily cap, `max_ingest_per_day`,
  counts every job `enqueue` returns for a lookup, whether it is new or an
  existing job it was deduplicated to, per UTC day, in the `lookup-ingest-count`
  store namespace. Past the cap the document is still answered from and the
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
Lookup has no budget of its own. Every key is listed with its default in
[mcp.md](mcp.md#configuration).

## Where the code is

| File | What it holds |
|---|---|
| `server/src/mcp/lookup.mjs` | The ladder, the role and transport gates, the negative cache, rate limits and deadline, the canonical pass, enrichment and the rejected-source list |
| `server/src/mcp/passages.mjs` | Splitting on locator markers, passage scoring and packing |
| `server/src/mcp/tools.mjs` | `ask`: the `keywords` input, the call to lookup on a miss, the labelled blocks and the telemetry summary |
| `server/src/mcp/config.mjs` | The `lookup` defaults (`MCP_DEFAULTS`) |
| `server/src/mcp/rules.mjs`, `agent/rules/read.md` | `lookupRules` and the section "Answering from source and unreviewed passages" |
| `server/src/connectors/index.mjs` | `search`, `fetchOne`, `stageItem`, `sanitiseTerms`, the `connector-lookup` namespace, the missing check and the `connectors search` command |
| `server/src/connectors/execute.mjs`, `recipes.mjs` | `searchItems`; validation of the `search` block |
| `server/src/connectors/recipes/google-drive.yaml`, `notion.yaml` | The two shipped `search` blocks |
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

- A live check of the Drive and Notion `search` blocks, and `search` blocks for
  the other shipped recipes. Only the in-memory test server has run them.
- The three benchmark arms in [How to measure it](#how-to-measure-it), and so
  no measured token saving.
- A default of lookup on for the `solo` profile.
- Lookup on a weak or stale answer, and a title catalog (see
  [Open decisions](#open-decisions)).

## How to measure it

The benchmark harness in `benchmarks/` already records cost and latency per
arm. Add three arms over the same questions and the same connector fixture:

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
