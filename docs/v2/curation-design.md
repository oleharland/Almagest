# Curation: choosing a tier in the inbox, and learnings the brain proposes

Status: both parts are built. The document covers two gaps seen in the first
real run of the service. It describes what the code does; where the code
differs from the first design, this text follows the code. User-facing
description: [governance.md](governance.md), sections Tiers in the inbox and
Learnings. Operator description: [ingest.md](ingest.md), section Learnings.

## The two gaps

1. **No way to make something canonical from the inbox.** A page became
   canonical only when a person added its slug to `canonical_pages` in
   `brain.config.yaml` by hand, through git. The reviewer who reads a proposal
   and thinks "this is a definition everything else depends on" has nowhere to
   say so.
2. **The brain never draws a conclusion.** Every proposal comes from one
   source. As pages accumulate, nothing looks across them for a pattern, a
   repeated claim or a disagreement. The audit checks each page mechanically
   and cannot do this.

## Part 1: choosing a tier in the inbox

### What a tier is today

| Tier | Meaning | Who changes it |
|---|---|---|
| `canonical` | Locked definitions. Other pages must agree with them | A person, by hand, in git |
| `curated` | Assessed knowledge someone will rely on | The agent proposes, a person approves |
| `evidence` | What a source says | The agent proposes, a person approves |

Canonical is recorded in one place: the `canonical_pages` list in
`brain.config.yaml`. The service is not allowed to change that file. The merge
path check (`server/src/governance/paths.mjs`) refuses any commit that touches
anything outside the knowledge base's own files, and the runner refuses a run
that changed a canonical page (`server/src/ingest/runner.mjs`).

### Decided: people set canonical in the inbox

The owner decided on 2026-11-18 that canonical information is set by people in
the front end. For that, the record has to live where the service may write:

- A page is canonical when its slug is in `canonical_pages` (as today) **or**
  when its frontmatter on `main` says `tier: canonical`.
- Only a promotion made by a person in the inbox can set `tier: canonical`. An
  agent's branch that sets it on any page is refused by the runner, the same
  way a change to a canonical page is refused today.
- `brain.config.yaml` stays untouchable. The list in it keeps working for
  pages a team wants locked from the first commit.

Everything that reads the canonical set (the runner's guard, the merge check,
`changes[].canonical` on a proposal, the audit, lookup's canonical pass) reads
both sources through one function.

### Three places a reviewer meets the choice

| Where | What the reviewer sees | What happens |
|---|---|---|
| A page in an open proposal | A tier control beside the page: evidence, curated, canonical. It starts on what the agent wrote | Changing it is a human edit to the proposal. The service adds one commit on the branch that changes only the `tier:` line, authored by the reviewer and committed by the service, after its own audit passes. The reviewed version moves, and earlier approvals no longer count |
| A suggestion in the inbox | A list of pages many documents point at, each with its counts: "30 documents contributed to this page" | The reviewer makes it canonical or dismisses the suggestion |
| A page already on `main` | "Make canonical", "Make curated" and "Make evidence" on the page's entry (`/inbox/pages/<slug>`) | The service opens a small proposal authored by that person on `ingest/tier_<slug>-<sha7>` that changes only the `tier:` line. It goes through the normal gate: policy, audit, merge, log row. If the person's own approval meets the policy it is recorded at once |

Before the reviewer confirms canonical, the inbox says what it means in plain
words: the agent can no longer change this page, new material that contradicts
it is logged as a challenge and not merged, and only a person can edit it.

### Where the hint comes from

The hint is mechanical and always shown with its numbers. The main signal is
the one the owner named: many documents saying the same thing.

| Signal | How it is counted | Example shown to the reviewer |
|---|---|---|
| Documents behind the page | Distinct sources in `brain/manifest.yaml` whose `pages` include the slug | "30 documents contributed to this page" |
| Pages that depend on it | Backlinks from other pages, which the shared parser already computes | "12 other pages link here" |
| How much it is read | Its place in the demand ranking, when telemetry is on | "Among the most read pages this month" |

A page is suggested when the first count reaches a threshold
(`governance.canonical_hint.min_sources`, default 5), or the second reaches
its own (`min_backlinks`, default 8). A hot page lowers both thresholds by a
fixed factor. A page that is already canonical, a `claim` page and a template
page are never suggested.

The suggestions appear as a list in the inbox ("Pages worth fixing as
canonical"), each with its counts and two actions: make it canonical, or
dismiss. A dismissed suggestion comes back only when the page's document count
has grown by half again since it was dismissed.

The agent takes no part in this version. It does not suggest a tier.

### Rules it must keep

- Non-negotiable 4 is unchanged: an agent cannot propose a change to a
  canonical page. Suggesting that a page become canonical is not a change to
  one.
- Promotion and demotion need a role the policy names (`governance.canonical_role`).
  The default is `owner`, the same role the `enterprise` profile already
  requires to settle a canonical conflict. A tier proposal that moves a page to
  or from canonical also needs an approver with that role. Changing between
  evidence and curated needs the role that can approve the proposal.
- Only a person in a signed-in browser session, in the web inbox, can change a
  tier. Agents, API and MCP tokens, the chat confirmation, Slack, email and
  GitHub cannot. A commit merged outside the service may not make a page
  canonical or change a canonical page.
- A promotion is a commit through the merge gate, attributed to the person,
  logged in `brain/log.md`. No approval is skipped.
- Demotion (canonical to curated) is the same flow and the same role. Open
  challenges against the page stay in the ledger.

### What changes in the code

| File | Change |
|---|---|
| `tools/lib/config.mjs`, `tools/lib/wiki-core.mjs` | One function for "the canonical set": config list plus pages on `main` with `tier: canonical` |
| `tools/audit.mjs` | Use that function wherever it reads the canonical set. The audit cannot tell who set a tier, so the runner guard is what stops an agent setting it |
| `server/src/ingest/runner.mjs` | Refuse a run whose branch sets `tier: canonical` on a page that is not canonical on `main` |
| `tools/lib/canonical.mjs` (new), `server/src/governance/canonical.mjs` (new) | The one definition, and reading it from `main` in git |
| `server/src/governance/hints.mjs` (new) | Count documents, backlinks and demand per page; decide which pages to suggest; remember dismissals (store namespace `canonical-hints.dismissed`) |
| `server/src/governance/service.mjs`, `merge.mjs` | `setPageTier`, `proposeTier`, `dismissHint`; the merge verifies a tier proposal is exactly one `tier:` line and refuses an unchosen or external promotion |
| `server/src/governance/policy.mjs`, `core/config.mjs`, `core/auth.mjs` | `governance.canonical_role` (default `owner`), `assertCanChangeTier`, the role a tier proposal needs from its approver |
| `server/src/governance/web/views.mjs`, `channels/web.mjs` | The tier control, the suggestions list, the explanation, the actions |
| `agent/rules/wiki.md`, `agent/rules/ingest.md` | How a page becomes canonical now, and that the agent never sets it |

## Part 2: learnings the brain proposes

### What a learning is

The schema already has the page for it: a `claim` page with `origin: self`. Its
title is a sentence, it carries no inline citations and no `sources` of its own,
its body is at most 8000 characters, and its `## Basis` section links to the
`origin: source` pages it rests on. The audit checks that a Basis
exists and is made of wikilinks (`CITE-006`). What is missing is anything that
writes one.

### A new job kind: `synthesize`

| | |
|---|---|
| Trigger | After a merge, once at least N source pages were added or changed on `main` since the last run (default 5). Also on a cron expression that runs the same check, and by hand with `almagest synthesize` (`--force` skips only the threshold) |
| Default | On (`synthesis.enabled: true`), decided by the owner on 2026-11-18. The caps below bound what it costs |
| What the agent reads | The wiki on `main`, nothing else. No new source |
| What it may write | Up to a capped number of `claim` pages (default 5) on `ingest/learnings_<sha7 of main>`, and the index, log and derived index rows they need, added only at the end of their tables. Nothing else |
| How it ends | A proposal labelled as learnings. Each claim can be accepted or turned down on its own, which the inbox already supports per page |

What counts as a learning, written into the rules the agent follows:

- It rests on at least two `origin: source` pages that come from different
  sources. One page restated is not a learning. Two source entries count as one
  source when they share an id or a sha256.
- Its Basis never consists of other claim pages alone. The runner counts only
  the `origin: source` pages in it, so a link to a claim page beside two source
  pages is allowed.
- It says something none of its Basis pages says alone: a pattern, a
  comparison, a consequence.
- It carries a `confidence`, and `low` blocks, as for any curated page.

### Disagreements between pages

The same pass is where cross-page contradictions surface. The mechanical audit
cannot see that two pages disagree. When the agent finds two reviewed pages
that contradict each other, it writes no claim about it. It reports a
`contradiction` decision that quotes both, with their sources, for a person to
settle. That is the existing decision card.

### Two mechanical checks that become useful as content grows

Both are plain comparisons, so they belong in `tools/audit.mjs`, as warnings:

| ID | Fires when | Why |
|---|---|---|
| `DUP-001` | Two pages share a title or an alias | The same subject written twice. Seen in the first run, where several sources described the same product |
| `BASIS-001` | A claim page's Basis page was modified after the claim's `last_verified` | The conclusion may no longer follow. Feeds the re-verify queue |

### Rules it must keep

- A learning is a proposal like any other. Nothing reaches `main` without a
  person approving it.
- The job cannot touch a canonical page, cannot edit an existing page and
  cannot add a source. The runner's path guard enforces it: for this job kind
  the only allowed change is new `claim` pages and the bookkeeping files, and
  the bookkeeping files (`index.md`, `log.md`) may only gain whole lines. A
  learning is refused when it has a `sources` list, a citation or a body over
  8000 characters. The inbox shows each learning whole, so a person approves
  what they have read.
- No loops and no floods. The code enforces these bounds, in this order:
  `synthesis.enabled`; one `synthesize` job queued or running; no new run while
  a learnings proposal is open; `max_runs_per_day` runs per UTC day counted from
  the jobs in the store and claimed in the store before queueing, so two
  processes cannot both pass the cap; the changed-pages threshold. A merged learnings
  proposal never starts a run: it adds claim pages, which are not source pages,
  and its merge is skipped. The cap per run is `max_claims`. There is no
  separate dollar cap: the existing `ingest.budget_usd_per_job` applies to the
  job, and `max_runs_per_day` bounds the number of jobs.
- A learning a person turned down is remembered by its Basis set, its title and
  the sha256 of each Basis page. The runner refuses a new page on exactly that
  Basis set while every one of those pages is unchanged.
- With anonymization on, the job runs under the same rules as ingest.

### What changes in the code

| File | Change |
|---|---|
| `server/src/core/schemas.mjs` | Job kind `synthesize`, trigger `synthesis` |
| `server/src/ingest/prompt.mjs`, `agent/rules/ingest.md` | The task text and the rules above (Runner mode, Learnings) |
| `server/src/ingest/runner.mjs` | `guardLearnings`: new claim pages and bookkeeping only, with the Basis checks. Also applied to a revise of a learnings proposal |
| `server/src/ingest/synthesis.mjs` (new) | The trigger and the bounds: count changed source pages on merge, the cron, the last-run marker, the caps |
| `server/src/ingest/index.mjs` | Starts and stops the trigger; `almagest synthesize` is registered here with the other ingest commands |
| `server/src/governance/learnings.mjs` (new) | Reads a learning's Basis; the store of turned-down learnings; the checks on hidden characters, front matter limits and where rows may be added |
| `server/src/governance/service.mjs`, `summary.mjs`, `web/views.mjs` | `kind: 'learnings'`, the title, the explanation, the Basis links, remembering what was turned down |
| `tools/lib/checks.mjs`, `docs/audit.md` | `DUP-001`, `BASIS-001` |

## Build order

1. `DUP-001` and `BASIS-001`. Small, mechanical, useful at once.
2. The canonical set read from page frontmatter, with the runner guard. No
   interface yet; it makes the rest possible.
3. The tier control and the two actions in the inbox.
4. The suggestions list.
5. The `synthesize` job, on by default.

## Decisions

Settled by the owner on 2026-11-18:

- People set canonical in the inbox, so `tier: canonical` on a page on `main`
  defines canonical alongside the config list.
- The hint is how many documents say the same thing.
- The brain proposes learnings on its own, on by default.

Still open, with the default this design uses until told otherwise:

1. Which role may promote. Default: `owner`.
2. The thresholds for a suggestion. Defaults: 5 documents or 8 backlinks.
3. How often synthesis runs and what it may cost per day. Defaults: after 5
   changed pages, at most one run a day, at most 5 learnings a run.
