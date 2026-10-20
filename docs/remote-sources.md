# Remote Sources

Almagest can read content directly from remote repositories over MCP (Model Context Protocol) — no files are downloaded into `brain/raw/`. Two providers ship out of the box: **GitHub** and **GitLab**.

Remote sources are entirely optional. If you only ever drop files into `brain/raw/`, skip this page.

## With the v2 service: remote sources are connectors

If you run the Almagest service (`server/`), `sources.remote` is no longer a
separate path. Each entry is loaded as a **connector** with the `github` or
`gitlab` recipe — same `.mcp.json` server, same `repo` / `paths` / `branch` —
and syncs like any other MCP source ([v2/connectors.md](v2/connectors.md)):

| | v1 agent-driven remote ingest (below) | v2 connector |
|---|---|---|
| Who reads the repo | the agent, over MCP | the service, over MCP; the agent has no network |
| Change detection | commit SHA | sha256 of the rendered snapshot; the blob SHA only skips fetches |
| What pages cite | `github:owner/repo/path@sha` | a committed snapshot under `brain/raw/extracted/<connector-id>/` |
| Manifest entry | `kind: remote` | `kind: connector` (the commit is kept in `commit`) |

Nothing needs changing in `brain.config.yaml`. On the first service sync each
file that already has a `kind: remote` entry is re-ingested once as a connector
source and its old entry is marked `superseded`. Existing pages keep working
until then — the audit still checks `kind: remote` citations exactly as below.
Everything on the rest of this page still applies when you ingest without the
service.

For hosted servers that use OAuth rather than a token in `.mcp.json`, run
`almagest connectors login <id>` once; see [v2/connectors.md → OAuth login](v2/connectors.md#oauth-login).

## Remote sync can now run unattended

This is the change that makes this page worth reading. Under the old approval
gate every write needed an in-session "yes", which meant a remote sync was
something you sat and watched. A sync you have to babysit is not a sync — it is
a manual ingest with extra network, and the feature was quietly useless for its
main purpose.

Under the [branch model](agent-harnesses.md#requirement-5-does-not-degrade) the
agent ingests onto `ingest/<source-slug>-<sha7>`, runs `tools/audit.mjs`, commits
what passed, and stops. You read the diff and merge. Nothing about the guarantee
weakened: the guarantee was never "a human watched it happen", it was "nothing
unreviewed reached `main`".

So this is now a legitimate shape:

```bash
# cron, CI schedule, or a git worktree on a build box — pick your poison
git checkout -b "ingest/platform-docs-$(date +%Y%m%d)"
<your agent> --print "Sync all remote sources per agent/rules/ingest.md"
node tools/audit.mjs || exit 1
git push -u origin HEAD          # open a PR. Do not merge it.
```

Two rules that do not bend:

- **Never `--auto-merge`, never push to `main`.** There is no flag for it in
  Almagest and adding one to your job removes the only gate there is.
- **Give it its own worktree or checkout.** An unattended agent with permissive
  flags should not be sharing a working tree with your editor.

Contradictions, canonical conflicts, deletions, renames, and low-confidence
curated pages are not written by an unattended run at all — they block, and the
run reports them unwritten. You resolve those interactively on the next pass.

## How it fits together

| Piece | Role |
|-------|------|
| `.mcp.json` | Declares the MCP servers. Committed to git. Contains no secrets — tokens come from environment variables. |
| `brain.config.yaml` → `sources.remote` | Declares *which repos and paths* to ingest, and which provider reads each one. |
| `agent/rules/ingest.md` | The ingest protocol itself — identical for local and remote sources. |

You only need to configure the provider you actually use. An unconfigured server simply fails to connect; you can ignore it or delete its entry from `.mcp.json`.

## GitHub

### 1. Create a token

A fine-grained Personal Access Token with **Contents: Read-only** on the repositories you want to ingest. Classic tokens work too — `repo` scope, or `public_repo` for public repositories only.

### 2. Set the environment variable

```bash
export GITHUB_TOKEN="github_pat_..."
```

Add it to your shell profile (`.zshrc`, `.bashrc`) or a `.env` file — `.env` is gitignored by default.

### 3. The server entry

Already present in `.mcp.json`:

```json
"github": {
  "type": "http",
  "url": "https://api.githubcopilot.com/mcp/",
  "headers": {
    "Authorization": "Bearer ${GITHUB_TOKEN:-}"
  }
}
```

This is GitHub's official hosted MCP server. Nothing runs locally.

## GitLab

Works with gitlab.com or a self-hosted instance.

### 1. Create a token

A Personal Access Token with the `api` and `read_repository` scopes.

### 2. Set the environment variables

```bash
export GITLAB_URL="https://gitlab.com"        # or your self-hosted instance
export GITLAB_TOKEN="glpat-..."
```

`GITLAB_URL` defaults to `https://gitlab.com` if unset.

### 3. The server entry

```json
"gitlab": {
  "type": "http",
  "url": "${GITLAB_URL:-https://gitlab.com}/api/v4/mcp",
  "headers": {
    "PRIVATE-TOKEN": "${GITLAB_TOKEN:-}"
  }
}
```

## Register and approve the server

`.mcp.json` is Claude Code's format. Every other harness declares MCP servers in its own file — the same two entries, its own schema.

| Harness | Where the servers go |
|---------|---------------------|
| Claude Code | `.mcp.json` (shipped). `/mcp` → select the server → Approve |
| Cursor | `.cursor/mcp.json` |
| Codex | `~/.codex/config.toml`, `[mcp_servers.<name>]` |
| Gemini CLI | `~/.gemini/settings.json`, `mcpServers` |

In Claude Code:

```bash
claude
/mcp          # select the server → Approve
```

Both servers Almagest ships speak HTTP. Transport support varies by harness and by version — check yours before assuming remote sources work. Local ingest never touches MCP.

## Configure which repos to ingest

In `brain.config.yaml`:

```yaml
sources:
  remote:
    - provider: github
      repo: acme/platform-docs
      paths:
        - "docs/**/*.md"
        - "adr/**/*.md"
      branch: main
      label: platform

    - provider: gitlab
      repo: acme/api-specs
      paths:
        - "openapi/**/*.yaml"
      branch: develop
      label: api
```

| Field | Required | Meaning |
|-------|----------|---------|
| `provider` | yes | `github` or `gitlab` — picks the MCP server |
| `repo` | yes | `owner/repo` on GitHub, `namespace/project` on GitLab |
| `paths` | yes | Globs within the repo to ingest |
| `branch` | no | Defaults to the repo's default branch |
| `label` | no | Tag applied to wiki pages derived from this source |

## Usage

Ask your agent:

- "Check acme/platform-docs for changes since last ingest"
- "Sync all remote sources"

### What happens

1. Agent reads `brain.config.yaml` → `sources.remote`
2. Connects via the MCP server matching each entry's `provider`
3. Lists files in the configured paths, compares against the last ingested commit SHA
4. Reads changed files and extracts entities
5. Writes pages on an `ingest/<source-slug>-<sha7>` branch — **same branch, audit, and merge flow as local ingest**
6. Logs the source reference in `index.md` → Remote sources and in `manifest.yaml` (provider, repo, path, commit SHA, date)
7. Runs `tools/audit.mjs`; an exit `1` blocks the commit
8. You read `git diff main...ingest/<branch>` and merge

Nothing reaches `main` without your merge, remote or local.

### Citations for remote sources

Remote sources use the same frozen citation grammar as local ones — `[source: <id>, <locator>]`, where `<id>` is an entry in that page's `sources`. The repo, path, and commit SHA live in the frontmatter and the manifest, not in the citation:

```yaml
sources:
  - id: platform-arch
    path: github:acme/platform-docs/docs/architecture.md@abc1234
    sha256: "9f2a…"                       # of the file content at that commit
    title: "Platform Docs — Architecture"
```

```markdown
Failover is constraint-aware. [source: platform-arch, §Overview]
```

The commit SHA is pinned in `path`, so the citation resolves to an exact revision rather than to whatever `main` says today. `manifest.yaml` carries the same SHA — that is what makes the next sync incremental, and what `CITE-005` compares against when the upstream file moves on.

## Using the same servers in a desktop chat app

The same MCP servers work in any MCP-capable desktop client, which lets non-technical teammates query the brain conversationally. The Claude desktop app is the worked example:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer github_pat_..." }
    }
  }
}
```

Note that the desktop config does not expand environment variables — the token goes in literally. Treat that file as a secret.

## Security

- Give tokens the **minimum** scope that works: read-only contents on GitHub, `read_repository` on GitLab.
- Each person uses their own token. Never share one.
- Tokens never enter git — `.mcp.json` references environment variables, and `.env` is gitignored.
- Review approved MCP servers periodically — `/mcp` in Claude Code, the equivalent in your harness.
