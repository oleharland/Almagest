# Telemetry and demand

Every request to the brain is recorded. From those records the service works
out which pages people actually rely on, and spends review effort there: hot
pages get stricter approval, a shorter re-verification cycle, and audit
warnings when they go stale. Questions the brain could not answer are clustered
into a gap list, so missing knowledge shows up as a to-do instead of a shrug.

None of this is machine learning. Demand is a decayed, weighted count. Gaps are
token-set clusters. Every number can be recomputed by hand from the events
`explain()` names, and every effect it has on governance can be traced back to
those events.

Code: `server/src/telemetry/`. Contract: `docs/v2/spec.md` → *Telemetry and
demand*. Audit side: `tools/lib/checks-demand.mjs`, `docs/audit.md` →
*Demand*.

## What is tracked, and why

One **Event** per request, from every surface that reads the brain — the MCP
tools (`search`, `get_page`, `ask`, `report_gap`, `feedback`, resource reads),
the web inbox, the site and the CLI:

| Field | Why it is kept |
|---|---|
| `id`, `ts` | ordering, decay, retention |
| `channel`, `tool`, `client` | which surface; weights are per tool |
| `results: [{ slug, rank, score }]` | which pages a search or ask surfaced, top 10 only |
| `pagesRead: [slug]` | which pages were read in full |
| `answered` | whether the brain had an answer — misses become gaps |
| `helpful` | `feedback` only — the one explicit signal |
| `sessionId` | so one chat hammering a page counts once (dedupe) |
| `actorId` | distinct-reader counts; hashed by default |
| `query`, `queryHash`, `queryTokens` | gap clustering; subject to the privacy settings below |
| `latencyMs` | operational |

Recording is fire-and-forget: `ctx.telemetry.record(partial)` builds the event,
applies privacy, pushes it onto a bounded in-memory buffer and returns. A
background drain appends to `store.events`. It **never throws and never blocks**
— a slow or failing database costs events, counted in `stats()` as `dropped`
(buffer full, oldest dropped first) or `failed` (append rejected), never
latency or an error in the chat. `telemetry.enabled: false` makes `record` a
no-op and every demand read return zeros.

## Privacy modes

Privacy is applied once, in `server/src/telemetry/events.mjs`, before an event
exists anywhere. Nothing downstream can see a field the configuration said not
to keep.

| Key | `plain` | `hashed` | `none` |
|---|---|---|---|
| `store_queries` | the query text | a keyed hash of it (HMAC-SHA256 with `ALMAGEST_SECRET_KEY`, 16 hex chars) | no query, no hash, no tokens |
| `store_tokens` | the normalised token set, readable (`["connection","fee","grid"]`) | each token keyed-hashed — still comparable, so gaps still cluster, but nothing readable | — |
| `store_actor` | the actor id | a keyed hash | dropped |

`sessionId` is kept as-is only under `store_actor: plain`; otherwise it is
hashed. It is never dropped, because session dedupe needs equality, not
identity. `queryHash` (over the normalised form) is kept in both `plain` and
`hashed` so repeated phrasings group.

What shows where:

| | `/api/gaps`, `almagest gaps` | `demand.tsv`, `/api/demand` |
|---|---|---|
| `plain` queries | the commonest phrasings + tokens | aggregates only, always |
| `hashed` queries | counts and tokens, no text | aggregates only |
| `hashed` tokens | counts and a cluster id only | aggregates only |
| `none` | no gaps at all | aggregates only |

### What an enterprise should pick

```yaml
telemetry:
  store_queries: hashed
  store_tokens: hashed      # if questions can contain personal data (names, customer ids)
  store_actor: hashed
  retention_days: 30
```

- **`hashed`, not `plain`, for queries.** Questions people ask a company brain
  contain names, customer numbers and things they would not put in a ticket.
  A keyed hash still groups repeats; it cannot be read back.
- **Hash tokens too when queries may carry personal data.** With
  `store_tokens: plain` the token set of "salary of John Smith" is
  `["john","salary","smith"]` — order lost, content not. `hashed` keeps gap
  clustering working (counts, distinct sessions, a stable cluster id) and gives
  up the readable label. `none` gives up gaps entirely.
- **Set `ALMAGEST_SECRET_KEY`.** Without it the hash key is a fixed default and
  a hash is only a hash. With it, a dictionary attack needs the key.

### GDPR notes

- **Pseudonymised is still personal data.** A keyed hash of an actor id is
  pseudonymisation (Art. 4(5)), not anonymisation; the event log remains in
  scope. Treat the service database as a processing record: purpose
  (improving the knowledge base, prioritising review), legal basis (usually
  legitimate interest — document the balancing test), retention.
- **Retention is enforced, not advised.** `store.events.prune` runs daily and
  deletes every event older than `retention_days` (default 90; 30 is a
  sensible enterprise value — the demand half-life is 14 days, so events older
  than a few half-lives contribute almost nothing anyway).
- **No raw events in git, ever.** The only telemetry artefact that leaves the
  database is `.almagest/demand.tsv` — slug, score, rank, hot; no query text,
  no actors, no timestamps — and `.almagest/` is gitignored. The kv cache
  (`demand/latest`) holds the same aggregates.
- **Erasure.** Deleting a person's events means deleting rows whose `actorId`
  is `pseudonymize(<their id>)`; with `store_actor: none` there is nothing to
  find. `sessionId` is per chat, not per person.
- **Minimisation.** `results` is trimmed to the top 10; `latencyMs` is rounded;
  no request bodies, page contents or answers are stored.

## The demand score

```
score(page) = max(0, Σ  weight(event, page) × 0.5^(age_days / half_life_days))
```

| Signal | Weight |
|---|---|
| `get_page`, or a resource read of `almagest://page/{slug}` (`resource` / `read_resource`) | 1.0 |
| `ask` result at rank r | 0.6 × d(r) |
| `search` result at rank r, top 3 only | 0.3 × d(r) |
| `feedback` helpful | +2 |
| `feedback` unhelpful | −1 |

- **Rank discount** `d(r) = 1 / log2(r + 1)` — the DCG discount: rank 1 → 1,
  rank 2 → 0.63, rank 3 → 0.5. Appearing at the top of an answer means more
  than appearing third.
- **Decay** halves a signal's weight every `half_life_days` (default 14), so
  demand follows what people need now, not what they needed in spring.
- **Session dedupe.** One session touching one page counts once per
  `dedupe_minutes` window (default 10, tumbling, anchored at the first touch).
  Inside a window the strongest implicit signal is kept — a search hit followed
  by a full read counts as the read, not both. Feedback dedupes separately; the
  latest verdict in a window wins. Events with neither `sessionId` nor
  `actorId` are not deduped.
- **Clamp.** Unhelpful feedback subtracts, but the total never goes below 0.
- **Distinct sessions** — how many different sessions contributed positive
  signal — is the secondary key: at equal score, ten readers outrank one reader
  ten times.

Weights can be overridden, or given to a new tool, under
`telemetry.demand.weights`. Tools without a weight (`list_sources`,
`report_gap`, governance tools) contribute nothing.

### Worked example

On 1 June a page `grid` has:

| Event | When | Contribution |
|---|---|---|
| 3 × `get_page`, three different sessions | today | 3 × 1.0 × 0.5⁰ = **3.000** |
| `ask`, `grid` ranked 2nd | 14 days ago | 0.6 × 0.631 × 0.5¹ = **0.189** |
| `search`, `grid` ranked 1st | 28 days ago | 0.3 × 1 × 0.5² = **0.075** |

Score = 3.264, from 5 distinct sessions. (This exact case is a unit test:
`server/test/telemetry/score.test.mjs` → *the worked example*.)

### Hot

All of main's pages are ranked — score descending, then distinct sessions,
then slug — including pages nobody read, so "top 10%" means 10% of the wiki
rather than 10% of whatever happened to be opened. A page is **hot** when

- its rank is within the top `100 − hot_percentile` percent (default: top 10%,
  rounded **up**, so a three-page wiki still has one hot page), **and**
- its score is at least `min_score` (default 3 — roughly three full reads this
  fortnight), and above zero.

The floor is what stops a quiet wiki from calling its single most-read page
hot on the strength of one visit.

### Recompute, cache, export

Demand is recomputed every `recompute_seconds` (default 300), shortly after a
`proposal.merged`, and on demand (`ctx.demand.recompute()`, `?refresh=1`, the
CLI). The result is cached in `store.kv` (`demand` / `latest`, with
`computedAt`), so a restart serves the last ranking immediately. When the hot
list changes — not merely the scores — the service emits `demand.updated
{ hot }` on the bus. After each recompute it writes `.almagest/demand.tsv`
(`config.paths.demand`), only when its bytes change.

### Explain

`ctx.telemetry.explain(slug)` (`GET /api/demand/:slug`) returns, for one page:

- `score`, `rank`, `hot`, and the hot rule it was judged by
  (`{ percentile, minScore, population }`)
- `formula` and `halfLifeDays`
- `byTool` — counted and deduped events per tool, and their summed value
- `topContributors` — the ten events that moved the score most:
  `{ eventId, ts, tool, kind, rank, weight, decay, value }`
- `trend` — raw (undecayed) signal in the latest half-life window against the
  one before: `{ current, previous, delta, direction: rising | falling | flat }`

That is the whole of the "learning". If a reviewer asks why a page needed two
approvals, the answer is a list of event ids.

## How demand changes governance

| Mechanism | Where | Effect |
|---|---|---|
| Stricter approval | Governance policy, `governance.rules` with `when: { hot: true }` | Each `ProposalChange` carries `hot` and `demand` from `ctx.demand.get`. Profile defaults: solo 1 approval per page, team 2, enterprise 2 + owner team |
| Re-verify queue | `ctx.telemetry.reverifyQueue()`, `GET /api/reverify`, `/inbox/reverify`, `almagest reverify` | Hot pages whose `last_verified` is older than `stale_after_days_hot` (default 30 — a third of the 90-day tier threshold), never verified, or with `confidence: low \| unknown`. Ordered by **score × max(overdue_days, 1)**; each entry says why |
| Auto re-verify (opt-in) | `telemetry.auto_reverify: true` | Each recompute enqueues `ctx.ingest.enqueue({ kind: 'reverify', slug, trigger: 'demand', requestedBy: 'svc:telemetry', instructions })` for each due, non-canonical page — at most once per page per `stale_after_days_hot` window (tracked in kv `demand.reverify`). The job still produces a proposal; a human still merges it |
| Audit warnings | `tools/audit.mjs --demand .almagest/demand.tsv` | `DEMAND-001` hot page past `stale_after_days_hot`; `DEMAND-002` hot page with low/unknown confidence. Warnings unless `audit.severity` lists them as errors. See `docs/audit.md` → *Demand* |
| Gap list | `ctx.telemetry.gaps()`, `GET /api/gaps`, `/inbox/gaps`, `almagest gaps` | What people asked that no page answered, clustered, with a plain-text suggestion |

Nothing here relaxes a non-negotiable. Demand can make review **stricter** and
make work **appear**; it never approves, merges, or edits a page. Canonical
pages are never auto-enqueued — an agent job could not change them.

## Gaps

A **miss** is a `search` or `ask` event with `answered: false` (or no results
and no verdict), or a `report_gap` event. Misses inside the window
(`gaps.window_days`, default 30, or `since`) are clustered:

1. Each query's normalised token set — lowercased, accents folded, stopwords
   dropped, plurals folded (`fees` → `fee`), sorted, unique.
2. Oldest first, each miss joins the cluster whose anchor (its first miss) it
   is most similar to by Jaccard similarity, if that is at least
   `gaps.similarity` (default 0.5); otherwise it anchors a new cluster.
3. **Gaps close themselves.** If a later `search` / `ask` with a similar token
   set *was* answered — someone added the page — every miss in the cluster up
   to that moment is dropped. A miss after the answer reopens the cluster
   (`reopenedAfter`).

Each gap: `{ cluster, representative, tokens, queries, count, distinctSessions,
tools, firstSeen, lastSeen, suggestion }`, ordered by count, then distinct
sessions, then recency. The suggestion is plain text:

> No page covers "grid connection fee" — 7 requests in 14 days from 5 sessions; consider submitting a source.

In hashed mode `queries` is empty and `representative` is built from the
tokens; with hashed tokens it is `null` and the suggestion names the cluster
size instead.

## Configuration

All optional; every key falls back to the default shown. None of these is in
the shipped `brain.config.yaml` yet — add the block to opt in to anything other
than the defaults.

```yaml
telemetry:
  enabled: true
  store_queries: plain             # plain | hashed | none          (team/enterprise default: hashed)
  store_tokens: plain              # plain | hashed
  store_actor: hashed              # plain | hashed | none
  retention_days: 90
  recompute_seconds: 300
  buffer_size: 1000                # events held in memory while the store is slow
  demand:
    half_life_days: 14
    hot_percentile: 90             # top 10% by score are hot …
    min_score: 3                   # … and must clear this floor
    dedupe_minutes: 10
    search_top: 3                  # search hits below this rank do not count
    weights:                       # override or extend
      get_page: 1.0
      resource: 1.0
      ask: 0.6
      search: 0.3
      feedback_helpful: 2
      feedback_unhelpful: -1
  stale_after_days_hot: 30         # re-verify threshold for hot pages; also DEMAND-001's
  auto_reverify: false
  gaps:
    similarity: 0.5                # Jaccard threshold
    window_days: 30
    min_count: 1

audit:
  severity:
    warnings:
      - DEMAND-001                 # hot page past stale_after_days_hot
      - DEMAND-002                 # hot page with confidence: low | unknown
    # or list either under errors: to make it fail the build
```

`DEMAND-001` / `DEMAND-002` default to **warning** when `audit.severity` does
not list them, so a v1 config keeps passing.

## API reference

All routes are `GET`, auth `any` (any authenticated actor).

| Route | Query | Returns |
|---|---|---|
| `/api/demand` | `top` (default 20), `refresh=1` | `{ enabled, computedAt, hot: [slug], top: [{ slug, score, rank, hot, distinctSessions }] }` |
| `/api/demand/:slug` | — | the `explain()` object above |
| `/api/gaps` | `limit` (default 20), `since` (ISO date) | `{ gaps: [...] }` |
| `/api/reverify` | — | `{ queue: [{ slug, title, score, rank, lastVerified, overdueDays, confidence, tier, reason, reasons, priority }] }` |

Service surface (`docs/v2/spec.md` → *Cross-module service objects*):

```
ctx.demand     .get(slugs) → Map<slug, { score, rank, hot }>    unknown slugs → { 0, 0, false }
               .hot() → [slug]   .top(n)   .recompute()
ctx.telemetry  .record(partial) → void
               .explain(slug)  .gaps({ limit, since })  .reverifyQueue()
               .recompute()  .prune()  .flush()  .stats()  .start()  .stop()
```

`record(partial)` accepts `{ channel, tool, actor | actorId, client, sessionId,
query, results, pagesRead, answered, latencyMs, helpful }`; `ts` may be passed
for a backfill, otherwise it is now. `results` may be `[{ slug, rank, score }]`
or bare slugs (rank = position).

## CLI reference

Each recomputes first, so the answer reflects the log as it is now. `--json`
prints what the matching route returns.

```
almagest demand [--top N] [--json]
almagest gaps [--limit N] [--since <iso date>] [--json]
almagest reverify [--json]
```

```
$ almagest demand --top 3
rank  slug             score  sessions  hot
────  ───────────────  ─────  ────────  ───
   1  grid-connection  12.41         9  hot
   2  tariffs           4.02         3
   3  battery-warranty  1.30         1

1 hot of 48 page(s) · computed 2026-06-01T12:00:00.000Z
```

## Storage

Events live in `store.events` (sqlite by default; Postgres for the enterprise
profile — `server/src/core/store/postgres.mjs`, JSONB documents, `ts`-indexed,
schema created on first connect). Scoring reads the events inside
`retention_days` on each recompute; that is a full scan of a few months of
requests, which is fine at knowledge-base volumes (tens of thousands of events)
and is the price of every number being recomputable from the log rather than
from an opaque running total.
