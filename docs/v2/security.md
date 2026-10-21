# Security model and status

What the v2 service promises, what enforces each promise, and — stated plainly —
where the promise does not hold. Read this before you run the service
anywhere other people, or other people's chats, can reach it.

## The promise

**Nothing reaches `brain/wiki/` on `main` unless a human with an approver role
approved the exact version (headSha) they were shown.** Agents — the headless
ingest agent and every chat connected over MCP — can never approve. No profile
and no setting relaxes this.

## What enforces it

| Layer | Mechanism | Where |
|---|---|---|
| Who can approve | `assertCanApprove`: only `kind: human` with reviewer / owner / admin | `server/src/core/auth.mjs` |
| How they sign in | In token mode an API token never opens a browser session: sign-in uses a separate secret (`ALMAGEST_LOGINS`) or a one-time link (`almagest login <name>`), and a sign-in secret is never accepted as a bearer token. The sign-in form needs a same-origin request | `server/src/core/auth.mjs`, `governance/sessions.mjs` |
| How they approve | Every review action needs a signed-in browser session + CSRF token; bearer tokens on `/api` are read-only; the service re-checks through a vouch kept outside the actor object. Slack and GitHub act only through their own signed requests | `server/src/governance/trust.mjs`, `channels/web.mjs` |
| Whether their roles are current | A session's roles must have been confirmed within `session_roles_max_age_minutes` (60; enterprise 30) to act; Slack and GitHub use the roles from the last inbox sign-in only within `channel_roles_max_age_hours` (24; enterprise 8); at merge time each approval counts with the lesser of its recorded and the person's current roles, so a demotion voids it | `governance/service.mjs`, `identity.mjs`, `policy.mjs` |
| What they approve | Approvals are pinned to `headSha`; a stale or missing one is refused (409 / 400); any new commit voids earlier approvals; chat confirmation links open the full review page, never a one-click button | `server/src/governance/service.mjs` |
| Who counts | One person = one approver: ids are linked by email in an identity registry; separation of duties sees through second ids | `server/src/governance/identity.mjs`, `policy.mjs` |
| What can merge | Only knowledge-base paths (`brain/wiki/*.md`, `.txt` sidecars, bookkeeping files, `brain/.index/*.tsv`); no dotfiles, symlinks, executables, submodules, or agent instruction files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, `SKILL.md`, `*.mdc`, `.claude/` … in any letter case) — checked by the runner, when the proposal is built, in policy, and again inside the merge. The inbox shows the content of every non-wiki file | `server/src/governance/paths.mjs`, `merge.mjs`, `ingest/runner.mjs` |
| The gate itself | One `verifyCandidate` for every new `main`: path check, then the audit from the service's own checkout on the merge result; exit 1 blocks | `server/src/governance/merge.mjs`, `ingest/audit.mjs` |
| Merges on GitHub | Almagest stays the gate for its own `main`. A merged pull request moves local `main` only when policy is met for the GitHub user who merged (mapped, current roles, separation of duties), the merged head is the reviewed one, the merge commit's parents are exactly (local `main`, reviewed head), and `verifyCandidate` passes. Otherwise the proposal becomes `merged_unaccepted` with the reason and `main` stays put. Pull requests from forks are ignored | `governance/channels/github-pr.mjs`, `service.mjs` → `recordExternalMerge`, `merge.mjs` → `acceptExternal` |
| What chats read | The MCP server serves a snapshot of local `main` only, never the remote's | `server/src/core/snapshot.mjs` |
| The ingest agent | No git, network or MCP tools; writes confined to `brain/`; the audit is an exact-command wrapper outside the worktree; `ALMAGEST_*` and other secrets stripped from its environment; source content declared untrusted | `server/src/ingest/drivers/`, `runner.mjs` |
| The runner after the agent | Never trusts the worktree's `.git` file: the git dir is resolved from the repository, the `.git` file must be byte-identical to what the runner created, every git call passes `--git-dir`/`--work-tree` with fsmonitor and hooks off and inherited `GIT_*` dropped, and the commit must land on the job's branch with `main` untouched | `server/src/core/git.mjs`, `ingest/runner.mjs` |
| Interactive agent sessions | `guard-wiki` (Write/Edit) blocks wiki changes on `main` and any write into `.git/`; `guard-git` (Bash) blocks wiki changes on `main` and, on any branch, every command that moves `main` without a commit; the `reference-transaction` hook refuses a wiki-changing move of `main` from an agent environment; `pre-commit` runs the audit. The checked-in `.claude/settings.json` no longer pre-allows interpreters, `cp`/`mv`, branch-moving git commands or `curl` to the inbox | `server/src/ingest/hooks.mjs`, `guard-git.mjs`, `tools/hooks/`, `tools/lib/git-hooks.mjs`, `.claude/settings.json` |
| Configuration | Your approval rules are added to the profile's, never instead of them (unless you set `inherit_profile_rules: false`, which warns at startup); `enterprise` without OIDC refuses to start; `serve` fails fast without a local `main` | `server/src/core/config.mjs`, `app.mjs` |

## Status

Three independent reviews ran against this branch — an exploit-driven security
review, an end-to-end QA run on the real service, and a second security review
after the fix round. Every finding they raised has a fix in code with a
regression test; what remains is below.

| Profile | Approval bypass over the service | Approval bypass through local git |
|---|---|---|
| **enterprise** (OIDC, `require_sso_for_approval`) | Closed | Closed for agent tools; see the limit below |
| **team** (OIDC) | Closed | Same as enterprise |
| **solo** (static roles, sign-in secret) | Closed, if chats and hooks get API tokens only (they cannot sign in) | Same as enterprise |

### Known limits

1. **An unrestricted shell can always reach `.git`.** The guards cover the
   commands an agent is *normally given* and the `reference-transaction` hook
   covers git itself, but a process that can run arbitrary code as you can edit
   `.git/` or `tools/hooks/` directly, unset its environment markers, or read
   `ALMAGEST_SECRET_KEY` and the SQLite store. Only OS-level separation closes
   that: run the service as a different user, in a container, or on another
   machine. Protect `main` on your git host as defence in depth.
2. **Under SSO a demotion is seen at the person's next sign-in**, because the
   identity provider is not asked in between. The role max ages bound how long
   that takes (an hour for a browser session by default, a day for Slack and
   GitHub; 30 minutes and 8 hours under `enterprise`).
3. **A `merged_unaccepted` proposal is resolved by hand.** There is no reconcile
   button yet. Squash and rebase merges on GitHub are never accepted locally,
   because their result cannot be checked against the reviewed head — use merge
   commits on a repository that feeds Almagest.
4. **The hooks need an absolute `core.hooksPath`.** With a relative path git
   misses the hooks of a push into the repository. `doctor` reports a missing,
   relative or non-executable hook setup.

Lower-severity items from the reviews (identity links that cannot be undone
after a wrong mapping, `submit_source` without a rate limit, one API response
that still includes a staging path) are tracked and fail safe.

## Hardening checklist

- [ ] `git config core.hooksPath "$PWD/tools/hooks"` (absolute) in every clone
- [ ] Branch protection on `main` at your git host (required reviews, merge commits, no force push)
- [ ] `ALMAGEST_SECRET_KEY` set, and different per deployment
- [ ] Token mode: approvers sign in with `ALMAGEST_LOGINS` or `almagest login`; chats and hooks get API tokens — `contributor` or `viewer` where you can
- [ ] `service.http.base_url` is HTTPS for anything beyond `localhost`
- [ ] team / enterprise: OIDC, `require_sso_for_approval: true`, `separation_of_duties: true`
- [ ] `ingest.driver: claude-code` (not `shell`) for unattended ingest
- [ ] Unattended ingest or untrusted sources: run the service as its own OS user or in a container
- [ ] `node server/bin/almagest.mjs doctor` is clean
