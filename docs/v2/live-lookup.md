# Live lookup: one ask, cheapest source first

Status: design. Nothing in this document is built yet. It describes what to
build, where it goes in the code, and in what order. File and function names
are the ones on `main` at the time of writing.

## The idea

Today a chat that asks the brain a question it cannot answer gets "not
covered", and the person or the chat then goes looking in Drive, Notion or
Linear by hand. That is the expensive path: the chat needs every one of those
MCP servers connected, reads their search results, and pulls whole documents
into its context.

With live lookup the chat still makes one call, `ask`. When no reviewed page
answers, the Almagest server does the looking itself, through the connectors it
already has. It returns only the passages that match, inside the same token
budget as a normal answer, marked as unreviewed. What it fetched is queued for
review, so the next person who asks gets the answer from the brain.

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
| Whole documents, fetched to find one paragraph | The server sends the matching passages, capped by `mcp.ask.token_budget` (2,500 by default) |

The fourth saving is over time. Each lookup that finds something queues it for
ingest, so a question is answered from a connector once and from the reviewed
wiki after that.

No number is claimed here. "How to measure it" below says how to get one.

## What the chat gets back

`ask` keeps its shape. The context block gains a second kind of content, and
each kind says what it is:

| Kind | Where it comes from | How the chat must present it |
|---|---|---|
| Reviewed | A wiki page on `main` | As today: the page and its `[source: <id>, <locator>]` citation |
| Source passage | Text of a source the brain has ingested, where no page carries the claim yet | "From the source *title*, *locator*. Not yet on a reviewed page." |
| Unreviewed | A document fetched from a connector, or one waiting for review | "From *connector*: *title*, *locator*. Not reviewed." |

Unreviewed passages never use the `[source: <id>, <locator>]` grammar. That
grammar is frozen and checked by the audit, and an `<id>` in it must be an
entry in a page's `sources`. A passage with no page behind it has no such
entry, so it gets a plain attribution that cannot be mistaken for a citation.

When nothing is found anywhere, the answer is today's: the brain does not cover
it, with an offer to call `report_gap`.

## The lookup ladder

The server tries each step in order and stops at the first one that returns a
passage above the relevance threshold.

| Step | Looks in | Network calls | Trust |
|---|---|---|---|
| 0 | Wiki pages on `main` (today's `ask`) | none | reviewed |
| 1 | Committed source text on `main`: `brain/raw/extracted/` and text originals | none | source is fingerprinted and in the manifest; the claim is not reviewed |
| 2 | Staged snapshots in `.almagest/connector-snapshots/` whose proposal is not merged | none | unreviewed |
| 3 | Connected MCP servers, through the connector's recipe | one search, then up to `max_fetch` fetches | unreviewed |

Steps 1 and 2 cost no provider call and send nothing off the machine. They
also share all the machinery step 3 needs (passage ranking, packing, labels),
which is why they are built first.

Step 1 covers a common case: a source was ingested, the page summarises it, and
the detail someone now asks for is in the source but was never written into a
page.

## Design decisions

### Finding candidates without a model on the server

The server does not call a language model today, and this design keeps it that
way. The query sent to a provider is built mechanically:

- `ask` gets one optional input, `keywords` (a short list of strings). The chat
  already is a language model, and a handful of keywords costs it a few tokens.
  It can translate, add synonyms and drop filler.
- When `keywords` is absent, the server uses `tokenize(question)` from
  `server/src/mcp/search.mjs`, which already strips stopwords.

### A `search` block in recipes

A recipe has `list` and `fetch`. Lookup adds an optional third block, `search`,
with the same shape as `list` plus two template variables, `{{query}}` (the
keywords joined) and `{{terms}}` (the list).

```yaml
# server/src/connectors/recipes/google-drive.yaml (sketch, not verified)
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
```

A connector whose recipe has no `search` block takes part in steps 1 and 2 only.
Each shipped recipe needs its search tool and arguments checked against the real
server, and recorded in the recipe's `verified:` comment the way `list` and
`fetch` already are. The Drive sketch above reuses the tool the recipe lists
with; the `fullText contains` syntax is an assumption to check.

### Fetching is the sync's fetch

A looked-up document goes through exactly what a synced one does: `fetchItem`,
then `buildSnapshot`. That gives it the snapshot header, neutralised marker
lines, the `max_bytes` cap and a sha256, and stages it under
`.almagest/connector-snapshots/`. The `version` check that lets a sync skip an
unchanged item also lets a lookup skip a second fetch of the same document.

This means the fetch-and-stage part of `syncDetailed` in
`server/src/connectors/index.mjs` is lifted into a function both callers use.

### Passages, ranked and packed

A snapshot already carries locator markers (`=== page 3 ===`,
`=== section: Failover ===`). Lookup splits on them, scores each passage
against the query terms with the existing BM25 code, drops passages below the
threshold, and packs the rest with the same budget logic as `packSections` in
`server/src/mcp/tools.mjs`. Each passage keeps its marker, so the attribution
can name a page or section.

For step 1 the passage index is built when the page index is, each time `main`
moves.

### Enrichment

Every document fetched in step 3 that contributed a passage is queued:

```js
ctx.ingest.enqueue({
  kind: 'ingest',
  trigger: 'lookup',                       // new trigger value
  source: ref,                             // the SourceRef a sync would produce
  requestedBy: 'svc:lookup',
  onBehalfOf: '<human id>',
  instructions: 'Asked: "<question>". Fetched by live lookup.',
});
```

It then follows the normal path: agent job on an `ingest/` branch, audit,
proposal, a person approves, merge. Nothing about review changes.

One thing in the sync must change with it. A sync that lists a connector
completely treats any manifest entry it did not list as `missing`. A document
found by lookup can sit outside the connector's `select` scope, so it would be
flagged missing on the next sync. Entries that came in through lookup need a
marker (`via: lookup`) that the missing check skips, and the sync re-checks
them by ref.

### Telemetry and gaps

A looked-up answer is still a miss for the brain: the event keeps
`answered: false`, so the gap stays open until a reviewed page answers it. The
event gains a `lookup` field (step reached, connectors asked, documents fetched,
cache hits, latency, the ingest job it queued). The gap list shows that field,
so a curator sees "asked 6 times, served from team-drive, proposal waiting".

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
more local search over canonical pages only, using the question and the
passage's terms, at a lower threshold than a normal answer. Any canonical page
that matches is placed above the unreviewed passages and marked as the brain's
position. The answer rules then say: state the canonical position as the
answer, and if an unreviewed passage disagrees, report that as a disagreement
with both sides attributed. The unreviewed passage never replaces it.

`brain.search` already takes a `tier` filter, so this is one extra call on an
index that is in memory.

**Reviewed text outranks unreviewed text.** `ask` already returns weak matches
from curated and evidence pages under "Weak matches (may not be relevant)".
Those stay, above anything lookup found. The order in a result is always:

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

**Anonymization.** With `anonymization.enabled: true`, steps 2 and 3 are off.
Staged snapshots and freshly fetched documents are raw text, and the server
cannot remove personal names mechanically. Step 1 stays available, because a
sidecar is anonymized before it is committed.

**A rejected source is not served again.** When a reviewer rejects the proposal
that came from a looked-up document, the service remembers that document's
sha256. Steps 2 and 3 skip it until its content changes. A person has said no
to it, and lookup should not keep presenting it.

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

Three limits follow from those rules and are worth stating outright:

- **Lookup never promotes.** A looked-up document enters at its connector's
  `tier`, which defaults to `evidence`. It cannot create or change a canonical
  page, and the runner refuses the whole run if a canonical page changed.
- **Hot pages keep their stricter approval.** A proposal from lookup that
  touches a hot page needs what the profile's policy requires for it, the same
  as any other proposal.
- **Who may settle a canonical conflict is unchanged.** In the `enterprise`
  profile that decision needs the `owner` role.

One gap to be aware of: a disagreement seen at answer time is not recorded
anywhere by itself. It reaches the challenge ledger only through the ingest job
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

- Lookup is opt-in per connector (`lookup: true`).
- Its scope is the connector's `select` unless a wider `lookup_select` is set
  on purpose.
- Unreviewed passages go only to callers at or above `mcp.lookup.min_role`
  (default `contributor`). A viewer keeps today's answer.

**Privacy.** Step 3 sends the keywords to a provider. `send_query: false`
turns step 3 off, so nothing derived from a question leaves the server. Under
`telemetry.store_queries: hashed` or `none`, the question text is not written
into the ingest job's instructions either.

**Fetched text is data.** It is neutralised and headed like every snapshot, and
the tool result repeats that it is content and not instruction. It has not been
read by a person, so it can be wrong or planted; the label is what tells the
reader.

**No loops, no floods.**

- A lookup never starts another lookup. The ingest agent has no MCP access, so
  enrichment cannot trigger one either.
- A negative cache remembers "asked this connector, found nothing" per question
  cluster for `negative_ttl_minutes`.
- Rate limits per caller and per connector.
- `max_fetch` documents per question and one overall `timeout_ms`. On timeout
  the answer says the lookup was incomplete.
- Ingest jobs from lookup join the existing dedup for automatic triggers (same
  bytes under review means no new job) and are capped per day.

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

The token budget is `mcp.ask.token_budget`; lookup has no budget of its own.

## What changes in the code

| File | Change |
|---|---|
| `server/src/connectors/recipes.mjs` | `validateRecipe` accepts and checks an optional `search` block |
| `server/src/connectors/execute.mjs` | `searchItems(client, recipe, vars)`: `listItems` on the `search` block, first page only |
| `server/src/connectors/index.mjs` | Lift fetch-and-stage out of `syncDetailed`. Add `search(id, { terms, limit })` and `fetchOne(id, ref)` to the returned API. Skip `via: lookup` entries in the missing check and re-check them by ref |
| `server/src/connectors/recipes/*.yaml` | A `search` block per recipe that has a search tool, each verified against the server |
| `server/src/mcp/passages.mjs` (new) | Split a snapshot on locator markers, score and pack passages. Passage index over committed source text, rebuilt when `main` moves |
| `server/src/mcp/lookup.mjs` (new) | The ladder: steps, threshold, timeout, negative cache, rate limits, the enqueue. The canonical pass (`brain.search` with `tier: 'canonical'`). The list of rejected sources, filled from the `proposal.rejected` bus event and checked in steps 2 and 3 |
| `server/src/mcp/tools.mjs` | `ask`: optional `keywords`, call lookup on a miss, render the blocks in tier order with their labels, add `lookup` to the telemetry record |
| `server/src/mcp/config.mjs` | `lookup` defaults. Steps 2 and 3 forced off when `anonymization.enabled` is true, with a log line saying why |
| `server/src/mcp/rules.mjs`, `agent/rules/read.md` | A rule section for source and unreviewed passages, including "canonical is the brain's position" and "surface a disagreement, do not settle it". It is lifted from `read.md` only into results that contain such passages, so a normal answer carries no extra rule text; an embedded fallback covers a repo without the rule files |
| `server/src/core/schemas.mjs` | `lookup` as a job trigger; `lookup` field on the telemetry event |
| `server/src/ingest/queue.mjs` | `lookup` joins the automatic triggers for dedup |
| `server/src/telemetry/gaps.mjs`, `server/src/governance/web/views.mjs` | Show what lookup served on a gap, and why a proposal exists |
| `docs/v2/mcp.md`, `connectors.md`, `security.md`, `spec.md`, `telemetry.md` | See below |
| `brain.config.yaml` | Commented `mcp.lookup` block and the `lookup:` key in the connector example |
| `server/test/mcp/`, `server/test/connectors/` | Tests against the in-memory MCP server the connector tests already use |

Two sentences in the docs stop being true as written and need rewording when
this ships. `docs/v2/mcp.md` says both transports serve "main's commit … Never
the checkout, never an ingest branch", and the trust boundaries diagram in
`docs/v2/security.md` sums up what a chat can do as "read the brain, submit a
source". With lookup on, both describe step 0 only.

## Build order

Each phase is useful alone and can ship behind `mcp.lookup.enabled`.

1. **Passages and labels, local only.** `passages.mjs`, the new rule section,
   the labelled blocks in `ask`, steps 1 and 2, the canonical pass and the
   anonymization switch. No provider call, no new privacy or credential
   question. Done when a question whose answer is in a committed sidecar, and
   on no page, comes back as a source passage within the budget, and a passage
   that touches a canonical page comes back with that page above it.
2. **Search through a connector.** The `search` block, `connectors.search` and
   `fetchOne`, step 3 with timeout, `max_fetch`, negative cache and rate
   limits. Drive and Notion first, since their recipes already call a search
   tool. Done when a question answered only by a document outside the wiki
   comes back as an unreviewed passage from one `ask` call.
3. **Enrichment.** The `lookup` trigger, dedup, the daily cap, the `via:
   lookup` handling in sync, and the list of rejected sources. Done when asking
   the same question after the proposal is merged is answered at step 0, and
   asking it after the proposal is rejected no longer returns that document.
4. **Visibility.** The `lookup` field in telemetry, the gap list and the
   proposal view. Docs updated.
5. **Measure.** See below.

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

1. **Who gets unreviewed passages by default.** This design says `contributor`
   and above. On a solo brain the owner is the only user, so the `solo` profile
   could turn lookup on by default.
2. **Stdio.** `almagest mcp` runs without the background service. Steps 1 and 2
   work there. Step 3 would open provider connections from every chat that
   spawns it. The proposal is to offer step 3 only under `almagest serve`.
3. **Partial answers.** Lookup runs when the brain has no answer. Whether it
   should also run when the brain answers weakly, or when the page is stale, is
   left out here.
4. **A title catalog.** Listing titles over a wide scope without fetching
   content would let the server find a document with no provider search and no
   keywords leaving the machine. It is a further step between 2 and 3, and it
   raises its own question: a title alone can reveal that a document exists.
