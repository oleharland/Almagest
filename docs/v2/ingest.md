# Background ingest

Drop a file into `brain/raw/` and walk away. The service notices it, works out
whether it is new, ingests it on its own branch in its own git worktree, checks
the result with the audit, commits it, and puts a proposal in the review inbox.
Nothing reaches `main` until a person approves the diff.

This is `server/src/ingest/` (WS1). The contract is
[spec.md → Background ingest](spec.md#background-ingest-ws1); this page is how
to run it and what it guarantees.

```
 brain/raw/ drop ─┐
 connector sync  ─┼─▶ enqueue ─▶ queue ─▶ runner ─────────────────────────────────▶ proposal
 hook / spool    ─┤   (dedup)    (claim,   1 worktree on ingest/<slug>-<sha7>          (review
 almagest ingest ─┤              retry,    2 place source (sha256 re-checked)           inbox)
 MCP submit_source┘              timeout)  3 agent (locked-down driver)
                                           4 run report ✓ → move original → path guard ✓
                                           5 audit ✓ (service's own tools/audit.mjs)
                                           6 commit as svc:ingest, requester co-author
                                           7 ctx.governance.createFromJob
```

## Running it

```bash
npm install                                  # once, at the repo root (workspaces include server/)
node server/bin/almagest.mjs serve           # inbox + MCP + API + background ingest
node server/bin/almagest.mjs serve --no-http # background ingest only
```

To keep it running: `deploy/launchd/com.almagest.serve.plist` (macOS) or
`deploy/systemd/almagest.service` (Linux). Each file says how to install itself.
Containers: `deploy/docker/`.

By hand:

```bash
node server/bin/almagest.mjs ingest brain/raw/q3-board-deck.pdf          # queue it
node server/bin/almagest.mjs ingest brain/raw/q3-board-deck.pdf --wait   # queue it and run it here
node server/bin/almagest.mjs jobs                                       # recent jobs
node server/bin/almagest.mjs jobs job_01m5…                             # one job, as JSON
```

Every job writes `.almagest/logs/<jobId>.log`: each runner step, the agent's
own output, the audit's findings. The validated run report is kept at
`.almagest/reports/<jobId>.json`.

## Configuration

All optional; these are the defaults. The first block is the spec's; the rest
are WS1 additions.

```yaml
ingest:
  driver: claude-code            # claude-code | shell | codex | gemini-cli | antigravity | fake
  model_tier: judgment           # resolved through agent.profiles[<driver>]
  # model: opus                  # explicit model; wins over model_tier
  concurrency: 1                 # worker loops; jobs on one branch never overlap
  budget_usd_per_job: 5          # passed to the driver as a hard cap where it can enforce one
  timeout_minutes: 30            # the agent's process group is killed at this point
  watch_raw: true                # fs.watch the drop folder + scan it on start
  max_attempts: 2                # retryable failures only (see below)

  # ── WS1 additions ─────────────────────────────────────────────────────────
  extra_tools: []                # extra allowlist entries for the agent, e.g.
                                 #   ["Bash(pdftotext:*)", "Bash(pandoc:*)"]
  cli: claude                    # the Claude Code binary (claude-code driver)
  shell:
    command: ""                  # shell driver: a script name in benchmarks/drivers/ or a path
    cli: ""                      # passed to the script as ALM_CLI
  allow_unrestricted_driver: false   # see "Security posture" — leave false
  watch_debounce_ms: 750         # per-file quiet period before a watched file is considered
  watch_stable_ms: 1000          # size+mtime must hold this long (downloads in progress)
  watch_rescan_seconds: 60       # safety-net rescan under fs.watch (0 = off); unchanged files are not re-hashed
  spool_interval_seconds: 15     # how often the hook spool is drained (0 = on start only)
  poll_ms: 2000                  # idle workers re-check the store (jobs enqueued by another process)
  manual_rate_per_hour: 30       # POST /api/jobs per actor per hour (0 = no limit)
```

`model_tier` resolves through the profile of the harness the **driver** runs,
not `agent.harness`: an instance whose IDE is Codex can still ingest in the
background with Claude Code, and a Codex model name would break it.

## Jobs

| Kind | What it does | Branch |
|---|---|---|
| `ingest` | A new or changed source | new `ingest/<source-slug>-<sha7>` |
| `revise` | Apply a decision's `effect` or a reviewer's requested changes | the proposal's |
| `reverify` | Re-check a page (WS5 `auto_reverify`) against its sidecars | new `ingest/reverify-<slug>-<sha7 of main>`, or a proposal's |
| `drop-page` | Undo one page on a proposal — mechanical, no agent | the proposal's |

Status: `queued → running → succeeded | blocked | failed | cancelled`.
`blocked` means the run produced decisions and nothing else. A run with nothing
to review — the agent found the source unchanged, or there was no diff and no
decision — succeeds with no proposal, and the empty branch it made is deleted.

**Retries.** A failure is retried (up to `max_attempts`) when it is the kind of
thing that flakes: the driver crashed or timed out, the run report was missing
or invalid, a proposal could not be loaded. A failure the runner *found* is not
retried — the audit failed, the agent wrote outside `brain/`, it touched a
canonical page, the fingerprint did not match — because running the same agent
again on the same input is a way of spending money until the gate gives up. The
worktree is left as the agent left it, for a person to look at; the next job on
that branch resets it.

**Dedup.** Same bytes, same kind, already queued or running → the existing job.
A connector that re-lists an item every 15 minutes while its proposal is under
review does not spawn a job per tick. Two decisions resolved back to back fold
into one queued `revise` with both instructions. Details: spec → Job.

**Shutdown.** `SIGTERM` aborts running agents and returns their jobs to the
queue without counting the attempt; a job left `running` by a crashed process on
this host is re-queued on the next start.

## Triggers

**Watch.** `fs.watch` (recursive) on `sources.local.path`, plus a scan of it on
start for anything dropped while the service was down, and a rescan every
`watch_rescan_seconds` because fs.watch (FSEvents especially) can miss a change
made under load. Ignored: `processed/`,
`extracted/`, dotfiles, `.gitkeep`, READMEs, partial downloads (`.crdownload`,
`.part`, `~`). A file is considered once its size and mtime hold still for
`watch_stable_ms`; it is then hashed, and **skipped when `main`'s manifest
already records that sha256** (rule 5 — read from the snapshot of `main`, not
from whatever the checkout has open) or when those bytes already had a job.
Re-noticing the same bytes never retries a failed job; `almagest ingest` does.

**Schedule.** Each connector with a `schedule` (five-field cron, local time,
Vixie day-of-month/day-of-week OR semantics, `@hourly`-style macros) gets
`ctx.connectors.sync(id)` when it fires; every returned SourceRef becomes one
job. A connector whose last sync is still running is skipped, not stacked.

**Spool.** `.almagest/spool/*.json`, written by `hook enqueue` when the service
is not listening, drained on start and every `spool_interval_seconds`. A bad
entry is renamed `.failed` and left for a person.

**API and MCP.** `POST /api/jobs` needs a `contributor` role or above
(viewers get 403) and takes `{ path }` — a file under the drop folder or
`.almagest/submissions/`, nothing else — or `{ source: { kind: "connector",
connector, ref } }`. A connector source is a pointer only: the service looks the
item up in what a sync recorded and builds the SourceRef itself; a
client-supplied `path`, `staged`, `sha256`, `title`, `change` or `supersedes` is
ignored, since all of them reach the agent's prompt and the sha256 is the
fingerprint only the service may compute. An item that was never synced is a
400. Each actor may enqueue `ingest.manual_rate_per_hour` jobs an hour (429
after that; the `enqueue` hook falls back to the spool). `GET /api/jobs` and
`GET /api/jobs/:id` need any authenticated actor; `job.error` never quotes the
run report or the model's output. The API only ever enqueues `ingest` — `revise` and
`drop-page` carry instructions the agent is told to trust, so they come from
governance through `ctx`, never from a request body. MCP `submit_source` (WS4)
writes into `.almagest/submissions/` and enqueues a local source from there,
with `onBehalfOf` the human; that person co-authors the commit.

## Drivers

A driver turns a prompt into an agent run in a directory, and nothing else: it
never commits, never runs the gating audit, never decides whether its own output
is acceptable.

| Driver | Runs | Notes |
|---|---|---|
| `claude-code` | `claude -p` | The reference. Locked-down flag set below; refuses to run if the installed CLI lacks any flag the sandbox depends on |
| `shell` | any script speaking the [benchmarks/drivers](../../benchmarks/drivers/README.md) protocol | Gets `ALM_PROMPT`, `ALM_SYSTEM`, `ALM_MODEL`, `ALM_TOOLS`, `ALM_BUDGET_USD`, plus `ALM_MODE=ingest` and `ALM_CWD`. Refused when it reports `tool_restriction no` |
| `codex` · `gemini-cli` · `antigravity` | `shell` with `benchmarks/drivers/<name>.sh` | **Read the caveat below** |
| `fake` | nothing | Deterministic stand-in for tests (`ingest.fake.mode`) |

Caveat: the benchmark scripts were written for a read-only benchmark. They run
their CLIs read-only (`codex --sandbox read-only`, Claude `--safe-mode` with a
read allowlist), and the Codex and Antigravity ones cannot restrict tools at
all. A read-only agent cannot write pages, so the job fails loudly on the
missing run report; an unrestricted one is refused before it starts. To ingest
with another harness, write a wrapper script that runs it write-capable inside
`ALM_CWD` and holds it to `ALM_TOOLS`, and point `ingest.shell.command` at it.

## The prompt and the agent's rules

The agent is pointed at the rules in its worktree — `CLAUDE.md`,
`agent/rules/ingest.md` (including **Runner mode** at the end) and
`agent/rules/wiki.md` — not handed a paraphrase. The prompt carries only what
the runner knows: the SourceRef, the sha256 the service computed (which the
agent must use), the connector `change` / `supersedes`, the previous version of
a changed source, the branch, the proposal, any instructions, and the exact
audit command it may self-check with. The system prompt states that source
content is untrusted data.

The agent never stops to ask. Every case the risk-tier table says *blocks* is
left unwritten and recorded in `blocked[]` of `.almagest/run-report.json`;
governance turns each into a Decision card, and resolving one enqueues a
`revise` with the chosen option's `effect`.

## Hooks

Claude Code, wired in `.claude/settings.json`:

| Hook | Event | Does |
|---|---|---|
| `hook guard-wiki` | PreToolUse `Write\|Edit\|MultiEdit` | Exit 2 (block, reason on stderr) when the target is under `<brain_dir>/wiki/` of a checkout on `main`. Any other situation — including the hook's own errors — allows. A guard that blocks on its own bugs gets uninstalled |
| `hook guard-git` | PreToolUse `Bash` | The same rule for shell commands. On `main`, blocks `git commit` (staged changes, plus unstaged ones for `-a` / pathspecs), `git merge`, `git cherry-pick`, `git revert`, `git am` and `git stash pop\|apply` when they would bring `brain/wiki/` changes in, and plain writes into `brain/wiki/` (`>`, `cp`, `mv`, `tee`, `sed -i`, `rm`). On any branch, blocks `--no-verify`, `commit -n` and `-c core.hooksPath=…`, which skip the pre-commit audit. Follows `cd`, `git -C` and an earlier `git switch main` in the same command. Allows what it cannot parse (`bash -c`, scripts, here-docs) — the git hook below is the backstop |
| `hook enqueue` | PostToolUse `Write` | A new file in the drop folder → `POST /api/jobs` (with `ALMAGEST_TOKEN` if set, base URL from `service.http` or `ALMAGEST_URL`), else a spool file. Ignores `processed/`, `extracted/`, `.almagest/`, and anything written by the runner's own agent (`ALMAGEST_RUNNER=1`) |
| `hook status` | SessionStart | One line of context — open proposals and decisions — when the service is up; nothing when it is not |

None of them needs the app: no database, no worktree, no network beyond one
short request.

The checked-in permissions match: `node` is pre-approved only for
`tools/audit.mjs`, `tools/lib/selftest.mjs` and `server/bin/almagest.mjs`;
`git push` asks every time; `git commit --no-verify`, `git commit -n`,
`git push --no-verify`, `git -c core.hooksPath…` and `git update-ref` are
denied outright. `git commit` and `git checkout` stay pre-approved, because the
v1 flow commits on ingest branches — `guard-git` is what stops them on `main`.

These hooks bind Claude Code's tool calls only. A person typing in their own
terminal is not affected, on purpose: a human merging a reviewed diff is the
gate.

**Every clone, every harness, every person: install the git hook.** It is the
one guard that sees every commit, whatever made it.

```bash
git config core.hooksPath tools/hooks
```

`tools/hooks/pre-commit` refuses a commit on `main` that touches
`brain/wiki/`, and audits any commit that touches `brain/` or
`brain.config.yaml` — against the **staged** tree (`git checkout-index` into a
temp dir), so an unstaged fix cannot pass a staged mistake. Exit 1 blocks. The
service's own commits use `--no-verify`: they are on ingest branches and have
just passed the same audit.

## Security posture of the unattended agent

The agent reads content nobody vetted — a PDF from a vendor, a Slack export, a
web page through a connector — with nobody watching. A source can contain text
written to manipulate it. The design does not rely on the model resisting that.
It relies on the agent having nothing dangerous to do it with, and on mechanical
checks after it finishes.

**What the agent can do** (claude-code driver, flags verified against Claude
Code 2.1.x):

- Read, Write, Edit, Glob, Grep — confined to the worktree (`--restricted`).
- Bash for exactly: `shasum`, `sha256sum`, `wc`, and two exact commands —
  `<state>/runner/<jobId>/audit` and the same followed by `index` — plus
  `ingest.extra_tools`. That wrapper is a script the runner writes outside the
  worktree for each job: it ignores every argument but a leading `index`, pins
  `--repo` to the worktree and `--config` to a copy of the config taken before
  the agent ran, clears `NODE_OPTIONS`, and is hash-checked after the run (a
  changed wrapper fails the job). The raw `tools/audit.mjs` is not allowlisted:
  its `--repo`, `--config` and `--index-dir` flags would read and write
  anywhere. The runner's own gating audit never goes through the wrapper.
- Nothing else is allowed, and nothing waits for a human to allow it:
  `--permission-mode dontAsk --permission-prompts none`. Claude Code itself
  auto-approves a few read-only built-ins inside the working directory (`ls`
  was observed); they cannot leave it.

**What it cannot do:** run git (also named in `--disallowedTools`); reach the
network (no WebFetch/WebSearch, `curl`/`wget`/`ssh`/`nc` denied); use any MCP
server (`--strict-mcp-config` with an empty config); read or write outside the
worktree; load your user settings, CLAUDE.md, skills, plugins or hooks
(`--restricted --safe-mode`); spend past `budget_usd_per_job`; run past
`timeout_minutes`; keep anything between runs (`--no-session-persistence`).
Manual smoke tests of this exact flag set (haiku, about $0.006 in all) saw
`Write`, `shasum` and the two wrapper commands allowed, and `git status`,
`cat /etc/hosts`, `curl`, `node -e`, a Read of `/etc/hosts`, a Write to `../`,
`<wrapper> --repo /`, `<wrapper> $(id)`, a redirect into the wrapper's
directory and a Read of the wrapper itself all denied.

**What it never holds:** the service's secrets. The child environment drops
`ALMAGEST_*` (approval tokens, the sealing key), `DATABASE_URL`, `PG*`,
`SLACK_*`, `GITHUB_TOKEN`/`GITLAB_TOKEN`, and every variable a config `*_env`
key names. It keeps what the CLI needs to authenticate to its model provider.

**What is checked after it finishes, by code it could not edit:**

1. The run report exists and validates; its sha256 equals the runner's.
2. The path guard: only `brain/wiki/`, `brain/raw/`, `brain/.index/`,
   `index.md`, the manifest, `log.md` and `canonical-challenges.md` changed —
   not `brain.config.yaml` (which would let it relax the audit), not `tools/`,
   `agent/`, `CLAUDE.md` or the shims. No canonical page changed.
3. The audit — the **service's** `tools/audit.mjs` against the worktree, never
   the worktree's copy. Exit 1: nothing is committed.
4. `.almagest/` is removed from the worktree before the commit, whatever
   `.gitignore` says.

**And then a person reads the diff.** All of the above makes a proposal safe to
look at, not correct. Approval is human-only, in code, with no flag to change it
(spec → non-negotiables).

`allow_unrestricted_driver: true` lets a driver that cannot enforce the
allowlist run anyway. It exists for a disposable container with no credentials
and no network. On a laptop with your SSH keys and your cloud login, it is the
one setting that turns "the source is untrusted" back into a sentence in a
prompt.

## Limits, stated plainly

- Branch locking and job dedup are per process. Two `serve` processes on one
  sqlite file never run the same job (`claim` is atomic), but can run two jobs
  on one branch at once. Run one service per brain.
- The audit runs on the whole worktree. If `main` already fails the audit,
  every ingest fails until it is fixed — on purpose: a branch that does not pass
  is not a reviewable diff.
- After a merge, a binary original stays untracked in your checkout's
  `brain/raw/` (processed binaries are gitignored). The watcher skips it as
  unchanged; deleting it is yours.
- `hook enqueue` and a person ingesting the same file by hand in an interactive
  session will both run; the interactive session wins only if it reaches the
  branch first. Turn the hook off for manual-ingest sessions if that matters.
