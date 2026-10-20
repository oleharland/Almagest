# Harness contract

The minimum an agent harness must provide to run Almagest. "Model-agnostic" is
really harness-agnostic: the unit that has to hold the guarantees is harness +
model, not the model alone.

A harness that meets requirements 1-7 can run Almagest with every guarantee
intact. Requirements 8-10 are optional and each degrades in a stated way.

## Required

1. **Reads repository instruction files** — at least one always-on file loaded
   at the start of every session. Almagest ships four equivalents:
   `CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `.github/copilot-instructions.md`.
   All four carry the same routing table. A harness that reads none of them has
   no way to learn the rules exist.
2. **Filesystem read** within the repository — `brain/`, `agent/`,
   `brain.config.yaml`.
3. **Filesystem write** — create, edit, and move files. Ingest moves sources
   into `brain/raw/processed/`; `git mv` is preferred but not required.
4. **Recursive search** — glob by path and grep by content. Entity dedup and
   backlink checks read the whole wiki, not one named file.
5. **A reviewer who merges.** The agent works on an `ingest/<source-slug>-<sha7>`
   branch and commits there. Nothing reaches `main` except through a human
   reading the diff and merging it. **Unattended ingest onto a branch is
   permitted and supported. An unattended merge to `main` is forbidden, and
   there is no flag for it.** The harness must therefore be able to create a
   branch and commit to it — `git checkout -b`, `git add`, `git commit` — and
   must not be wired to push or merge to `main` on its own.

   What changed, and why: the old gate was an in-session "yes" before every
   write. That protected against the agent *writing without permission*, which
   was never the dangerous failure. The dangerous failure is the agent writing
   something plausible and wrong while a human reads a terminal summary box at
   11pm and types `y`. A batch summary is the weakest review surface available —
   it is the agent's own account of its own work. A diff is the strongest, and
   this project is already in git. The property being sold is *nothing
   unreviewed lands*, not *a human was present*.

   Risk tiers still stop the agent mid-session, on the branch, for the cases a
   diff review is a bad place to discover:

   | Situation | On the ingest branch |
   |---|---|
   | Evidence-tier additive page, audit clean | Lands automatically |
   | Curated-tier new page or update, audit clean | Lands automatically |
   | Contradiction with any existing page | **Blocks** — resolve in-session or leave unwritten |
   | Contradicts a canonical page | **Blocks** — logged to `brain/canonical-challenges.md`, never merged silently |
   | Deletion, merge, or rename of an existing page | **Blocks** |
   | `confidence: low` on a curated page | **Blocks** |
   | Any audit error (`tools/audit.mjs` exit `1`) | **Blocks the commit entirely** |

   **With the v2 service** (`server/`, `docs/v2/governance.md`), "a human
   merging a reviewed diff" may happen through the review inbox or any
   configured approval channel — web, chat confirmation link, Slack, email, or
   a merged GitHub PR. A human with a reviewer role approves the exact version
   (headSha) shown to them; a new commit on the branch voids that approval; the
   service re-runs the audit on the merge result and merges under the
   approver's identity. Agents — the ingest agent and every chat connected over
   MCP — can never approve. That is enforced in code, and there is no setting
   for it. The service does not weaken this requirement; it moves the review
   surface from a diff to the claims-and-sources view the diff encodes.

   A harness with no interactive human still runs: it does the additive work,
   commits it to the branch, and leaves every blocking case unwritten with the
   reason in the run summary. A harness that cannot make a branch fails this
   requirement — writing straight to a working tree on `main` has no review
   surface at all.
6. **Shell access sufficient to compute a sha256** — `shasum -a 256` or
   `sha256sum`. The manifest fingerprint is what makes re-ingest incremental and
   what stops an edited source from being silently treated as unchanged. A
   harness without shell cannot fingerprint, and filename matching is not a
   substitute.

   Agents commonly reach for `rg` (ripgrep) when searching the wiki — Codex did
   on its first run here — and fall back to `grep` when it is absent. Installing
   ripgrep is worth it for speed on a large brain, but nothing requires it.
7. **Node 22+ on `PATH`** — `tools/audit.mjs` runs on it. This is a hard
   dependency, and a new one: `shasum` used to be the only tool Almagest
   required.

   The trade, stated plainly. The audit needs to parse frontmatter and
   wikilinks exactly the way the site does, or it certifies pages the site then
   renders differently. There is therefore exactly one parser,
   `tools/lib/wiki-core.mjs` — plain ESM, Node builtins only. `tools/audit.mjs`
   imports it directly, and `site/src/lib/wiki.ts` is a thin typed wrapper
   around the same file that parses nothing of its own. It has to be `.mjs` and
   not `.ts` precisely because bare Node 22 will not import TypeScript, which is
   what fixes the direction of the dependency: the site wraps the core, not the
   other way round.

   The alternative was reimplementing that parser in awk and owning two
   implementations that drift apart — which is the precise failure
   `tools/agent-shims.sh` exists to prevent, and it would be perverse to
   introduce it in the tool whose job is checking correctness.

   `wiki-core.mjs` imports no packages. `gray-matter` and `marked` are
   **injected by the caller** — passed to `loadWiki` — because a bare import
   from `tools/lib/` resolves against the repo root, and that would make
   `cd site && npm install && npm run build` fail on a clone that had never run
   the root install. If you extend the core, add a parameter; do not add an
   import.

   Scope: this applies to `tools/audit.mjs` and to `site/`. It does **not**
   apply to `tools/agent-shims.sh` (bash and coreutils, unchanged) or to
   `benchmarks/`, which keeps its no-language-runtime constraint so a benchmark
   can be run on a machine that has nothing installed.

## Optional — degrades gracefully

8. **Path-scoped conditional rule loading** — the harness loads a rule file when
   a matching path is touched.
   *Without it:* the routing table in the always-on file does the same job by
   instruction rather than enforcement. Weaker, still correct. The agent must be
   told to read the rule file, and must actually do it before the operation.
9. **MCP client** — required only for remote sources.
   *Without it:* `sources.remote` in `brain.config.yaml` cannot be ingested.
   Local ingest from `brain/raw/` is unaffected, and every other guarantee holds.
10. **Mid-session model switching** — the harness can raise or lower the model
    per step.
    *Without it:* pick one model for the whole session, sized by the heaviest
    tier that session will hit. A session that touches any **judgment** step runs
    entirely on the judgment-tier model.

## What requirement 5 unlocks

Remote sources (`sources.remote`, GitHub/GitLab over MCP) were the feature the
old gate quietly broke. A sync you have to sit and babysit is not a sync — it is
a manual ingest with extra network. Under the branch model a scheduled job can
poll a repo, ingest what changed onto `ingest/<slug>-<sha7>`, run the audit, and
open a diff for you to read on Monday. Same guarantees, because the guarantee
was never "a human watched it happen" — it was "nothing unreviewed landed".

## Known-good harnesses

Tested means a full ingest and query cycle was run against this repo's rules and
the guarantees held. Everything else ships a shim that matches the harness's
documented loading mechanism but has not been verified end to end.

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

No harness in this table has been benchmarked against another. Cross-harness
numbers require the benchmark driver layer, and a run is only comparable to
another run made with the same driver capabilities.

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
