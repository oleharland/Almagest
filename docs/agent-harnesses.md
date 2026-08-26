# Agent Harnesses

Almagest runs on any coding agent that meets [`agent/contract.md`](../agent/contract.md).

"Model-agnostic" undersells the problem. The unit that has to work is **harness +
model**: a strong model in a harness that cannot read repository instruction
files runs with none of Almagest's rules, and a strong model in a harness that
writes straight to `main` produces work nobody ever reads a diff of. Both are
harness properties, not model properties. The contract is written against
capabilities for that reason.

Claude Code is the reference harness — the one the framework was built in. Codex
has additionally been given a source file and write permission with no human
present: it read the rules, proposed pages, and stopped for approval without
writing anything. That run predates the branch model — it verified the old
in-session gate, not the branch-and-commit flow. Antigravity has been watched read the repo instructions and
follow the routing table, and nothing further. Every other harness on this page
is described from its documented behaviour.

## The contract

Full text in [`agent/contract.md`](../agent/contract.md). Required:

| # | Capability | Why Almagest needs it |
|---|-----------|----------------------|
| 1 | Reads repository instruction files — one always-on file at minimum | The rules are in the repo. An agent that never reads them operates with none of them. |
| 2 | Filesystem read within the repo | `brain/index.md`, `brain/manifest.yaml`, wiki pages, raw sources. |
| 3 | Filesystem write — create, edit, move | Ingest writes pages, updates the manifest, and moves originals into `brain/raw/processed/`. |
| 4 | Recursive search — glob by path, grep by content | Entity dedup, backlink checks, and the audit are searches, not lookups. |
| 5 | **A reviewer who merges** — the harness can branch and commit; it must not merge to `main` on its own | The review gate. Nothing else enforces it — see below. |
| 6 | Shell access sufficient to compute a sha256 | The manifest fingerprint is `shasum -a 256`. Without it, change detection falls back to filename, which is the bug the manifest exists to fix. |
| 7 | **Node 22+ on `PATH`** | `tools/audit.mjs` runs on it, and a failing audit blocks the commit. New hard dependency — see [The Node requirement](#the-node-requirement). |

Optional. Each degrades to something weaker but still correct:

| # | Capability | Without it |
|---|-----------|-----------|
| 8 | Path-scoped conditional rule loading | The routing table in the always-on file does the same job by instruction rather than enforcement. Weaker, still correct — and you have to tell the agent to read the rule file. See [Strong vs weak rule loading](#strong-vs-weak-rule-loading). |
| 9 | MCP client | No remote sources. `sources.remote` in `brain.config.yaml` is unusable; local ingest is unaffected. |
| 10 | Mid-session model switching | Pick one model for the whole session, sized for the heaviest tier that session will hit. For any ingest that is `judgment`. |

### Requirement 5 does not degrade

Almagest's first guarantee is that **nothing unreviewed lands**. The agent works
on an `ingest/<source-slug>-<sha7>` branch and commits there; `main` moves only
when a person merges a diff they have read. No rule file, no hook, and no config
flag enforces that last step, and there is no auto-merge mode.

This replaces the old gate — an in-session "yes" before every write. The reason
it changed is worth stating, because it reads at first like a loosening.

The old gate protected against *the agent writing without permission*. That was
never the dangerous failure. The dangerous failure is the agent writing
something **plausible and wrong**, and a human reading a terminal summary box at
11pm and typing `y`. A batch summary is the weakest review surface available: it
is the agent's own account of its own work, compressed by the same model that
did the work. A diff is the strongest surface there is, and this project has
been in git the whole time.

So the model moved from *presence* to *review*:

| | Old gate | Branch gate |
|---|---|---|
| What you look at | the agent's summary of its writes | the writes |
| When | mid-run, in a terminal | when you choose, in a diff viewer |
| Can you check a citation? | not without leaving the prompt | it is three lines up in the same diff |
| Can it run overnight? | no | yes, onto a branch |
| What reaches `main` | whatever `y` covered | only what you merged |

**Blocking cases still stop mid-run.** A diff review is a bad place to first
meet a contradiction, so these are never written to the branch at all:

| Situation | On the ingest branch |
|---|---|
| Evidence-tier additive page, audit clean | Lands automatically |
| Curated-tier new page or update, audit clean | Lands automatically |
| Contradiction with any existing page | **Blocks** — resolve in-session or leave unwritten |
| Contradicts a canonical page | **Blocks** — logged to `brain/canonical-challenges.md`, never merged silently |
| Deletion, merge, or rename of an existing page | **Blocks** |
| `confidence: low` on a curated page | **Blocks** |
| Any audit error (`tools/audit.mjs` exit `1`) | **Blocks the commit entirely** |

**What a harness must therefore be able to do:** create a branch, `git add`,
`git commit`. What it must *not* be able to do: push to `main`, merge its own
pull request, or run with a `--auto-merge` equivalent. A harness that writes
into a working tree on `main` fails this requirement — not because it wrote
without asking, but because there is then no diff for anyone to read.

**Nothing mechanically enforces that, and you should know why.** CI carries a
*Wiki write gate* job that looks for commits touching `brain/wiki/` on `main`'s
first-parent line with no merge above them. It is marked `continue-on-error` —
**advisory, never blocking** — because a squash merge produces byte-for-byte the
same shape as a direct push, so blocking on it would reject legitimate reviewed
merges. It will tell you that something looks like a direct write; it cannot
tell you that it was one. The real enforcement is branch protection on your
remote and not wiring your agent to merge. Configure both; the job is a
smoke alarm, not a lock.

Unattended runs are now supported, and this is what makes remote sources
([Remote Sources](remote-sources.md)) worth having: a nightly sync that ingests
onto a branch and leaves you a diff is a sync. One you have to sit and watch is
a manual ingest with extra network.

### The Node requirement

`tools/audit.mjs` needs **Node 22+**. This is a real new dependency — until now
`shasum` was the only hard tooling requirement, and the framework's bash-only
posture was a feature.

The trade, stated rather than hidden: the audit has to parse frontmatter and
wikilinks *exactly* the way the site does, or it will certify pages the site
then renders differently, and the audit becomes a second opinion instead of a
check. The alternative was a second parser in awk — two implementations of the
same grammar, drifting apart at their own pace. That is the precise failure
`tools/agent-shims.sh` exists to prevent, and importing it into the correctness
tool would have been perverse.

So there is one parser, and it is neither the audit's nor the site's:

```
tools/lib/wiki-core.mjs      ← the only implementation. Plain ESM,
        │                      Node builtins only, no package imports
        ├── tools/audit.mjs         imports it from bare Node 22
        └── site/src/lib/wiki.ts    a ~170-line typed wrapper. Adds types,
                                    site config, and the build-time link gate.
                                    Parses nothing.
```

Note the direction — the site wraps the core, not the reverse. It has to be
`.mjs` rather than `.ts` for exactly the reason this section exists: bare Node
22 will not import TypeScript, so a `.ts` core could not be the audit's loader
at all.

Scope, so the constraint is not over-read:

| Component | Runtime | Installs |
|-----------|---------|----------|
| `tools/audit.mjs`, CI | **Node 22+** | root `npm ci` |
| `site/` | Node 22+ (already true) | `site/` `npm ci` only — see below |
| `tools/lib/wiki-core.mjs` | Node 22+ | **nothing.** Node builtins only |
| `tools/agent-shims.sh` | bash + coreutils, unchanged | nothing |
| `benchmarks/` | bash + coreutils — the no-language-runtime constraint still holds there, deliberately | nothing |

**`cd site && npm install && npm run build` still works on a fresh clone, with
no root install.** That is a deliberate property, not an accident.
`wiki-core.mjs` sits above both package roots, so a bare `import 'gray-matter'`
inside it would resolve against the *repo* root and break exactly that command.
It therefore imports no packages at all: `gray-matter` and `marked` are passed
into `loadWiki` by whichever caller is running. The CI `site` job deliberately
skips the root `npm ci` so the property keeps being tested rather than merely
believed. If you extend the core, add a parameter — never an import.

If Node is unavailable in your environment, everything except the audit still
runs — but you lose the mechanical half of non-negotiables 2 and 4, and with it
the claim in this repo's tagline. Run the audit somewhere else (CI does) rather
than treating it as optional.

## Strong vs weak rule loading

Harnesses pick up repository rules in one of two ways.

| | Strong (path-scoped) | Weak (always-on) |
|---|---------------------|------------------|
| Mechanism | The rule file declares which paths it governs; the harness injects it when those paths are touched | One file, always in context |
| Declared as | Claude Code `paths:` frontmatter, Cursor `globs:` frontmatter | nothing — the file is simply always loaded |
| Files | `.claude/rules/*.md`, `.cursor/rules/*.mdc`, `brain/CLAUDE.md` | `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`, root `CLAUDE.md` |
| Ingest rules arrive | when the agent touches `brain/raw/**` | when the agent reads the routing table and decides to open the file |
| Failure mode | — | the agent works from the summary and never opens `agent/rules/ingest.md` |

A harness that reads nested `AGENTS.md` files sits between the two: `brain/AGENTS.md`
is a generated reader pointer, so opening anything under `brain/` brings the
query protocol with it — the same thing `brain/CLAUDE.md` does for Claude Code.
It covers reading only. Ingest and wiki writes still route by instruction.

### How the weak path degrades, exactly

On a weak harness the always-on file carries three things:

- the **routing table** — which rule file to read before which operation
- the **seven non-negotiables**, inline. They are short and too important to be
  a pointer.
- a line naming [`agent/contract.md`](../agent/contract.md)

It does not carry the rules themselves. Those stay in `agent/rules/`, in one
copy. A second copy drifts, and then you have two rulebooks that disagree — the
failure this whole design exists to prevent.

What you lose: **guaranteed loading**. Routing becomes an instruction, and an
instruction can be skipped when the context is long or the request is urgent.

What you keep: the correct rules, one copy of them, the same seven
non-negotiables in front of the agent at all times, and `tools/audit.mjs`
downstream of all of it — a page written without the rules usually fails a
check, and a failing check blocks the commit. The audit is not a substitute for
loading the rules, but it is a backstop the old design did not have.

Mitigations, in order of effectiveness:

1. Name the file in your first message: *"Read `agent/rules/ingest.md` in full
   before touching anything in `brain/raw/`."*
2. Check the first proposal against the rule file yourself. Once per harness is
   usually enough to tell whether it read it.
3. Read the branch diff before merging, and run `tools/audit.mjs` yourself if
   the run did not. A branch you do not merge costs nothing — `git branch -D` is
   the whole cleanup.

## Known-good harnesses

<!-- SHIM:BEGIN harness-table -->
| Harness | Rule loading | Reads | MCP config | Status |
|---------|-------------|-------|-----------|--------|
| Claude Code | strong — `.claude/rules/*.md` `paths:` | `CLAUDE.md`, `.claude/rules/*.md`, `brain/CLAUDE.md` | `.mcp.json` (shipped) | **Reference harness.** The rules and the benchmark harness were developed on it |
| Cursor | strong — `.cursor/rules/*.mdc` `globs:` | `.cursor/rules/*.mdc`, `AGENTS.md` | `.cursor/mcp.json` | **Untested.** Shim shipped |
| Codex | weak — `AGENTS.md` | `AGENTS.md`, root and nested | `~/.codex/config.toml`, varies by version | **Ingest proposal verified.** Given a source in `brain/raw/` and write permission with no human present, it read the rules, fingerprinted the source, proposed typed pages, flagged an open question, and stopped for approval without writing anything. Verified against the old in-session gate; the branch-and-commit half is unrun |
| Gemini CLI | weak — `GEMINI.md` | `GEMINI.md` | `~/.gemini/settings.json` | **Untested.** Shim shipped |
| Antigravity (`agy`) | weak — `AGENTS.md`. Whether it is auto-injected is unconfirmed | `AGENTS.md` | `agy mcp add` | **Rule loading verified.** It found and followed the routing table to `agent/rules/ingest.md`. It reported no project instructions in a scratch directory, so name the rule file in your first message. No ingest or query cycle has been run |
| Copilot | weak — `.github/copilot-instructions.md` | `.github/copilot-instructions.md` | editor-dependent | **Untested.** Shim shipped. Its autonomous PR agent is now a supported mode rather than a disqualification — it commits to a branch and a human merges. Confirm it is not configured to merge its own PR |
| Amp, Jules, others reading `AGENTS.md` | weak — `AGENTS.md` | `AGENTS.md` | varies | **Untested.** Covered by the `AGENTS.md` shim |
<!-- SHIM:END harness-table -->

The table above is generated from `agent/contract.md` by `tools/agent-shims.sh`.
Edit it there.

**Untested** means the shim files are generated and the setup below follows the
harness's published behaviour — no ingest has been run on it here. **Rule
loading verified** means one step further and no more: the harness was seen to
read the repo instructions and open the rule file the routing table named. It
says nothing about whether it then followed the rules. Treat the first ingest on
any row that is not the reference harness as a test: read the proposal against
`agent/rules/ingest.md` line by line before approving it.

## Per-harness setup

Four things are the same everywhere: generate the shims, set `agent.harness` in
`brain.config.yaml`, have Node 22+ on `PATH`, and let the agent work on a branch.

```bash
tools/agent-shims.sh generate
node --version          # must be >= 22
node tools/audit.mjs    # should exit 0 on a clean brain
```

Whatever the harness, the shape of a run is the same: it branches, writes,
audits, commits, and stops. You read `git diff main...ingest/<branch>` and merge.
Per-harness differences below are about rule loading and MCP, not about the gate
— the gate is git.

### Claude Code

`agent.harness: claude-code`. Start it in the repo root:

```bash
claude
```

Root `CLAUDE.md` loads always. `.claude/rules/brain-ingest.md` loads on
`brain/raw/**`, `.claude/rules/brain-wiki.md` on `brain/wiki/**`, and
`brain/CLAUDE.md` on `brain/` files. Each is a pointer; the agent reads through
to the canonical file in `agent/rules/`. MCP servers come from `.mcp.json` —
`/mcp` to approve them.

### Cursor

`agent.harness: cursor`. The generated `.cursor/rules/almagest-*.mdc` files
carry `globs:` frontmatter, so ingest and wiki rules load on path the same way
Claude Code's do. `AGENTS.md` is read as well and supplies the routing table.

MCP servers go in `.cursor/mcp.json` — the same two entries as `.mcp.json`,
under Cursor's own schema.

### Codex

`agent.harness: codex`. Weak loading: `AGENTS.md` is the file it picks up on its
own. Nested ones count — `brain/AGENTS.md` points at the query protocol, so
reading from the wiki is covered. Ingest and wiki writes are not: name the rule
file you want read in your first message.

```bash
codex
```

MCP servers are declared in `~/.codex/config.toml` under `[mcp_servers.<name>]`.

### Gemini CLI

`agent.harness: gemini-cli`. Weak loading via `GEMINI.md`.

```bash
gemini
```

MCP servers go in `~/.gemini/settings.json` under `mcpServers`.

### Antigravity

`agent.harness: antigravity`. Antigravity is Google's agentic IDE; its CLI is
`agy`, normally at `~/.local/bin/agy`. The `agentapi` binary under
`~/.gemini/antigravity-cli/bin/` is a wrapper that execs it.

**It is not the Gemini CLI.** Different binary, different flags, different
config, and a different benchmark driver — `--driver antigravity`, never
`gemini-cli`.

```bash
agy
```

Weak loading. It reads `AGENTS.md`; on this repo it found the routing table and
opened `agent/rules/ingest.md` from it. Whether the file is auto-injected is
unconfirmed — in a scratch directory holding a decoy `AGENTS.md` it reported
having no project instructions, which would mean it opens the file rather than
being handed it. Either way, name the rule file you want read in your first
message.

MCP servers are managed through the CLI rather than a config file you edit:
`agy mcp add`, `agy mcp list`. `agy models` prints the model names `--model`
accepts, which is what belongs in the `antigravity` profile in
`brain.config.yaml`. Run it — the names are not what you would guess. The
reasoning-effort suffix is part of the model name (`gemini-3.7-flash-low`,
`gemini-3.1-pro-high`), the list is per-account, and it is not Gemini-only: the
account this was verified against also offered `claude-sonnet-4-6`,
`claude-opus-4-6-thinking` and `gpt-oss-120b-medium`.

Three operational notes from running it here:

- **It reads your home directory on startup**, before touching the project —
  a global-config lookup. In `--print` mode that read hits the permission
  check first and aborts the run if denied.
- **Quota is enforced per account and the error is terminal**, not a retry:
  `Individual quota reached. Please upgrade your subscription to increase your
  limits. Resets in 5h42m40s.` A benchmark run will die mid-arm on it, so check
  headroom before starting one.
- **Latency is fine.** A trivial `--print` call returned in 26.5s wall, 8.8s of
  it agent time. The driver's default `--print-timeout` is generous because one
  sample proves little, not because it is known to be slow.

> **`--dangerously-skip-permissions` is now survivable, but not free.**
> Antigravity's non-interactive `--print` mode cannot run without it, and it
> auto-approves every read, write, and shell command for the whole call. Under
> the branch model that is a supported unattended run *provided* the branch is
> real: check out `ingest/<slug>-<sha7>` before invoking it, and never point it
> at a working tree on `main`. The flag removes the harness's own prompts; it
> does not remove the audit, the blocking cases, or your merge. What it does
> remove is any limit on what else it may touch in the repo — so give it a
> worktree, not your only checkout. The benchmark driver passes the flag against
> a disposable arena copy, which remains the safest pattern.

### Copilot

`agent.harness: copilot`. Weak loading via `.github/copilot-instructions.md`.

Both surfaces now qualify. The editor's agent mode proposes each edit to you.
The autonomous coding agent that runs on a pull request is, structurally,
exactly the branch model: it commits to a branch and a human merges the PR —
which is the gate, stated in GitHub's own vocabulary. Two things to confirm
before pointing it at `brain/`: that the repo does **not** have auto-merge
enabled for its PRs, and that the audit runs as a required status check so a
failing page cannot be merged.

Copilot also supports path-scoped `.github/instructions/*.instructions.md` files
with `applyTo:` frontmatter. Almagest does not generate them; adding them is a
[new harness case](#adding-a-harness) worth taking if you run Copilot as your
main harness.

> MCP transport support differs between harnesses and between versions of the
> same harness. The two servers Almagest ships (`.mcp.json`) are HTTP; if yours
> speaks stdio only, check its documentation before assuming remote sources
> work. Local ingest never needs MCP.

## Capability tiers

Rules files never name a model. They name one of two tiers.

| Tier | Work |
|------|------|
| `mechanical` | Parsing, hashing, slug and string comparison, structural checks, straightforward extraction. A cheaper model is enough. |
| `judgment` | Weighing which source is stronger, classifying a diff as addition / revision / removal, deciding whether two pages describe the same entity, reconciling manifest drift, cross-source synthesis, strategic questions. Anything producing a recommendation you will act on. |

Where they land:

| Operation | Tier |
|-----------|------|
| Audit — every check | `mechanical` |
| Ingest — fingerprinting, extraction, canonical validation, entity dedup | `mechanical` |
| Ingest — contradiction resolution, merge proposals, diff classification, drift repair | `judgment` |
| Query — factual lookup | `mechanical` |
| Query — cross-source synthesis, strategic questions | `judgment` |

The mapping from tier to model is per harness, in `brain.config.yaml` →
`agent.profiles[agent.harness]`:

```yaml
agent:
  harness: claude-code
  profiles:
    claude-code:
      mechanical: sonnet
      judgment: opus
    codex:
      mechanical: gpt-5-mini
      judgment: gpt-5
    # cursor, gemini-cli, copilot — see brain.config.yaml for the full set
    generic:
      mechanical: "<your fast model>"
      judgment: "<your strongest model>"
```

**Advisory, not dispatch.** Most harnesses cannot switch model mid-task. If
yours cannot, run the whole session on the model sized for the heaviest tier it
will hit — which for any ingest is `judgment`, because every ingest can turn up
a contradiction.

A harness not listed under `profiles` uses `generic`. Fill in your two model
names there rather than editing the rules.

## Regenerating the shims

The canonical rules live in `agent/rules/`, the routing table in
`agent/routing.md`, the seven non-negotiables in `brain/rules-index.md`, and the
harness table in `agent/contract.md`. Every harness-specific file is generated
from those four:

```bash
tools/agent-shims.sh generate   # write or refresh every shim
tools/agent-shims.sh check      # regenerate to a temp dir and diff; exit 1 on drift
```

Bash and coreutils only — no node, no python. That has not changed: the Node 22+
requirement is `tools/audit.mjs`'s, not the shim generator's. `generate` is
idempotent — running it twice produces identical bytes, so `check` is safe in a
pre-commit hook or CI, and it runs there alongside the audit.

Twelve files: eleven generated whole, plus this page, which is hand-written with
one spliced block.

| Generated file | Harness | Loading | Contains |
|---------------|---------|---------|----------|
| `CLAUDE.md` | Claude Code | weak | overview + routing table + non-negotiables |
| `AGENTS.md` | Codex, Antigravity, Amp, Jules, Cursor, others | weak | same |
| `GEMINI.md` | Gemini CLI | weak | same |
| `.github/copilot-instructions.md` | Copilot | weak | same |
| `brain/CLAUDE.md` | Claude Code | strong | pointer to `agent/rules/read.md` |
| `brain/AGENTS.md` | harnesses reading nested `AGENTS.md` | weak, `brain/`-local | pointer to `agent/rules/read.md` |
| `.claude/rules/brain-ingest.md` | Claude Code | strong, `paths:` | pointer to `agent/rules/ingest.md` |
| `.claude/rules/brain-wiki.md` | Claude Code | strong, `paths:` | pointer to `agent/rules/wiki.md` |
| `.cursor/rules/almagest-read.mdc` | Cursor | strong, `globs:` | pointer to `agent/rules/read.md` |
| `.cursor/rules/almagest-ingest.mdc` | Cursor | strong, `globs:` | pointer to `agent/rules/ingest.md` |
| `.cursor/rules/almagest-wiki.mdc` | Cursor | strong, `globs:` | pointer to `agent/rules/wiki.md` |
| `docs/agent-harnesses.md` | — | — | this page; only the `harness-table` block is generated |

Each fully generated file opens with:

```
<!-- GENERATED by tools/agent-shims.sh — do not edit. Edit agent/rules/*.md and regenerate. -->
```

`tools/agent-shims.sh check` diffs every file in that list, so a deleted shim
is drift rather than a silent pass.

To change a rule, edit `agent/rules/*.md` and regenerate. Editing a generated
file gets you a rule that exists on one harness and not the others, which is the
drift the pointer design is there to prevent.

## Adding a harness

<!-- SHIM:BEGIN adding-a-harness -->
1. **Check requirement 5 first.** It must be able to branch and commit, and it
   must not be able to merge to `main` unattended. If it writes straight to
   `main` with no review surface, stop here rather than at step 5.
2. **Find out how it loads repo instructions.** An always-on filename? Rule
   files with a frontmatter glob? If it has neither, it fails requirement 1 and
   there is nothing to add.
3. **Add it to the shim table in `agent/routing.md` and to the generator in
   `tools/agent-shims.sh`** — the routing-table template for a weak harness, the
   pointer template plus the harness's glob syntax for a strong one. Do not
   write rule content into either.
4. **Add a profile** under `agent.profiles` in `brain.config.yaml` naming its
   `mechanical` and `judgment` models, and set `agent.harness`.
5. **Regenerate and verify** — `tools/agent-shims.sh generate`, then `check`.
   Then verify against the contract by hand: does it read the file, create a
   branch, write a file, grep the wiki, shell out to `shasum`, run
   `tools/audit.mjs`, and stop on a blocking case instead of committing it?
   Add a row to the harness table in `agent/contract.md`, marked untested until
   a full ingest and query cycle has run on it.
6. **Optional — add a benchmark driver** at `benchmarks/drivers/<name>.sh` so
   you can compare it against the reference. Interface in
   `benchmarks/drivers/README.md`, comparability rules in
   [Benchmarks](benchmarks.md).
<!-- SHIM:END adding-a-harness -->

Generated from `agent/contract.md`. Edit it there.

## What is actually tested

| Claim | Evidence |
|-------|----------|
| The rules work on Claude Code | The framework was built and run there |
| The shims are generated correctly | `tools/agent-shims.sh check` — mechanical, verifies bytes, says nothing about behaviour |
| Harness X reads file Y | That harness's own documentation |
| The approval gate holds on Codex | One run against the **old** in-session gate: source in `brain/raw/`, `--sandbox workspace-write`, no interactive approver. It proposed five pages and wrote zero bytes. One observation, one model, one source — and it says nothing about the branch model that replaced it |
| Codex writes pages correctly once approved | **Nothing.** The write half was never exercised |
| Any harness branches, audits, and commits correctly | **Nothing.** The branch model is unexercised on every harness in the table |
| A failing audit blocks a commit | The exit code is mechanical and CI enforces it. Whether an agent honours it mid-session is unmeasured |
| Any harness ingests correctly end to end | **Nothing.** Not measured here |

No benchmark results are published for any harness, including Claude Code — see
[Benchmarks](benchmarks.md). The harness exists; the numbers are yours to
produce. A cross-harness comparison is the one thing that would turn the
untested rows of the table above into measured ones.
