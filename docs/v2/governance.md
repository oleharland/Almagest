# Governance — reviewing what the agent wants to add

Almagest's agent reads sources and writes wiki pages, but it never changes the
knowledge base on its own. Everything it writes arrives as a **proposal** that a
person reviews and approves. This page explains how that works, for the people
who review and for the people who set it up.

Code: `server/src/governance/`. Contract: [`spec.md`](spec.md) → Governance.

---

## For reviewers

### What you see

Open the **review inbox** (`/inbox` on your Almagest server). Each entry is one
proposal — the agent's work on one source:

> **New material from “Q3 board deck”**
> 3 new facts, 1 updated fact about Acme and Pricing · 1 question needs you

Entries with a question for you come first, then ones touching frequently-read
pages, then the oldest.

Open one and you see, page by page, every **fact** that would be added, changed
or removed. Next to each fact is the **passage from the source** it claims to
come from — "Source: Q3 board deck, page 3", followed by what page 3 actually
says. You are checking one thing: *does the source say this?* You never need
to read a diff.

If the passage can't be found, the card says so ("We couldn't find that spot
in the source — check it by hand"). Treat that as a reason to look closer.

### What you can do

| Button | What happens |
|---|---|
| **Approve all** | Your approval is recorded. When every requirement is met, the proposal is added to the knowledge base straight away. |
| **Accept page** | Approves one page. Some pages (frequently read, or owned by a team) need this explicit look. Accepting every page one by one is the same as approving all. |
| **Take this page out** | The agent removes that page from the proposal; the rest stays. |
| **Ask for changes** | Write what's wrong. The agent revises and the proposal comes back to you. |
| **Turn down** | Nothing from this proposal is added. |
| A question's answer buttons | When the agent hit something it may not decide alone — two sources disagree, a page would be deleted or merged, it isn't sure — it asks. Your answer goes to the agent, which revises. |

The box **"Before this can be added"** always says, in a sentence, what is
still missing: *"Needs 1 more approval from someone in team engineering for the
page “Pricing”."*

### Things that are always true

- **Only people approve, signed in.** A chat assistant, a script or the agent
  itself can never approve, whatever the settings say — and neither can an
  access token, even yours: approving happens in your signed-in browser (or by
  a Slack button / GitHub merge Almagest can verify was you).
- **You approve what you saw.** Every Approve button carries the exact version
  on your screen. If the proposal changed in the meantime, nothing is approved
  and you are shown the new version. If it changes after you approved it (the
  agent revised it), your approval stops counting, and the page says whose
  approvals no longer count.
- **One person, one approval.** Approving in the inbox and again from Slack is
  still one approval.
- **Only the knowledge base.** A proposal that would change anything besides
  wiki pages, sources and the knowledge base's own records (the audit tool,
  the service, the configuration, git settings …) can never be approved.
- **Questions first.** A proposal with an unanswered question can't be added.
- **The automatic checks must pass** — on the proposal, and again on the result
  of combining it with the current knowledge base.
- **Locked reference pages** (canonical pages) are never changed by a proposal.
  If new material disagrees with one, the disagreement is written down as a
  *challenge* in `brain/canonical-challenges.md`, where a person can weigh it.
  The page itself stays as it is.

### Approving from elsewhere

- **From a chat** (Claude, ChatGPT, … via Almagest's MCP server): ask the chat
  to approve and it gives you a link with a code like `K7Q2-9XMA-PD4T`. The
  link opens the full review — the same page as from the inbox, with a note
  that the chat asked — and you approve there. The chat cannot do it for you.
  Codes work once and expire after 15 minutes.
- **From Slack**: notifications have Approve / Request changes / Open buttons.
  Approve works only if your Slack account is linked to your Almagest account.
- **From email**: links in the email open the inbox. A personal link signs you
  in once ("Continue as Ada"); opening it never approves anything by itself.
- **From GitHub**: for teams that prefer pull requests — merging the PR counts
  as your approval.

---

## For administrators

### Profiles

`service.profile` in `brain.config.yaml` picks defaults; every key can be
overridden.

| | `solo` | `team` | `enterprise` |
|---|---|---|---|
| Sign-in to the inbox | token (paste) | single sign-on (OIDC) | single sign-on (OIDC) |
| Separation of duties | off | on | on |
| Ordinary proposal | 1 approval | 1 approval | 1 approval |
| Frequently-read ("hot") page | 1 explicit page approval | 2 explicit page approvals | 2 explicit page approvals, one from the page's owner team |
| `canonical_conflict` question | — | — | answered and approved by an `owner` |
| `require_sso_for_approval` | off | off | on |
| Channels | web, mcp | web, mcp, slack | web, slack, github-pr |

### Sign-in

```yaml
service:
  http: { base_url: https://brain.acme.com }   # links in Slack/email/PRs use this; https → Secure cookies
  auth:
    provider: token            # token: paste a token at /inbox/login
    tokens_env: ALMAGEST_TOKENS  # "ada:owner:<secret>;bob:reviewer:<secret>"
    session_hours: 12
    # provider: oidc
    # oidc:
    #   issuer: https://login.acme.com/realms/brain
    #   client_id: almagest-web
    #   client_secret_env: ALMAGEST_OIDC_SECRET    # omit for a public client (PKCE only)
    #   audience: almagest                         # bearer-token audience (core/auth-oidc.mjs)
    #   roles_claim: realm_access.roles            # dotted path
    #   teams_claim: groups
    #   role_map: { brain-owners: owner, brain-reviewers: reviewer }
    #   default_roles: [viewer]
    #   redirect_path: /inbox/auth/callback        # register base_url + this at the IdP
```

`ALMAGEST_SECRET_KEY` signs sessions, CSRF tokens and email links. Set it in
production; without it a temporary key is used and everyone is signed out on
restart.

Sessions are server-side records behind an HMAC-signed, HttpOnly,
SameSite=Lax cookie. Signing out revokes the record; removing someone's token
from `ALMAGEST_TOKENS` ends their sessions at once. OIDC sign-in is the
authorization-code flow with PKCE, a `state` check and an ID-token `nonce`;
the ID token's signature is checked against the issuer's JWKS.

Roles: `viewer` (look only), `contributor`, `reviewer`, `owner`, `admin`. Only
`reviewer`, `owner` and `admin` approve. Teams come from `owner_teams`.

### Approval rules

```yaml
governance:
  separation_of_duties: true        # whoever sent a proposal in can't approve it
  require_sso_for_approval: false   # true: only OIDC-signed-in people approve
  rules:                            # every matching rule adds; requirements combine by max / union
    - when: { hot: true }
      require: { approvals: 2, per_page: true }
    - when: { tier: curated, owner: finance }
      require: { owner_team: true }
    - when: { decision: canonical_conflict }
      require: { roles: [owner] }
    - when: { label: legal }
      require: { approvals: 2, distinct_teams: 2 }
```

**Conditions (`when`)** — all listed conditions must hold:

| Key | Matches | Scope |
|---|---|---|
| `hot` | page is frequently read (from usage tracking) | page |
| `tier` | `canonical` · `curated` · `evidence` (or a list) | page |
| `action` | `create` · `update` · `delete` · `rename` | page |
| `page` | slug glob, e.g. `pricing-*` | page |
| `owner` | the page's `owner` team | page |
| `decision` | the proposal raised a question of this kind | proposal |
| `label` | the connector's `label` the source came from | proposal |
| `connector` | the connector id | proposal |
| `source_kind` | `local` · `remote` · `connector` | proposal |

An empty `when: {}` matches every proposal.

**Requirements (`require`)**:

| Key | Meaning |
|---|---|
| `approvals: n` | at least n different people |
| `per_page: true` | the matched page needs its own approvals (Accept page); "approve all" doesn't cover it |
| `roles: [...]` | at least one approver has one of these roles (`admin` always qualifies) |
| `teams: [...]` | at least one approver is in one of these teams |
| `owner_team: true` | at least one approver of the page is in the page's `owner` team; a page without an owner needs someone with the `owner` role |
| `distinct_teams: n` | approvers cover n different teams, each by a different person |

A rule with a page condition and no `per_page`/`owner_team` raises the bar for
the whole proposal ("touches a curated page → 2 approvals"). Roles named by a
`decision:` rule also apply to whoever answers that question. Rules are
validated at startup; a typo stops the service with a message.

### What cannot be configured away

These are code, not config. No rule, profile or flag changes them.

1. A proposal needs **at least one approval from a human with an approver
   role**, given for its **current version** (`headSha`). Approvals for an
   earlier version are kept in the record and shown, but do not count.
2. **Agents and services never approve** — `assertCanApprove` in
   `core/auth.mjs` is the first line of every action. A chat session is always
   an agent acting for someone.
3. With **separation of duties** on, the submitter — and the human an agent
   submitted for (`onBehalfOf`) — cannot approve.
4. **Open questions block the merge.**
5. **The automatic checks gate twice**: the runner's audit must have exit 0,
   and the service re-runs its *own* `tools/audit.mjs` on the merge result in a
   throwaway worktree; anything but exit 0 means main does not move.
6. **A proposal that modifies a canonical page never merges.** It gets a
   `canonical_conflict` question whose only options are *record a challenge*
   (a row appended to `brain/canonical-challenges.md` on the proposal's branch,
   never a wiki edit) and *dismiss*; either way the page change is taken out.
7. Every action — approve, reject, request changes, answer, take a page out,
   merge, a policy violation — is written to the **append-only audit log**
   (`/inbox/activity`) with who, which channel and which version.
8. **Review actions need a verified path, never a token.** Approve, accept a
   page, reject, take a page out, answer a question, ask for changes and retry
   all require a signed-in browser session with its CSRF token — on the inbox
   forms and on the JSON API alike — or the signed Slack / GitHub webhook
   path. Bearer tokens (`ALMAGEST_TOKENS`, OIDC access tokens, MCP OAuth
   tokens) can read proposals and nothing more. This is checked at the HTTP
   layer and again inside the service (`trust.mjs`): the module that verified
   the request vouches for the actor object it built, and copies or
   hand-built actors carry no vouch.
9. **An approval names the version it is for.** `approve` and
   `resolveDecision` take the `headSha` the person was shown and refuse (409,
   "this proposal changed since you opened it") when it is not the current
   one. A merged GitHub PR whose head is not the reviewed version records no
   approval and is logged as a policy violation.
10. **People are counted, not ids.** Every human who signs in is remembered
    id ↔ email (`store.kv` → `governance.identity`). Approvals are counted by
    person (email when known, else id), and separation of duties compares the
    submitter by every id and email they are known by. Channel mappings
    resolve to that person by email — see *Channels*.
11. **Only knowledge-base files.** The branch diff — checked when the proposal
    is built, again by the policy engine, and once more inside the merge on
    both the branch diff and the merge result right before main moves — may
    only touch: `brain/wiki/<slug>.md` (no subfolders), `brain/raw/extracted/**`,
    `brain/raw/processed/**` (text only), `brain/index.md`, the manifest,
    `brain/log.md`, the challenges ledger and `brain/.index/*.tsv`. Dotfiles,
    symlinks, executable files and everything else (tools/, server/, agent/,
    brain.config.yaml, CLAUDE.md, .github/, .gitattributes …) block the
    proposal for good, with an entry in the activity log.
12. **A proposal with nothing left in it** (every page taken out) can't be
    approved; turn it down to close it.

### How a merge happens

When the last requirement is met, the approval that completed it triggers the
merge (one at a time, under a lock):

1. `git merge-tree --write-tree main <branch>` — computed without touching any
   checkout.
2. Two proposals made from the same main always both touch the bookkeeping
   files; those clashes are resolved mechanically (`bookkeeping.mjs`):
   - **the manifest** by a structured 3-way merge of `sources[]` by `id` —
     entries either side added are kept, a one-sided change wins, the same id
     changed differently on both sides is a real conflict. The result is
     written in block style whatever style the file used.
   - **`log.md`, `index.md`, the challenges ledger** when both sides only added
     rows. Template placeholder rows (`| _(no actions yet)_ | | |`,
     `| _(no sources yet)_ | | |`, an all-empty ledger row) that either side
     replaced with real rows are dropped first; placeholders nobody touched
     stay.
   - **the derived index** (`brain/.index/`) is regenerated.

   Any other conflict marks the proposal *clashes with recent changes* and the
   agent is asked to redo it on top of main (a `revise` job with
   `reason: 'conflict'`) — at most one waiting per reviewed version, and at
   most **two** per proposal. After that the inbox says it needs a person (ask
   for specific changes, or turn it down and add the source again); asking for
   changes resets the count.
3. A row is added to `brain/log.md`: date, proposal, approvers and channels,
   the reviewed version, pages.
4. A merge commit with two parents (main, the reviewed head). Author: the
   person whose approval completed it. Committer: `svc:governance`.
5. Re-audit (above), then the path check (invariant 11) on the branch diff and
   on the merge result.
6. `main` moves by compare-and-swap: `git merge --ff-only` inside a working
   copy that has main checked out (refused, with a "Try again" button, if that
   copy has unsaved edits to the same files), otherwise `git update-ref` with
   the old value. If main moved meanwhile, the merge is recomputed.
7. With `service.git.push: true`, main is pushed to `service.git.remote`.
8. The ingest worktree is removed and the merged branch deleted. A turned-down
   or superseded proposal is cleaned up the same way (its branch is kept only
   with `governance.keep_closed_branches: true`).

### Channels

```yaml
governance:
  channels:
    - kind: web                      # always on, even if not listed
    - kind: mcp
      confirm_ttl_minutes: 15
    - kind: slack
      webhook_env: SLACK_WEBHOOK_URL
      signing_secret_env: SLACK_SIGNING_SECRET
      events: [proposal.created, decision.created, proposal.merged]
      users:                         # Slack user id → a person, by email
        U024BE7LH: { email: ada@acme.com, id: usr_ada }
    - kind: email
      from: "Almagest <almagest@acme.com>"
      transport: http                # http | sendmail
      http: { url: https://api.resend.com/emails, token_env: RESEND_API_KEY, style: resend }   # style: resend | postmark
      # sendmail_path: /usr/sbin/sendmail
      recipients:                    # personal sign-in links
        - { email: ada@acme.com, id: usr_ada }
      to: [kb-team@acme.com]         # plain notifications
      events: [proposal.created, decision.created]
      link_ttl_hours: 24
      digest_every_hours: 24         # or: almagest inbox-digest (cron)
    - kind: github-pr
      repo: acme/brain
      token_env: GITHUB_TOKEN
      webhook_secret_env: GITHUB_WEBHOOK_SECRET
      api_url: https://api.github.com
      users:                         # GitHub login → a person, by email
        octocat: { email: ada@acme.com, id: usr_ada }
  keep_closed_branches: false        # true: keep the branch of a turned-down / superseded proposal
```

**How channel accounts map to people.** A mapping never creates a person; it
points at one who exists, and roles and teams come from how that person signs
in, not from the mapping:

- Under single sign-on (`service.auth.provider: oidc`) a mapping needs an
  `email` and resolves to the person who signed in to the inbox with that
  email. Someone who has never signed in is refused ("sign in to the review
  inbox once to link this account"). The mapping's `id`, `roles` and `teams`
  are ignored.
- Under tokens, `id` must name someone in `ALMAGEST_TOKENS`; their roles apply.
  Add `email` to tie the account to that person across channels.
- When counting people matters — `separation_of_duties`, or any rule with
  `approvals` or `distinct_teams` above 1 — a mapping without an `email`, or
  (tokens) with an `id` nobody holds, stops startup.

An unknown `kind` or a kind listed twice stops startup. A channel whose
secrets are missing starts with a warning and stays quiet. Notifications run
in the background: a failed Slack post or mail is logged and never blocks the
action that caused it.

**web** — the inbox (`/inbox`, `/inbox/p/:id`, `/inbox/reverify`,
`/inbox/gaps`, `/inbox/activity`) and a JSON mirror:
`GET /api/proposals[?status=open,approved&limit=50]`, `GET /api/proposals/:id`
(any signed-in actor, agents included), and `POST /api/proposals/:id/approve |
reject | request-changes | retry`, `POST /api/proposals/:id/pages/:slug/reject`,
`POST /api/decisions/:id/resolve`. Every action — form or JSON — needs a
signed-in browser session plus its CSRF token (`csrf` form field, or the
`x-almagest-csrf` header), and approve / accept / resolve need the `headSha`
the person was shown. **Bearer tokens can only read**: an agent that has a
reviewer's token in its environment (Claude Code with `ALMAGEST_TOKEN`, an MCP
client) gets 403 on every action. API output never includes the server's
filesystem paths (worktrees, staging). Every page is sent with a
strict Content-Security-Policy (no external resources; only the page's own
nonce'd style and script), `X-Frame-Options: DENY` and `no-referrer`.

**mcp** — `ctx.governance.createConfirmation(prpId, human, 'approve' |
'reject')` returns `{ url, code, expiresAt }`. `/inbox/confirm/<code>` has no
buttons of its own: signed in, it redirects to the full review page
(`/inbox/p/<id>?confirm=<code>`), which says who the chat asked for and
whether the proposal changed since. The person approves or turns it down
there, on the version they see; the action is recorded with channel `mcp` and
the code is used up. Codes are stored only as their sha256, work once, and
expire.

**slack** — POST `/channels/slack/actions` (Slack app → Interactivity request
URL). Requests are verified with `X-Slack-Signature` (v0 HMAC), must be under
five minutes old and are refused if replayed. Slack users not listed in
`users` cannot approve; listed ones are resolved to a person as above. The
button carries the version the message showed and approves only that one.
With `require_sso_for_approval`, messages carry no Approve button — only a
link into the inbox.

**email** — personal links are HMAC-signed, single-use and expire
(`link_ttl_hours`, default 24). Opening one shows "Continue as …"; pressing it
signs the recipient — resolved to a person as above — in once. With
`require_sso_for_approval` (on in the enterprise profile), links only lead to
the sign-in page. Header values are stripped of line breaks (no header
injection). There is deliberately no SMTP library: use `sendmail` (Postfix,
msmtp, …) or an HTTPS mail API.

**github-pr** — pushes each proposal branch to `service.git.remote` and opens a
PR whose body is the plain-language summary plus the inbox link. Webhook:
POST `/channels/github/webhook` (content type JSON, event *Pull requests*),
verified with `X-Hub-Signature-256`; each `X-GitHub-Delivery` is acted on
once. A merged PR is recorded as the approval of the GitHub user who merged it
(mapped through `users`) — only if the PR's head is the reviewed version — the
proposal is
marked merged, and local main is fast-forwarded to the remote's. Almagest
never merges through the GitHub API. Because the merge happens on GitHub, the
policy can't stop it there: mirror your rules in **branch protection**. A
merge that did not meet the policy — wrong version, missing approvals, an
unmapped or non-reviewer account — is still recorded (it happened) and shows
up as a **policy violation** in the activity log.

### CLI

```
almagest proposals      # what's waiting, with inbox links
almagest inbox-digest   # send the email digest now
```

### Service API (for other modules)

Spec surface: `listProposals`, `getProposal`, `createFromJob`, `approve`,
`reject`, `rejectPage`, `requestChanges`, `resolveDecision`,
`createConfirmation`. Extras: `evaluate(prpId)` → `{ proposal, decisions,
evaluation: { ready, blockers, missing, approvers, explanation } }`,
`retryMerge`, `recordExternalMerge`, `getDecision`, `listDecisions`,
`mayApprove(proposal, actor)`, `channel(kind)`, `identities`. `approve(prpId,
actor, { scope, channel, headSha })` and `resolveDecision(decId, actor, {
optionId, note, channel, headSha })` require `headSha`; every action requires an
actor vouched for by a session or a verified channel (`trust.mjs`).

Fields added to the spec's Proposal shape: `approvals[]` carry `display`,
`email`, `kind`, `roles`, `teams`, `idp`, `headSha` (a snapshot of the
approver at the time); `required.pages` (per-page requirements) and
`required.canonical`; `changes[]` carry `title`, `owner`, `confidence`,
`canonical`, `fields` (frontmatter changes) and claims carry `excerptStatus`
(`found` · `not-found` · `source-missing` · `unknown-source` · `no-citation`);
`needsManualLook` + `preview` (a new page with no facts the inbox could pair
with a source); plus `submitters`, `otherFiles`, `files` (every changed path
with mode and binary flag), `outside` (paths outside the writable set),
`revision`, `revisedBecause`, `conflictRevise`, `mergeError`, `feedback`,
`rejection`, `supersededBy`.
