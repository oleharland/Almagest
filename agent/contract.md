# Harness contract

The minimum an agent harness must provide to run Almagest. "Model-agnostic" is
really harness-agnostic: the unit that has to hold the guarantees is harness +
model, not the model alone.

A harness that meets requirements 1-6 can run Almagest with every guarantee
intact. Requirements 7-9 are optional and each degrades in a stated way.

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
5. **An interactive human who can approve or reject in-session.** The approval
   gate — no page is created, edited, or deleted without an explicit "yes" in
   the same conversation — is the first non-negotiable and it assumes a human is
   there to say it. **A harness running unattended (CI, a cron job, a fully
   autonomous loop) MUST NOT run Almagest.** There is no auto-approve mode and
   adding one would remove the property the project exists to provide.
6. **Shell access sufficient to compute a sha256** — `shasum -a 256` or
   `sha256sum`. The manifest fingerprint is what makes re-ingest incremental and
   what stops an edited source from being silently treated as unchanged. A
   harness without shell cannot fingerprint, and filename matching is not a
   substitute.

   `shasum`/`sha256sum` is the only hard tooling dependency. Agents commonly
   reach for `rg` (ripgrep) when searching the wiki — Codex did on its first
   run here — and fall back to `grep` when it is absent. Installing ripgrep is
   worth it for speed on a large brain, but nothing requires it.

## Optional — degrades gracefully

7. **Path-scoped conditional rule loading** — the harness loads a rule file when
   a matching path is touched.
   *Without it:* the routing table in the always-on file does the same job by
   instruction rather than enforcement. Weaker, still correct. The agent must be
   told to read the rule file, and must actually do it before the operation.
8. **MCP client** — required only for remote sources.
   *Without it:* `sources.remote` in `brain.config.yaml` cannot be ingested.
   Local ingest from `brain/raw/` is unaffected, and every other guarantee holds.
9. **Mid-session model switching** — the harness can raise or lower the model
   per step.
   *Without it:* pick one model for the whole session, sized by the heaviest
   tier that session will hit. A session that touches any **judgment** step runs
   entirely on the judgment-tier model.

## Known-good harnesses

Tested means a full ingest and query cycle was run against this repo's rules and
the guarantees held. Everything else ships a shim that matches the harness's
documented loading mechanism but has not been verified end to end.

<!-- SHIM:BEGIN harness-table -->
| Harness | Rule loading | Reads | MCP config | Status |
|---------|-------------|-------|-----------|--------|
| Claude Code | strong — `.claude/rules/*.md` `paths:` | `CLAUDE.md`, `.claude/rules/*.md`, `brain/CLAUDE.md` | `.mcp.json` (shipped) | **Reference harness.** The rules and the benchmark harness were developed on it |
| Cursor | strong — `.cursor/rules/*.mdc` `globs:` | `.cursor/rules/*.mdc`, `AGENTS.md` | `.cursor/mcp.json` | **Untested.** Shim shipped |
| Codex | weak — `AGENTS.md` | `AGENTS.md`, root and nested | `~/.codex/config.toml`, varies by version | **Ingest proposal verified.** Given a source in `brain/raw/` and write permission with no human present, it read the rules, fingerprinted the source, proposed typed pages, flagged an open question, and stopped for approval without writing anything. The write half of the cycle, and query, are still unrun |
| Gemini CLI | weak — `GEMINI.md` | `GEMINI.md` | `~/.gemini/settings.json` | **Untested.** Shim shipped |
| Antigravity (`agy`) | weak — `AGENTS.md`. Whether it is auto-injected is unconfirmed | `AGENTS.md` | `agy mcp add` | **Rule loading verified.** It found and followed the routing table to `agent/rules/ingest.md`. It reported no project instructions in a scratch directory, so name the rule file in your first message. No ingest or query cycle has been run |
| Copilot | weak — `.github/copilot-instructions.md` | `.github/copilot-instructions.md` | editor-dependent | **Untested.** Shim shipped. Verify requirement 5 for the mode you run — an autonomous agent mode has no in-session approver |
| Amp, Jules, others reading `AGENTS.md` | weak — `AGENTS.md` | `AGENTS.md` | varies | **Untested.** Covered by the `AGENTS.md` shim |
<!-- SHIM:END harness-table -->

No harness in this table has been benchmarked against another. Cross-harness
numbers require the benchmark driver layer, and a run is only comparable to
another run made with the same driver capabilities.

## Adding a harness

<!-- SHIM:BEGIN adding-a-harness -->
1. **Check requirement 5 first.** No interactive approval, no Almagest. Stop
   here rather than at step 5.
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
   Then verify against the contract by hand: does it read the file, write a
   file, grep the wiki, shell out to `shasum`, and stop for approval?
   Add a row to the harness table in `agent/contract.md`, marked untested until
   a full ingest and query cycle has run on it.
6. **Optional — add a benchmark driver** at `benchmarks/drivers/<name>.sh` so
   you can compare it against the reference. Interface in
   `benchmarks/drivers/README.md`, comparability rules in
   [Benchmarks](benchmarks.md).
<!-- SHIM:END adding-a-harness -->
