# Almagest v2 — the service layer

Status: **build spec**. This file is the shared contract the v2 workstreams build
against. If a workstream needs to change a contract defined here, it changes this
file in the same commit and says so in its summary.

## What v2 adds, and what it does not change

v1 is a git repo plus rules plus an audit. Every guarantee lives in git and in
`tools/audit.mjs`. v2 wraps that in a long-running service — `server/` — that
adds five things:

| # | Workstream | Module | One line |
|---|---|---|---|
| WS1 | Background ingest | `server/src/ingest/` | A queue + runner that ingests on its own, in its own git worktree, gated by the audit |
| WS2 | Connectors | `server/src/connectors/` | Any MCP server as an input, fingerprinted mechanically |
| WS3 | Governance | `server/src/governance/` | Proposals, decisions, policy, and pluggable approval channels (web, chat, Slack, email, GitHub PR) |
| WS4 | Almagest as MCP | `server/src/mcp/` | Read the brain from any chat, local (stdio) or remote (HTTP) |
| WS5 | Telemetry | `server/src/telemetry/` | Every request tracked; demand drives review strictness, re-verification and gap discovery |

**Git stays the store.** `brain/wiki/` on `main` is still the source of truth;
the service holds no second copy of the knowledge. The service's own database
holds only operational state: jobs, proposals, decisions, approvals, events,
connector cursors, the governance audit log.

**The non-negotiables in `CLAUDE.md` hold unchanged.** In particular:

- *No unreviewed writes.* An approval in any channel is a **human** actor
  approving a proposal whose diff they were shown; the service then performs the
  merge under that actor's identity. `actor.kind === 'agent'` can never approve —
  enforced in code (`core/auth.mjs` → `assertCanApprove`), not in config, and
  there is no flag for it. A proposal with zero human approvals cannot merge.
- *The audit gates.* The **runner** runs `tools/audit.mjs` on the ingest
  worktree, not the agent; exit `1` means no commit. The merge step re-runs the
  audit on the merge result; exit `1` means no merge.
- *Fingerprint, don't guess.* Connector content is fingerprinted by the service
  (sha256 of the fetched snapshot), never by the agent.

## Profiles

One model, three default sets. `brain.config.yaml` → `service.profile` picks the
defaults; every individual key can still be overridden.

| | `solo` | `team` | `enterprise` |
|---|---|---|---|
| Store | sqlite | sqlite | postgres |
| Human auth | static token | OIDC | OIDC (required) |
| Separation of duties (submitter ≠ approver) | off | on | on |
| Approvals for ordinary proposals | 1 | 1 | 1 |
| Approvals for hot / canonical-adjacent pages | 1, per-page | 2, per-page | 2, per-page, owner team |
| Default channels | web, mcp | web, mcp, slack | web, slack, github-pr |
| Query text in telemetry | plain | hashed | hashed |
| Remote MCP auth | bearer token | OIDC JWT | OIDC JWT |

An entrepreneur runs `solo` on a laptop or a single container. An enterprise runs
`enterprise` in its own VPC with Postgres and SSO. Nothing in the code branches on
the profile name — the profile only fills defaults (`core/config.mjs`).

## Repository layout

```
server/                       its own package, like site/ — plain ESM .mjs + JSDoc, Node 22.13+
  package.json
  bin/almagest.mjs            CLI: serve · ingestd · mcp · hook <name> · connectors <cmd> · doctor
  src/
    app.mjs                   composition root: builds ctx, calls each module's create(ctx)
    core/                     Phase 0 — shared contracts. Change only with a spec change.
      config.mjs              v2 config sections + profile defaults (wraps tools/lib/config.mjs)
      schemas.mjs             entity shapes, enums, validators, id generation
      store/index.mjs         Store interface + driver selection
      store/memory.mjs        in-memory driver (tests)
      store/sqlite.mjs        node:sqlite driver (default)
      git.mjs                 git plumbing helpers (run, revParse, worktrees, diff, show)
      bus.mjs                 in-process typed event bus
      auth.mjs                Actor model, AuthProvider interface, assertCanApprove
      http.mjs                tiny router over node:http (no framework)
      log.mjs                 structured logger
      snapshot.mjs            ctx.snapshot — main's pages via a detached worktree, cached per sha
    ingest/      WS1          create(ctx) → ctx.ingest
    connectors/  WS2          create(ctx) → ctx.connectors
    governance/  WS3          create(ctx) → ctx.governance
    mcp/         WS4          create(ctx) → ctx.mcp
    telemetry/   WS5          create(ctx) → ctx.telemetry (+ ctx.demand)
  test/                       node --test; one folder per module
deploy/                       Dockerfile, compose, launchd, systemd (integration phase)
```

Why `.mjs` and not TypeScript: the same reason `tools/` is — bare Node runs it,
and `tools/lib/wiki-core.mjs` is imported directly. The service **must** use
`wiki-core.mjs` (via `loadWiki`) to read pages. There is still exactly one
frontmatter and wikilink parser in the repo.

Dependencies are kept small: `@modelcontextprotocol/sdk`, `gray-matter`, `yaml`.
Postgres (`pg`) is an optional dependency loaded only when `store.driver: postgres`.

## The composition root

```js
// server/src/app.mjs
const ctx = { repoRoot, config, log, store, git, bus, auth, http, snapshot };
ctx.telemetry  = await telemetry.create(ctx);   // also sets ctx.demand
ctx.connectors = await connectors.create(ctx);
ctx.ingest     = await ingest.create(ctx);
ctx.governance = await governance.create(ctx);
ctx.mcp        = await mcp.create(ctx);
```

Each module exports `create(ctx)` returning its service object, and may register
HTTP routes on `ctx.http`, subscribe to `ctx.bus`, and add CLI subcommands by
exporting `commands` (see `bin/almagest.mjs`). A module never imports another
module's internals — only the service object on `ctx`. Unit tests construct a
`ctx` with the memory store and stub services (`server/test/helpers.mjs`).

## Entities

All entities are plain JSON objects. Ids are `<prefix>_<ulid-ish>` from
`schemas.mjs` → `newId(prefix)`. Timestamps are ISO-8601 UTC strings.

### Actor

```js
{ id: 'usr_…' | 'agent:<driver>' | 'svc:<name>',
  kind: 'human' | 'agent' | 'service',
  display: 'Ada', email?: 'ada@acme.com',
  roles: ['viewer'|'contributor'|'reviewer'|'owner'|'admin'],
  teams: ['engineering', …] }            // values from brain.config.yaml → owner_teams
```

Only `kind: 'human'` with role `reviewer`, `owner` or `admin` can approve. An MCP
session is **always** an agent actor acting *on behalf of* a human
(`actor.onBehalfOf`), even when the bearer token belongs to a human — a chat model
holds that token, not the person.

### SourceRef

```js
{ kind: 'local' | 'remote' | 'connector',
  id: '<manifest id>',                   // stable, see docs/manifest.md
  connector?: '<connector id>',           // kind: connector
  ref?: '<provider item id>',             // kind: connector
  path?: 'brain/raw/foo.pdf',             // kind: local / remote; kind: connector → the snapshot path
  version?: '<provider revision / etag / updatedAt>',
  sha256?: '<hex>',                       // of the bytes the agent will read
  title?: 'Human label' }
```

A `kind: connector` ref also carries `server`, `change` (`new` | `changed` |
`reappeared`), `snapshot` (`commit` | `ephemeral`), `label`, `tier`, and
optionally `commit` and `supersedes` (a v1 `kind: remote` manifest id) — see
`docs/v2/connectors.md` → The SourceRef.

### Job (WS1 owns the lifecycle)

```js
{ id: 'job_…',
  kind: 'ingest' | 'revise' | 'reverify' | 'drop-page',
  source: SourceRef | null,
  trigger: 'watch' | 'schedule' | 'manual' | 'mcp' | 'hook' | 'decision' | 'feedback' | 'demand',
  requestedBy: Actor.id,
  requester?: { id, kind?, display?, email? },   // when enqueue got an Actor, not an id — the commit co-author
  onBehalfOf?: Actor.id,                  // an agent acting for a person (MCP submit_source); also co-authors
  proposalId?: 'prp_…',                   // revise / drop-page work on an existing proposal's branch;
                                          // an ingest job gets it once its proposal exists
  slug?: '<page slug>',                   // reverify: the page to re-check (WS5 enqueues with trigger 'demand')
                                          // drop-page: the page to drop (required); `slugs?: [...]` for several
  instructions?: 'free text for the agent (decision resolution, reviewer feedback)',
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'cancelled',
  attempts: 0, maxAttempts: 2, lastError?, workerId?,
  branch?: 'ingest/<source-slug>-<sha7>', worktree?: '<abs path>', baseSha?, headSha?,
  runReport?: RunReport, audit?: Proposal.audit, costUsd?, error?: 'message', note?: 'e.g. unchanged — nothing to review',
  createdAt, startedAt?, finishedAt? }
```

`blocked` = the run produced decisions and nothing else (`outcome: blocked-only`);
a proposal still exists to carry them. A run with nothing to review (`unchanged`,
or no diff and no decisions) succeeds with no proposal, and an empty branch it
created is deleted.

Dedup: enqueueing a job whose `(kind, source.id, source.sha256)` matches a
`queued` or `running` job returns the existing job. Refinements (WS1):
- a source-less `reverify` dedups on `(kind, slug)`;
- `drop-page` dedups on `(proposalId, slug)`;
- a `revise` still **queued** for the same proposal absorbs the new
  `instructions` (appended) instead of being collapsed or duplicated — two
  decisions resolved back to back must both reach the agent;
- an `ingest` from an automatic trigger (`watch`, `schedule`, `hook`, `mcp`)
  also returns a finished job for the same bytes whose proposal is not yet
  merged / rejected / superseded, or that found nothing to review — a connector
  re-listing an item under review every 15 minutes spawns no new jobs.
  `manual` skips this: `almagest ingest <path>` is how a person forces a re-run.

### RunReport — what the agent hands back

The headless agent ends its run by writing `.almagest/run-report.json` in the
worktree (schema: `server/src/core/run-report.schema.json`). The runner validates
it; an invalid or missing report fails the job.

```js
{ source: { id, sha256 },
  outcome: 'written' | 'unchanged' | 'blocked-only' | 'failed',
  pages: [{ slug, action: 'create' | 'update', tier, summary: 'one line' }],
  blocked: [{ kind: DecisionKind, slug, question, claimA?, sourceA?, claimB?, sourceB?,
              options: [{ id, label, effect }] }],
  notes?: '…' }
```

### Proposal (WS3 owns; WS1 creates)

```js
{ id: 'prp_…', jobId, branch, baseSha, headSha,
  status: 'open' | 'changes_requested' | 'approved' | 'merged' | 'rejected' | 'superseded' | 'conflicted',
  title, summary, source: SourceRef, submittedBy: Actor.id,
  audit: { exit: 0|1|2, errors: n, warnings: n, findings: [...] },   // tools/audit.mjs --json
  changes: [ProposalChange],
  decisions: ['dec_…'],
  required: { approvals: n, perPage: bool, roles: [...], teams: [...], reasons: ['hot page: x', …] },
  approvals: [{ actorId, at, scope: 'all' | '<slug>', channel: ChannelKind }],
  merge?: { sha, at, by },
  createdAt, updatedAt }

ProposalChange =
{ slug, path, action: 'create' | 'update' | 'delete' | 'rename',
  tier, hot: bool, demand: number,
  claims: [{ op: 'add' | 'change' | 'remove', text, before?,
             citation?: { id, locator }, excerpt?: '<source passage the locator points at>' }],
  pageStatus: 'pending' | 'accepted' | 'rejected' }
```

The claim-level view is the review surface. It replaces "read a diff": each
added or changed claim is shown next to the source passage its citation resolves
to. `excerpt` resolution uses the sidecar page markers (`=== page N ===`) and the
locator grammar from `CLAUDE.md`.

### Decision (WS3)

Every case that blocks in v1 ("stop for an in-session decision") becomes a
Decision card the runner records instead of stopping.

```js
{ id: 'dec_…', proposalId,
  kind: 'contradiction' | 'canonical_conflict' | 'delete' | 'merge' | 'rename'
      | 'low_confidence' | 'anonymization',
  slug, question, context: { claimA, sourceA, claimB, sourceB },
  options: [{ id, label, effect }],       // effect: prose instruction for the revise job
  status: 'open' | 'resolved',
  resolution?: { optionId, note, actorId, at } }
```

Resolving a decision enqueues a `revise` job (trigger `decision`) on the
proposal's branch with the chosen option's `effect` as `instructions`. A
`canonical_conflict` has exactly one non-dismiss effect: append to
`brain/canonical-challenges.md`. A proposal with open decisions cannot merge.

### Event (WS5 owns)

```js
{ id: 'evt_…', ts, channel: 'mcp' | 'web' | 'site' | 'cli',
  tool: 'search' | 'get_page' | 'ask' | …,
  actorId?: '<hashed unless telemetry.store_actor: plain>',
  client?: 'claude.ai' | 'claude-code' | …,
  sessionId?: '<hashed unless telemetry.store_actor: plain>',
  query?: '<per telemetry.store_queries: plain | hashed | none>', queryHash?,
  queryTokens?: ['<normalised token>'],   // gap clustering; hashed when telemetry.store_tokens: hashed
  queryHashed?: true, tokensHashed?: true,
  results: [{ slug, rank, score }],       // top 10 by rank
  pagesRead: [slug],
  answered: true | false | null, latencyMs,
  helpful?: true | false }                // tool: 'feedback' — the explicit demand signal
```

Callers pass a partial (`{ channel, tool, actor | actorId, sessionId, query,
results, pagesRead, answered, latencyMs, helpful? }`); `ctx.telemetry.record`
fills `id` and `ts` and applies the privacy settings before anything is stored.
Full field semantics: `docs/v2/telemetry.md`.

### AuditEntry (governance audit log — append-only)

```js
{ id: 'aud_…', ts, actorId, action: 'proposal.approve' | 'proposal.reject' | 'proposal.merge'
  | 'decision.resolve' | 'page.reject' | 'connector.login' | 'policy.override' | …,
  target: 'prp_…' | 'dec_…' | …, channel, detail: {} }
```

The store exposes no update or delete for audit entries.

## Store interface (`core/store/index.mjs`)

Async throughout so a Postgres driver fits behind the same interface.

```
store.jobs        .enqueue(job) .claim(workerId) .update(id, patch) .get(id) .list(filter)
store.proposals   .create(p) .update(id, patch) .get(id) .getByBranch(branch) .list(filter)
store.decisions   .create(d) .update(id, patch) .get(id) .listByProposal(prpId) .list(filter)
store.events      .append(evt) .query({ since, until, tool, slug }) .prune(beforeTs)
store.audit       .append(entry) .list(filter)
store.kv          .get(ns, key) .set(ns, key, value) .delete(ns, key) .list(ns)   // cursors, tokens, demand cache
store.close()
```

`claim` is atomic: it moves the oldest `queued` job to `running` and returns it,
or returns `null`. `filter` is a plain object of field equality plus `limit`.
Secrets in `kv` (connector OAuth tokens) are encrypted with `ALMAGEST_SECRET_KEY`
by the caller (`core/schemas.mjs` → `seal` / `unseal`).

## Bus events (`core/bus.mjs`)

```
job.queued  job.started  job.finished           { job }
proposal.created  proposal.updated              { proposal }
proposal.approved proposal.rejected proposal.merged { proposal, actor }
decision.created  decision.resolved             { decision, proposal }
connector.synced                                { connectorId, items }
demand.updated                                  { hot: [slug] }
```

Channels (WS3) subscribe to these to notify; WS5 subscribes to `proposal.merged`
to invalidate its page cache.

## Cross-module service objects

What each module promises on `ctx`. The signatures are the contract; internals
are the module's own business.

```
ctx.ingest      .enqueue({ kind, source, trigger, requestedBy, onBehalfOf?, proposalId?, instructions?, slug?, slugs? }) → Job
                .get(id) .list(filter) .start() .stop() .cancel(id)
                // requestedBy: an Actor.id or an Actor; a local source without sha256 is fingerprinted here.
                // Local sources must live under sources.local.path or .almagest/submissions/.

ctx.connectors  .list() → [{ id, mcp, recipe, schedule, lastSync }]
                .sync(id, { since?, full?, dryRun? }) → [SourceRef]   // fetch + snapshot + fingerprint
                .syncDetailed(id, opts) → { refs, unchanged, missing, errors, … }
                .snapshotPath(sourceRef) → 'brain/raw/extracted/<connector>/<file>.txt'
                .stagedPath(sourceRef) → '<abs>/.almagest/connector-snapshots/<connector>/<file>.txt'
                .materialize(sourceRef, worktreeDir) → snapshotPath   // copy staged → worktree; throws if sha256 moved
                .stop()                                               // close pooled MCP connections

ctx.governance  .listProposals(filter) .getProposal(id)
                .createFromJob(job, { worktree, branch, baseSha, headSha, audit, runReport }) → Proposal
                .approve(prpId, actor, { scope, channel })   // assertCanApprove; merges when requirements met
                .reject(prpId, actor, { reason, channel })
                .rejectPage(prpId, slug, actor, { channel })
                .requestChanges(prpId, actor, { feedback, channel })
                .resolveDecision(decId, actor, { optionId, note, channel })
                .createConfirmation(prpId, onBehalfOf, action) → { url, code, expiresAt }   // chat channel

ctx.demand      .get(slugs) → Map<slug, { score, rank, hot }>   // WS5 implements, WS3 consumes; unknown → zeros
                .hot() → [slug]
                .top(n) → [{ slug, score, rank, hot, distinctSessions }]
                .recompute() → { computedAt, population, hot, entries, changed }
ctx.telemetry   .record(evtPartial) → void                       // never throws, never blocks the caller
                .gaps({ limit, since }) → [{ cluster, representative, tokens, queries, count,
                                             distinctSessions, firstSeen, lastSeen, suggestion }]
                .explain(slug) → { score, rank, hot, byTool, topContributors, trend, formula, … }
                .recompute() .prune() .flush() .stats() .start() .stop()

ctx.mcp         .serveStdio() .handleHttp(req, res)
                .createServer({ human }) .search(query) .sweep() .close()   // in-process server, index, housekeeping

ctx.snapshot    .load() → { sha, dir, pages, byId, known }   // core — main's pages, never the checkout's
                .refresh({ fetch? }) → sha
ctx.telemetry   .reverifyQueue() → [{ slug, title, score, lastVerified, overdueDays, reason }]   // hot pages due a re-check
```

**Proposals are upserted by branch.** `createFromJob` on a branch that already
has an open proposal (a `revise` or `drop-page` job) updates that proposal: new
`headSha`, recomputed `changes`, `audit` and `required`. Every approval records
the `headSha` it was given for, and **an approval only counts while it matches
the current `headSha`** — a reviewer approves a specific diff, not a branch name
that can move under them.

## Config additions (`brain.config.yaml`)

All optional. A v1 config with none of these keys runs the v1 workflow exactly as
before, and the service starts with `profile: solo` defaults.

```yaml
service:
  profile: solo                    # solo | team | enterprise
  store:
    driver: sqlite                 # sqlite | postgres | memory
    path: .almagest/almagest.db    # sqlite
    # url: ${DATABASE_URL}         # postgres
  http:
    host: 127.0.0.1
    port: 4747
    base_url: http://127.0.0.1:4747  # used in links sent by channels
  git:
    main: main
    remote: origin                 # fetch from / push to; omit for a purely local repo
    push: false                    # push ingest branches and merges to `remote`
    worktree_dir: .almagest/worktrees
  auth:
    provider: token                # token | oidc
    tokens_env: ALMAGEST_TOKENS    # token: "name:role[,role]:secret;…"
    # oidc: { issuer, client_id, client_secret_env, audience, roles_claim, teams_claim }

ingest:
  driver: claude-code              # claude-code | codex | gemini-cli | shell | fake
  model_tier: judgment             # resolved through agent.profiles
  concurrency: 1
  budget_usd_per_job: 5
  timeout_minutes: 30
  watch_raw: true
  max_attempts: 2

sources:
  local: { path: brain/raw }
  remote: []                       # v1 — still read; treated as recipe github/gitlab connectors
  connectors:
    - id: product-drive
      mcp: google-drive            # key in .mcp.json → mcpServers, or { url, headers }
      recipe: google-drive         # preset in server/src/connectors/recipes/, or `mcp-resources`, or `custom`
      select: { folder: "Product/Specs" }   # recipe-specific
      schedule: "0 * * * *"        # cron; omit for manual only
      label: product
      tier: evidence               # default tier for pages from this connector
      snapshot: commit             # commit (default, citations verifiable) | ephemeral

governance:
  channels:                        # every enabled channel notifies; the ones with actions can approve
    - kind: web                    # built in, always on; the one surface that shows full context
    - kind: mcp                    # list/explain proposals from chat; approval via confirmation link
    # - kind: slack   { webhook_env: SLACK_WEBHOOK_URL, signing_secret_env: SLACK_SIGNING_SECRET }
    # - kind: email   { smtp_url_env: SMTP_URL, from: "almagest@acme.com", to: [...] }
    # - kind: github-pr { repo: acme/brain, token_env: GITHUB_TOKEN }
  separation_of_duties: false      # profile default
  require_sso_for_approval: false  # enterprise: email/Slack links still demand an SSO session
  rules:                           # first match adds requirements; requirements combine by max
    - when: { hot: true }
      require: { approvals: 1, per_page: true }
    - when: { decision: canonical_conflict }
      require: { roles: [owner] }

mcp:                               # WS4 — every key and its default: docs/v2/mcp.md
  allow_url_fetch: false           # submit_source { url }, SSRF-guarded when on
  builtin_oauth: true              # token mode: OAuth 2.1 front door for claude.ai
  git_webhook_secret_env: ALMAGEST_GIT_WEBHOOK_SECRET

telemetry:
  enabled: true
  store_queries: plain             # plain | hashed | none
  store_actor: hashed              # plain | hashed | none
  store_tokens: plain              # plain | hashed — the normalised token set used to cluster gaps
  retention_days: 90
  recompute_seconds: 300
  demand:
    half_life_days: 14
    hot_percentile: 90             # top 10% by score are hot …
    min_score: 3                   # … and must clear this floor
    dedupe_minutes: 10             # one session × one page counts once per window
    # weights: { get_page: 1.0, resource: 1.0, ask: 0.6, search: 0.3, feedback_helpful: 2, feedback_unhelpful: -1 }
  stale_after_days_hot: 30         # hot pages re-verify sooner (DEMAND-001)
  auto_reverify: false             # true: enqueue `reverify` jobs for due hot pages, once per page per window
  gaps: { similarity: 0.5, window_days: 30, min_count: 1 }
```

## Background ingest (WS1)

Triggers → `ctx.ingest.enqueue`:

- **watch** — `fs.watch` on `sources.local.path` (debounced, ignores `processed/`
  and `extracted/`), fingerprinted with sha256 before enqueue.
- **schedule** — each connector's `schedule`; calls `ctx.connectors.sync`, enqueues
  one job per new or changed SourceRef.
- **manual / mcp / hook** — CLI, MCP `submit_source`, Claude Code hooks.

Runner, per job:

1. Create `ingest/<source-slug>-<sha7>` from `main` with
   `git worktree add <worktree_dir>/<branch>`. `revise` / `drop-page` jobs reuse
   the proposal's branch. The user's checkout is never touched.
2. Place the source in the worktree (local file copied into `brain/raw/` from
   a content-addressed staging copy taken at enqueue; connector snapshot via
   `ctx.connectors.materialize(ref, worktree)`), re-hashed against
   `source.sha256`.
3. Run the driver (`ingest/drivers/*.mjs`) with cwd = worktree, the ingest
   prompt (rules + "runner mode" addendum + `instructions`), a **locked-down tool
   allowlist** (read/write/edit inside the worktree, `shasum`, and a per-job
   audit wrapper outside the worktree that takes no arguments and is pinned to
   the worktree — never `node tools/audit.mjs:*`, whose flags reach anywhere;
   **no** git, **no** network, **no** MCP), the budget and the
   timeout. Source content is untrusted input; the prompt says so, and the tool
   allowlist is what makes it true.
4. Validate `.almagest/run-report.json` (then remove `.almagest/` from the
   worktree, so it can never be committed). A local original moves to
   `processed/`. **Path guard:** any change outside `brain/`'s writable paths
   (wiki, raw, `.index`, index.md, manifest, log.md, canonical-challenges.md)
   or to a canonical page fails the job, uncommitted.
5. Run `node tools/audit.mjs index` then `node tools/audit.mjs --json`, both
   with `--repo <worktree>`, using the **service's own checkout** of
   `tools/audit.mjs` — never a copy inside the worktree, which the agent could
   have edited. Exit 1 → job `failed`, worktree kept for inspection, no commit,
   no proposal.
6. Commit on the branch as `svc:ingest` with the requesting actor as co-author.
7. `ctx.governance.createFromJob(...)` → Proposal + Decisions from `runReport.blocked`.

Hooks (`bin/almagest.mjs hook <name>`, all fast, none needs the server running):

| Hook | Claude Code event | Does |
|---|---|---|
| `guard-wiki` | PreToolUse `Write\|Edit\|MultiEdit` | exit 2 (block) when the target is under `brain/wiki/` and the current branch is `main` — the mechanical half of non-negotiable 1 |
| `enqueue` | PostToolUse `Write` | target under `brain/raw/` → POST `/api/jobs`, or spool to `.almagest/spool/` when the server is down |
| `status` | SessionStart | print open proposals and decisions as context |

Plus `tools/hooks/pre-commit` — the harness-agnostic git hook (audit + main guard).
Plus `deploy/launchd/` and `deploy/systemd/` to keep `almagest serve` running.

## Connectors (WS2)

The service is an MCP **client**. For each connector it:

1. Connects to the named MCP server (stdio or Streamable HTTP; headers from
   `.mcp.json` with env expansion; OAuth 2.1 + PKCE for servers that need it,
   started by `almagest connectors login <id>`, tokens sealed in `store.kv`).
2. **Lists** items changed since the stored cursor, via the recipe.
3. **Fetches** each item and renders it to text with locator markers
   (`=== section: … ===`, `=== t hh:mm:ss ===` for transcripts, `=== row n ===`).
4. Stages the snapshot under `.almagest/connector-snapshots/<connector-id>/` and
   fingerprints it — sha256 of every snapshot byte (header included; the header
   holds nothing volatile) is the change detector. The runner copies it to
   `brain/raw/extracted/<connector-id>/<slug>.txt` in the job's worktree with
   `materialize()`, never on `main`. Provider `version` is an optimisation that
   lets step 3 skip fetching; it is never trusted on its own.
5. Returns a `SourceRef { kind: 'connector', … }` per new or changed item.

Recipes (`server/src/connectors/recipes/<name>.yaml`) are declarative: which tool
lists, which tool fetches, how to map results to `ref` / `version` / `title` /
text. Shipped: `mcp-resources` (generic — any server that exposes MCP resources
works with zero config), `github`, `gitlab`, `google-drive`, `granola`, `linear`,
`notion`, `slack`, `web-fetch`. `custom` lets a config entry inline its own
`list` / `fetch` mapping. `almagest connectors init <mcp>` inspects `tools/list`
and drafts a recipe for a human to review.

Manifest: a new `kind: connector` entry type — `connector`, `server`, `ref`,
`version`, `sha256` (of the snapshot), `path` and `extracted` (both the snapshot
path), `extracted_sha256` (same digest), optional `commit`, `snapshot`, `label`.
The audit's PROV and CITE-005 checks accept it, and CITE-005 additionally
re-hashes committed snapshots (WS2 owns those changes in `tools/lib/checks.mjs`
and `docs/manifest.md`). Full guide: `docs/v2/connectors.md`.

## Governance (WS3)

- **Proposal builder** — diff `baseSha..headSha` over `brain/wiki/`, parse both
  sides with `wiki-core`, compute claim-level changes and source excerpts, attach
  demand from `ctx.demand`, compute `required` from policy.
- **Policy engine** — profile defaults + `governance.rules`. Built-in, not
  configurable: `approvals >= 1` from a human; agents cannot approve; open
  decisions block merge; audit exit 1 blocks merge; canonical pages are never
  modified by a proposal.
- **Merge** — `git merge-tree --write-tree main <branch>` → `commit-tree` with
  two parents, author = approving actor, committer = `svc:governance` →
  re-audit the merge tree → move `main` by compare-and-swap (`update-ref` with
  the old value), or `merge --ff-only` inside a worktree that has `main` checked
  out. A conflict marks the proposal `conflicted` and enqueues a `revise` job.
  `log.md` gets the approval line. `push: true` pushes `main`.
- **Channels** (`governance/channels/<kind>.mjs`, interface
  `{ kind, notify(busEvent), routes?(http), canApprove }`):
  - `web` — the review inbox, server-rendered HTML at `/inbox`. Queue ordered by
    open decisions, then hot pages, then age. Per-proposal page: claim cards with
    source excerpts, per-page accept/reject, decision cards, approve / request
    changes. Also `/inbox/reverify` and `/inbox/gaps` (from WS5) and
    `/inbox/activity` (the audit log).
  - `mcp` — chat can list and explain proposals and ask to approve; the service
    answers with a confirmation link/code that a human must open in an
    authenticated web session. The chat never approves.
  - `slack` — notification with buttons; interactive endpoint verifies the
    Slack signature and maps the Slack user to an Actor by email.
  - `email` — digest with signed, single-use, expiring links into the web inbox.
  - `github-pr` — the v1 workflow: push the branch, open a PR, treat a merge
    webhook as the approval of the GitHub user who merged.

## Almagest MCP server (WS4)

Tools (all read-only except where noted, all recorded via `ctx.telemetry.record`):

| Tool | Does |
|---|---|
| `search` | BM25 over title, aliases, tags, body of `main`'s pages → ranked slugs + snippets |
| `get_page` | one page: frontmatter, body, sources, backlinks, citations resolved |
| `ask` | search + the relevant sections, packaged with the `read.md` citation rules so the chat answers in Almagest's citation format. No LLM call inside the server |
| `list_sources` | the manifest, filtered |
| `submit_source` | **write-safe**: enqueue an ingest of a URL, text or connector item. Creates a proposal, never touches `main` |
| `report_gap` | record a question the brain could not answer |
| `feedback` | the user says an answer was (not) useful → explicit demand signal |
| `list_proposals`, `get_proposal`, `request_approval` | governance via chat (`request_approval` returns a confirmation link) |

Resources: `almagest://page/{slug}`, `almagest://index`. Prompts: `answer-from-brain`.

Transports: stdio (`almagest mcp`) for a local clone; Streamable HTTP at `/mcp`
for remote use with no clone. `submit_source` enqueues with
`requestedBy: 'agent:mcp:<client>'` and an additional `onBehalfOf: <human id>`. HTTP auth: bearer token (solo) or OIDC JWT
validation (team/enterprise) with `/.well-known/oauth-protected-resource`
metadata so MCP clients discover the IdP. With `service.git.remote` set, the
service keeps its own clone under `.almagest/repo` and refreshes on an interval
and on `POST /hooks/git`.

## Telemetry and demand (WS5)

- `ctx.telemetry.record` appends Events; failures are logged, never thrown.
- **Demand score** per slug: Σ weight × 0.5^(age / half_life) over events —
  `get_page` 1.0, `ask` hit 0.6, `search` top-3 hit 0.3, `feedback` +2 / −1.
  Recomputed on an interval, cached in `store.kv`, published as `demand.updated`.
- **Hot** = top `hot_percentile` and ≥ `min_score`. Hot pages get stricter policy
  (WS3), a shorter re-verify threshold, and appear in `/inbox/reverify`.
- **Gaps** — `search`/`ask` calls with no result above threshold, plus
  `report_gap`, clustered by normalised token overlap → `/inbox/gaps` and
  `ctx.telemetry.gaps()`. A gap can be turned into a `submit_source` or a
  connector suggestion.
- **Audit integration** — the service exports `.almagest/demand.tsv`
  (gitignored; aggregates only, no query text). `tools/audit.mjs --demand <file>`
  enables two warnings: `DEMAND-001` hot page past `stale_after_days_hot`;
  `DEMAND-002` hot page with `confidence: low | unknown`. Without the flag the
  audit behaves exactly as v1.
- Retention: `store.events.prune` daily per `retention_days`. Raw events never
  enter git.
- **Explainability** — `ctx.telemetry.explain(slug)` returns the events and
  weights behind a score (top contributors, counts per tool, deduped events, the
  trend against the previous half-life window). Every demand effect — a stricter
  approval, a re-verify entry, a DEMAND-* warning — is traceable to events.
- HTTP (auth `any`): `GET /api/demand?top=N`, `GET /api/demand/:slug` (explain),
  `GET /api/gaps`, `GET /api/reverify`. CLI: `almagest demand [--top N]`,
  `almagest gaps`, `almagest reverify`. Long form, formula worked through,
  privacy guidance: `docs/v2/telemetry.md`.

## Testing

`node --test server/test/` with the memory store and the `fake` ingest driver.
Each workstream ships unit tests for its module and at least one test that goes
through `ctx` the way the composition root wires it. The end-to-end test (Phase
2) drives: file dropped → job → proposal → decision resolved → approve → merged
on `main` → `search` over MCP finds it → event recorded → demand updated.
