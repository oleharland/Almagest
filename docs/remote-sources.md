# Remote Sources

Almagest can read content directly from remote repositories over MCP (Model Context Protocol) — no files are downloaded into `brain/raw/`. Two providers ship out of the box: **GitHub** and **GitLab**.

Remote sources are entirely optional. If you only ever drop files into `brain/raw/`, skip this page.

## How it fits together

| Piece | Role |
|-------|------|
| `.mcp.json` | Declares the MCP servers. Committed to git. Contains no secrets — tokens come from environment variables. |
| `brain.config.yaml` → `sources.remote` | Declares *which repos and paths* to ingest, and which provider reads each one. |
| `.claude/rules/brain-ingest.md` | The ingest protocol itself — identical for local and remote sources. |

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

## Approve the server in Claude Code

On first run Claude Code prompts you to approve each MCP server:

```bash
claude
/mcp          # select the server → Approve
```

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

In Claude Code:

- "Check acme/platform-docs for changes since last ingest"
- "Sync all remote sources"

### What happens

1. Agent reads `brain.config.yaml` → `sources.remote`
2. Connects via the MCP server matching each entry's `provider`
3. Lists files in the configured paths, compares against the last ingested commit SHA
4. Reads changed files and extracts entities
5. Proposes wiki page updates — **same approval flow as local ingest**
6. Logs the source reference in `index.md` → Remote sources (provider, repo, path, commit SHA, date)

Nothing is written to the wiki without your approval, remote or local.

### Citations for remote sources

```markdown
[source: github:acme/platform-docs / docs/architecture.md, §Overview (sha: abc1234, 2026-08-25)]
```

## Using the same servers in the Claude desktop app

The same MCP servers work in the Claude desktop app, which lets non-technical teammates query the brain conversationally.

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
- Review approved MCP servers periodically with `/mcp`.
