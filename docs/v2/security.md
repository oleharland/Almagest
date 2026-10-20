# Security model and status

What the v2 service promises, what enforces each promise, and — stated plainly —
where the promise does not hold yet. Read this before you run the service
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
| How they approve | Every review action needs a signed-in browser session + CSRF token; bearer tokens on `/api` are read-only; the service re-checks through a vouch kept outside the actor object. Slack and GitHub act only through their own signed requests | `server/src/governance/trust.mjs`, `channels/web.mjs` |
| What they approve | Approvals are pinned to `headSha`; a stale or missing one is refused (409 / 400); any new commit voids earlier approvals; chat confirmation links open the full review page, never a one-click button | `server/src/governance/service.mjs` |
| Who counts | One person = one approver: ids are linked by email in an identity registry; separation of duties sees through second ids | `server/src/governance/identity.mjs`, `policy.mjs` |
| What can merge | Only knowledge-base paths (`brain/wiki/*.md`, sidecars, bookkeeping files, `brain/.index/*.tsv`); no dotfiles, symlinks, executables or submodules — checked when the proposal is built, in policy, and again inside the merge | `server/src/governance/paths.mjs`, `merge.mjs` |
| The gate itself | The audit runs from the service's own checkout, re-runs on the merge result, and blocks on exit 1 | `server/src/ingest/audit.mjs`, `merge.mjs` |
| The ingest agent | No git, network or MCP tools; writes confined to `brain/`; the audit is an exact-command wrapper outside the worktree; secrets stripped from its environment; source content declared untrusted | `server/src/ingest/drivers/claude-code.mjs`, `runner.mjs` |
| Interactive agent sessions | `guard-wiki` (Write/Edit) and `guard-git` (Bash) hooks block wiki changes on `main`; `tools/hooks/pre-commit` blocks wiki commits on `main` | `server/src/ingest/hooks.mjs`, `guard-git.mjs`, `tools/hooks/` |

## Status

Two independent reviews ran against this branch: an exploit-driven security
review and an end-to-end QA run on the real service. The table is their result.

| Profile | Approval bypass over the service | Approval bypass through local git |
|---|---|---|
| **enterprise** (OIDC, `require_sso_for_approval`) | Closed | Depends on branch protection on your git host — turn it on |
| **team** (OIDC) | Closed for the web; one Slack gap (below) | Same as enterprise |
| **solo** (static token) | **Open** — see 1 below | **Open** — see 2 below |

### Open findings

1. **High — in token mode, the API token is also a login credential.** The token
   you put in an MCP client's config (`ALMAGEST_TOKEN`) can be pasted into
   `/inbox/login` to mint a browser session, which can then approve. An agent
   holding that token can do this with `curl`. *Until fixed:* do not put an
   owner/reviewer token in MCP or hook configuration — give chats a
   `contributor` or `viewer` token, and keep approver tokens for the browser
   only. *Planned fix:* separate login and API secrets per entry, so the token
   in MCP config cannot sign in.
2. **High — `main` can still be moved by git commands the guard does not model.**
   `git checkout -B main <branch>`, `git switch -C main …` and `git branch -f
   main …` move `main` without a commit, so no hook fires, and the checked-in
   `.claude/settings.json` allows them without a prompt. *Until fixed:* protect
   `main` on your git host and treat the local checkout as a working copy, not
   the source of truth; set `git config core.hooksPath tools/hooks`. *Planned
   fix:* `guard-git` blocks every ref move that targets `main`, the settings
   deny `checkout -B` / `switch -C` / `branch -f`, and `doctor` warns when the
   pre-commit hook is not installed.
3. **Medium — Slack approvals under OIDC use the roles cached at the person's
   last inbox sign-in**, with no expiry, so a demoted reviewer keeps approving
   from Slack until they sign in again or the mapping is edited. *Until fixed:*
   set `governance.require_sso_for_approval: true` (the enterprise default),
   which turns Slack into notify-and-link only.
4. **Medium — agent instruction files are writable through ingest.** A poisoned
   source could leave a `CLAUDE.md` / `AGENTS.md` under `brain/raw/extracted/`,
   which later interactive sessions load. It passes the path allowlist and shows
   in the inbox only as a filename under "Other files". *Until fixed:* reject
   any proposal whose file list contains one.
5. **Medium — the runner trusts the worktree's `.git` file** when it runs git
   after the agent finishes. Today Claude Code's restricted mode is what stops
   the agent from rewriting it; the `shell` driver has no such protection.
   *Until fixed:* use the `claude-code` driver only.

Lower-severity items from the same reviews (identity links that cannot be
undone after a wrong mapping, `submit_source` without a rate limit, one API
response that still includes a staging path) are tracked with the findings
above and fail safe.

### Honest limit for solo

On one machine, an agent with an unrestricted shell can read
`ALMAGEST_SECRET_KEY` and the SQLite store as easily as you can. Solo mode
cannot be made fully agent-proof without OS-level separation — running the
service as a different user, or on another machine. What the fixes above aim
for is narrower and achievable: that the credentials and commands an agent is
*normally given* are never enough to approve.

## Hardening checklist

- [ ] `git config core.hooksPath tools/hooks` in every clone
- [ ] Branch protection on `main` at your git host (required reviews, no force push)
- [ ] `ALMAGEST_SECRET_KEY` set, and different per deployment
- [ ] Approver tokens used only for browser sign-in; chats and hooks get `contributor` or `viewer` tokens
- [ ] `service.http.base_url` is HTTPS for anything beyond `localhost`
- [ ] team / enterprise: OIDC, `require_sso_for_approval: true`, `separation_of_duties: true`
- [ ] `ingest.driver: claude-code` (not `shell`) for unattended ingest
- [ ] `node server/bin/almagest.mjs doctor` is clean
