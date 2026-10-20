# Getting Started

## 1. Fork or clone

```bash
# Option A: Fork on GitLab/GitHub, then clone your fork
git clone <your-fork-url> my-brain
cd my-brain

# Option B: Use as template
git clone <almagest-repo-url> my-brain
cd my-brain
git remote rename origin upstream
git remote add origin <your-new-repo-url>
```

## 2. Configure brain.config.yaml

Edit `brain.config.yaml` to match your domain:

- **name** — your knowledge base name
- **agent.harness** — which coding agent you run, and the model each capability tier maps to. See [Agent Harnesses](agent-harnesses.md)
- **page_types** — the types of wiki pages you'll create (e.g., topic, concept, decision, entity)
- **type_fields** — extra frontmatter fields per page type
- **canonical_pages** — which wiki pages serve as locked reference lists
- **anonymization.enabled** — off by default. Turn it on if the wiki is shared beyond the people named in it, or if sources contain personal data (see below)
- **require_owner** / **owner_teams** — off by default. Turn on if you want every page assigned to a team
- **sources.remote** — repos to pull from (optional, see [Remote Sources](remote-sources.md))

### A note on anonymization

`anonymization.enabled` ships as `false`, so names in your sources are written straight through to the wiki. That is the right default for a personal knowledge base.

Turn it on before ingesting anything containing real personal data — meeting transcripts, CRM exports, support tickets. With it on, the agent runs a named-entity pass over each source, stops on every name it finds, shows you what it found, and waits for approval before writing a role-based replacement.

That pass is **best-effort and nothing more**. A model reading text misses initials, transliterations, names that look like ordinary words. The control is you reading the ingest branch's diff before it merges — `enabled: true` reduces how much you have to catch there; it does not replace the catching. Note that `brain/raw/extracted/` is committed, so read the sidecar in that diff too.

## 3. Set up remote sources (optional)

If you want to pull content from GitHub or GitLab repos instead of dropping files locally:

1. Set the token for your provider:
   ```bash
   export GITHUB_TOKEN="github_pat_..."      # GitHub
   export GITLAB_TOKEN="glpat-..."           # GitLab
   ```
2. Point your agent at the MCP servers. Claude Code reads `.mcp.json` automatically and prompts you to approve each server (`/mcp` to manage); other harnesses need the same two entries in their own config — see [Agent Harnesses](agent-harnesses.md)
3. List the repos to ingest under `sources.remote` in `brain.config.yaml`

See [Remote Sources](remote-sources.md) for full details.

Skip this entirely if you only plan to drop files into `brain/raw/`.

With the v2 service (step 8) this generalises: any MCP server — Google Drive,
Granola, Linear, Notion, Slack, or anything that exposes MCP resources — can be
an input under `sources.connectors`, and `sources.remote` entries keep working
through it. See [Connectors](v2/connectors.md).

## 4. Create your first canonical pages

Canonical pages are the guardrails. Create them before ingesting anything:

```bash
# Example: create a taxonomy page
# The agent will help you draft it
```

Ask your agent: "Create a canonical taxonomy page for [your domain]"

## 5. Start ingesting

Drop files into `brain/raw/` and start your agent in the repo root:

```bash
claude          # or codex, cursor-agent, gemini — whichever you run
```

What happens, in order:

1. **Fingerprint.** Every file in `raw/` is hashed and looked up in `brain/manifest.yaml` — new, unchanged, or changed. Unchanged files are skipped without being read. See [The Ingest Manifest](manifest.md)
2. **Extract to a sidecar.** Every binary source — PDF, deck, spreadsheet, video — is extracted to plain text at `brain/raw/extracted/<filename>.txt`, with `=== page 12 ===` markers, **before** any entity is pulled out of it. That file is committed; the original is not. It is what your wiki pages cite, so a citation stays checkable on a fresh clone with nothing but `grep`
3. **Extract entities**, deduplicated against `brain/.index/aliases.tsv` so one entity does not become two pages
4. **Write to a branch.** The agent commits to `ingest/<source-slug>-<sha7>`. It never writes to `brain/wiki/` on `main`
5. **Audit.** `tools/audit.mjs` runs before the commit. An error blocks it — nothing lands until it passes
6. **You merge.** Review the diff, merge to `main`. That is the gate

Some things still stop and ask, on the branch: a contradiction with an existing page, anything touching a canonical page, a deletion or rename, `confidence: low` on a curated page. Everything else lands on the branch and you read it as a diff.

**Unattended ingest onto a branch is fine. Unattended merge to `main` is not, and there is no flag for it** — the contract is in [`agent/contract.md`](../agent/contract.md), the per-harness detail in [Agent Harnesses](agent-harnesses.md).

## 6. Run the audit

```bash
node tools/audit.mjs              # full audit, human report
node tools/audit.mjs --json       # machine-readable findings
node tools/audit.mjs index        # regenerate brain/.index/
node tools/audit.mjs --check-index  # verify brain/.index/ is current (CI)
```

Exit `0` clean, `1` violations found, `2` tool error.

The audit is the reason the schema is shaped the way it is. Citations parse (`[source: <id>, p.12]`), source ids resolve against the page's `sources`, and each `sources[].sha256` is compared with the manifest — so `CITE-005` can tell you *"this page cites v1; the manifest is at v2 — 4 citations unverified"* instead of leaving you to guess from a `last_verified` date. Full check list: [The Audit](audit.md).

Run it after every ingest and before every merge. In CI, run it plus `--check-index`.

## 7. Build the site (optional)

```bash
cd site
npm install
npm run dev      # live-reloading dev server
npm run build    # static output in site/dist/
npm run preview  # serve the built output locally
```

The Astro site reads directly from `brain/wiki/` at build time — no separate content step, no database. It renders every page, resolves `[[wikilinks]]`, builds a backlink graph, and flags pages that cite no sources.

Customise it in two places, both of which survive `git merge upstream/main`:

- `site/site.config.ts` — title, description, how the index groups pages
- `site/src/styles/theme.css` — colours and typography, as CSS custom property overrides

`site/dist/` is plain static HTML. Deploy it anywhere that serves files.

## Pulling upstream updates

When the framework improves (new agent rules, site components, audit checks):

```bash
git fetch upstream
git merge upstream/main
```

See [Upstream Updates](upstream-updates.md) for details.

## 8. Run the service (optional)

Steps 1–7 are the whole framework with nothing but an agent session and git. The
v2 service adds background ingest, any MCP server as an input, a review inbox
for people who don't read diffs, the brain as an MCP server for your chats, and
request tracking:

```bash
npm install
export ALMAGEST_SECRET_KEY=$(openssl rand -hex 32)
export TOKEN=$(openssl rand -hex 16) && echo "your inbox token: $TOKEN"
git config core.hooksPath tools/hooks
node server/bin/almagest.mjs doctor
ALMAGEST_TOKENS="me:owner:$TOKEN" npm run serve      # inbox: http://127.0.0.1:4747/inbox
```

Pick a profile (`service.profile: solo | team | enterprise`) in
`brain.config.yaml`, then read the guide for each part in [docs/v2/](v2/spec.md)
and [the security status](v2/security.md) before running it anywhere others can
reach.

## Where to go next

- [Agent Harnesses](agent-harnesses.md) — what a harness has to be able to do, and how to set up the one you use
- [The Ingest Manifest](manifest.md) — how the agent tells a new source from one you edited, what the extracted sidecars are for, and what to do when the record drifts
- [The Audit](audit.md) — every check, what it detects, and how to clear it
- [Terminal Output](terminal-output.md) — what a session looks like while it runs
- [Benchmarks](benchmarks.md) — the harness for measuring whether the compiled wiki actually beats reading the raw sources
