# Background ingest

Drop a file into `brain/raw/` and walk away. The service notices it, works out
whether it is new, ingests it on its own branch in its own git worktree, checks
the result with the audit, commits it, and puts a proposal in the review inbox.
Nothing reaches `main` until a person approves the diff.

This is `server/src/ingest/`. The contract is
[spec.md → Background ingest](spec.md#background-ingest); this page is how
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
were added beyond the core spec.

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

  # ── beyond the core spec ─────────────────────────────────────────────────────────
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
| `reverify` | Re-check a page (telemetry `auto_reverify`) against its sidecars | new `ingest/reverify-<slug>-<sha7 of main>`, or a proposal's |
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
governance through `ctx`, never from a request body. MCP `submit_source`
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
| `hook guard-wiki` | PreToolUse `Write\|Edit\|MultiEdit` | Exit 2 (block, reason on stderr) when the target is under `<brain_dir>/wiki/` of a checkout on `main`, or inside a git directory anywhere (a `.git` path segment, or the repository's git dir as git reports it). Any other situation — including the hook's own errors — allows. A guard that blocks on its own bugs gets uninstalled |
| `hook guard-git` | PreToolUse `Bash` | The same rule for shell commands. On `main`, blocks `git commit` (staged changes, plus unstaged ones for `-a` / pathspecs), `git merge`, `git cherry-pick`, `git revert`, `git am` and `git stash pop\|apply` when they would bring `brain/wiki/` changes in, and plain writes into `brain/wiki/` (`>`, `cp`, `mv`, `tee`, `sed -i`, `rm`). On any branch, blocks every command that moves `refs/heads/<main>` without a commit: `checkout -B` / `switch -C`, `branch -f\|-m\|-M\|-c\|-C\|-d\|-D` naming main, `update-ref` (and `update-ref --stdin`), `symbolic-ref`, `worktree add -B`, `fetch`/`pull` refspecs whose destination is main, `push` to a local repository (`.`, a path, or a remote whose URL is one) that writes main, `rebase … main`, `filter-branch`; and, while on main, `reset <commit>`, `rebase`, `commit --amend` and `pull`. Also on any branch: `--no-verify`, `commit -n`, `-c core.hooksPath=…` / `-c include.path=…`, config handed through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_PARAMETERS`, and `git config` writes to `core.hooksPath`, any `almagest.*` key, `include.path` / `includeIf.*`, `remote.<name>.url` and `url.<base>.insteadOf` (plus `--edit` and section removal of those); `git remote add` / `set-url` and a `fetch` / `pull` straight from a URL; any write inside `.git/` — `.git/almagest/hooks/` included, also from a linked worktree — by `>`, `cp`, `mv` (source or target), `tee`, `ln`, `rm`, `chmod` and the like (except removing a `*.lock`); clearing an agent-environment variable (`env -u`, `env -i`, `unset`, `VAR=`) in a command that runs git, the Almagest CLI or `npm run serve`; and `almagest login` in any form (`node server/bin/almagest.mjs login`, `npx almagest login`, inside `bash -c`). Follows `cd`, `git -C` and an earlier `git switch main` in the same command. Allows what it cannot parse (`bash -c`, scripts, here-docs), with one narrow exception: text naming `refs/heads/<main>`, `.git/refs` or `packed-refs` that it cannot account for (an interpreter, a nested shell, a git alias, `xargs`, a here-doc) is blocked. The git hooks below are the backstop |
| `hook enqueue` | PostToolUse `Write` | A new file in the drop folder → `POST /api/jobs` (with `ALMAGEST_TOKEN` if set, base URL from `service.http` or `ALMAGEST_URL`), else a spool file. Ignores `processed/`, `extracted/`, `.almagest/`, and anything written by the runner's own agent (`ALMAGEST_RUNNER=1`) |
| `hook status` | SessionStart | One line of context — open proposals and decisions — when the service is up; nothing when it is not. Needs `ALMAGEST_TOKEN` (any role — it only reads), and finds the service at `ALMAGEST_URL`, else `ALMAGEST_PORT`/`PORT`, else `service.http` |

None of them needs the app: no database, no worktree, no network beyond one
short request.

The checked-in permissions match: `node` is pre-approved only for
`tools/audit.mjs`, `tools/lib/selftest.mjs` and the read-only CLI subcommands
(`almagest help`, `doctor`, `hooks check`, `jobs`, `proposals`, `gaps`,
`connectors list`) — not `login`, `serve`, `ingest`, `hooks install`, `demand`
or `reverify` (both recompute which pages are hot), or anything that syncs,
sends or approves; nothing that runs arbitrary code is pre-approved (`python3`,
`npx tsx`, `xargs`, `cp`, `mv` and `curl` to the local service all ask);
`git push` asks every time, and of `git remote` only `git remote -v` is
pre-approved. `git branch`, `git checkout` and `git switch` are pre-approved only
in read-only or ingest-branch form (`git branch --list`, `--show-current`,
`git switch -c ingest/*`, `git checkout -b ingest/*`). Denied outright:
`git commit --no-verify`, `git commit -n`, `git push --no-verify`,
`git -c core.hooksPath…`, `git config [--unset] core.hooksPath`,
`git remote add|set-url`, `almagest login`, `almagest hooks install`,
`git update-ref`, `git checkout -B`, `git switch -C` / `--force-create`,
`git branch -f` / `--force` / `-M` / `-C`, `git reset --soft|--mixed|--keep|--hard`,
and any `curl` to `…inbox/login…`. Permission rules match command text only —
`/usr/bin/git` or a wrapper slips past them — which is why the hooks exist.

These hooks bind Claude Code's tool calls only. A person typing in their own
terminal is not affected, on purpose: a human merging a reviewed diff is the
gate.

**Every clone, every harness, every person: install the git hooks.** They are
the guards that see every commit and every ref update, whatever made it.

```bash
node server/bin/almagest.mjs hooks install    # in your own terminal; it refuses in an agent session
```

The hooks git runs are **not** `tools/hooks/` in the working tree. A checkout
replaces every tracked file with the branch's copy, so a hook run from the
working tree is whichever one the checked-out branch ships — and a branch can
ship a pre-commit that clears the agent variables and moves main itself.
`hooks install` (`installHooks` in `tools/lib/git-hooks.mjs`) instead:

- reads each hook **as committed on `main`** (`git cat-file blob
  main:tools/hooks/<hook>`, with `git replace` stand-ins ignored), never the
  working tree;
- bakes in the main branch name and `brain_dir` from main's committed
  `brain.config.yaml` (the `MAIN_BRANCH="…"` / `BRAIN_DIR="…"` lines); the
  working-tree config names the branch, but install refuses when main's own
  committed config disagrees. The agent-variable list is already in main's copy;
- writes them to `<git-common-dir>/almagest/hooks/`, executable (replacing, not
  following, a symlink planted there), and sets `core.hooksPath` to that
  absolute directory — shared by every worktree of the clone, and resolved
  for a push into the repository too.

Run it again whenever main's `tools/hooks/` or `brain_dir` changes: until then
the installed copy is outdated. `hooksInstalled(repoRoot)` (re-exported from
`server/src/ingest/hooks.mjs`; `almagest doctor` and `almagest hooks check`
print it) reports a `core.hooksPath` that is unset or anything other than that
directory, a hook that is missing, not executable, or not byte-identical to
what install would write from main now ("outdated").

The pre-commit hook refuses a commit on `main` that touches
`brain/wiki/`, and audits any commit that touches `brain/` or
`brain.config.yaml` — against the **staged** tree (`git checkout-index` into a
temp dir), so an unstaged fix cannot pass a staged mistake. Exit 1 blocks. The
service's own commits use `--no-verify`: they are on ingest branches and have
just passed the same audit. The audit it runs is the working tree's
`tools/audit.mjs` — a deliberate choice, explained in the hook: it gates only
the branch it runs on, main is protected by reference-transaction and by the
service's own re-audit, and a copy from main would still import
`node_modules/`, which a checkout can overwrite (git treats ignored files as
expendable). So code a branch ships does run in pre-commit, as it does under
`npm run check` — see the residual risk below.

The reference-transaction hook (git 2.28+) is the backstop for the
moves that make no commit: `branch -f`, `checkout -B`, `reset`, `update-ref`,
`fetch . x:main`, `push . x:main`, a fast-forward. In the `prepared` state it
refuses an update of `refs/heads/<main>` when the environment is an agent's
**and** the update changes `<brain_dir>/wiki/` (the old and new trees for that
directory differ) or deletes main. An agent environment is any of
`CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CODEX_SANDBOX`,
`CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_MANAGED_BY_NPM`, `CODEX_THREAD_ID`,
`GEMINI_CLI`, `CURSOR_AGENT`, `OPENCODE`, `AI_AGENT`, `ALMAGEST_RUNNER`, or
`ALMAGEST_AGENT` (set it yourself for any other harness). Configuration
variables a person exports in their own shell (`CLAUDE_CODE_USE_BEDROCK`,
`CODEX_HOME`) are deliberately not markers. A person's own terminal carries
none of these variables, so a human merge goes through. Code-only moves of main
also go through. The installed copy reads nothing a branch controls: the main
branch name (and `main` itself) and `brain_dir` are baked in; besides those it
compares only the `brain_dir` each side of the update commits to, which can add
directories to check but never remove one. Editing the working-tree
`brain.config.yaml` or `tools/hooks/` changes nothing.

The service moves main in `governance/merge.mjs` (`merge --ff-only`, else
`update-ref`). Normally it runs under launchd, systemd, Docker or a person's
terminal, so it carries no agent variable. If it was started from inside an
agent session it does, so just before the compare-and-swap it writes
`<old> <new> refs/heads/<main>` to `.git/almagest/main-move`
(`authorizeMainMove`) and removes the file afterwards. The hook accepts exactly
that transition while the file is under five minutes old. The file is not a
secret. It binds one audited, approved transition, and it lives where
`guard-wiki` and `guard-git` refuse every write.

**Residual risk, stated plainly.** An agent with an unrestricted shell and no
Claude Code guards (or one that gets past them) can always edit `.git/`
directly. It can rewrite `.git/refs/heads/main` or `packed-refs`, forge
`main-move`, unset `core.hooksPath`, or edit `.git/almagest/hooks/` itself. It
can also strip its own environment (`env -i`) or re-parent a process so that no
marker is left — from a script it wrote, from a branch's `tools/audit.mjs` that
pre-commit runs, or from any `npm run` script. No in-repository check survives an adversary with write access to the
repository. Only OS-level separation closes this: the agent runs as a user, or
in a container, that cannot write the repository's git directory, and only the
service's user can. The hooks raise the bar and catch honest mistakes and
ordinary tool calls. The review gate and the service's re-audit before merging
are what the core promise rests on.

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
`ALMAGEST_*` (sign-in tokens, the sealing key), `DATABASE_URL`, `PG*`,
`SLACK_*`, `GITHUB_TOKEN`/`GITLAB_TOKEN`, and every variable a config `*_env`
key names. It keeps what the CLI needs to authenticate to its model provider.

**What is checked after it finishes, by code it could not edit:**

1. The worktree's `.git` file is still byte-for-byte what git wrote (see
   *Git in the worktree* below). Anything else fails the job, uncommitted.
2. The run report exists and validates; its sha256 equals the runner's.
3. The path guard: the files changed — the diff from the branch head the
   worktree was reset to, to the working tree, plus untracked files — are all
   in the writable set governance enforces on the branch
   (`governance/paths.mjs`, one definition for both): `brain/wiki/<slug>.md`,
   `.txt` sidecars and snapshots under `brain/raw/extracted/`, text under
   `brain/raw/processed/`, `brain/.index/*.tsv`, `index.md`, the manifest,
   `log.md` and the challenges ledger. Not `brain.config.yaml` (which would let
   it relax the audit), not `tools/`, `agent/`, the shims, no dotfile, and no
   agent instruction file anywhere — `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`,
   `SKILL.md`, `*.mdc`, `.claude/` and the rest (governance → *Only
   knowledge-base files*). The one exception is the original the runner itself
   placed in the drop folder, while it still holds the runner's bytes. No
   canonical page changed.
4. The audit — the **service's** `tools/audit.mjs` against the worktree, never
   the worktree's copy. Exit 1: nothing is committed.
5. `.almagest/` is removed from the worktree before the commit, whatever
   `.gitignore` says.
6. After the commit: it is the head of the job's `ingest/…` branch, the
   worktree is still on that branch, and neither `main` nor the main
   checkout's branch moved to include it or any commit of this job. (`main`
   moving because someone merged another proposal meanwhile is logged, not a
   failure.)

**Git in the worktree.** The agent can write every file in its worktree,
including `.git`, the one-line pointer to the git dir. Rewritten to
`gitdir: ../../../.git` (possible when `worktree_dir` is inside the repo),
`git add -A && git commit` there would commit to the main checkout's branch,
usually `main`, with no proposal; pointed at a fake git dir, its config could
name a `core.fsmonitor` program that git runs as the service user. So the
runner never lets git read that file. When it prepares a worktree it finds the
worktree's admin dir (`<common-dir>/worktrees/<name>`) from the repo root —
`git rev-parse --git-common-dir`, `git worktree list --porcelain` and the admin
dirs' own back-pointers — checks `.git` is a regular file pointing there, and
records its bytes. Every git command after that, before and after the agent,
first checks `.git` is unchanged, then runs with `--git-dir=<admin dir>
--work-tree=<worktree> -c core.fsmonitor=false -c core.hooksPath=/dev/null`
and without inherited `GIT_*` variables (only remote-transport ones and
`GIT_CONFIG_GLOBAL` are kept). A changed `.git` fails the job, not retried,
with what the file now says in the error; the worktree is kept as evidence, and
the next job on that branch fails the same way until a person looks.

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
- After a merge, the file you dropped stays untracked in your checkout's
  `brain/raw/`: the runner ingests a copy in its own worktree, and the move to
  `processed/` happens on the branch, not in your folder. The watcher skips it
  as unchanged; deleting it is yours, and until you do `git status` lists it.
- `hook enqueue` and a person ingesting the same file by hand in an interactive
  session will both run; the interactive session wins only if it reaches the
  branch first. Turn the hook off for manual-ingest sessions if that matters.
