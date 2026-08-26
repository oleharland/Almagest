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
- **page_types** — the types of wiki pages you'll create (e.g., topic, concept, decision, entity)
- **type_fields** — extra frontmatter fields per page type
- **canonical_pages** — which wiki pages serve as locked reference lists
- **anonymization.enabled** — off by default. Turn it on if the wiki is shared beyond the people named in it, or if sources contain personal data (see below)
- **require_owner** / **owner_teams** — off by default. Turn on if you want every page assigned to a team
- **sources.remote** — repos to pull from (optional, see [Remote Sources](remote-sources.md))

### A note on anonymization

`anonymization.enabled` ships as `false`, so names in your sources are written straight through to the wiki. That is the right default for a personal knowledge base.

Turn it on before ingesting anything containing real personal data — meeting transcripts, CRM exports, support tickets. With it on, the agent stops on every detected name, shows you what it found, and waits for approval before writing a role-based replacement.

## 3. Set up remote sources (optional)

If you want to pull content from GitHub or GitLab repos instead of dropping files locally:

1. Set the token for your provider:
   ```bash
   export GITHUB_TOKEN="github_pat_..."      # GitHub
   export GITLAB_TOKEN="glpat-..."           # GitLab
   ```
2. Start Claude Code — it reads `.mcp.json` automatically
3. Approve the MCP server when prompted (`/mcp` to manage)
4. List the repos to ingest under `sources.remote` in `brain.config.yaml`

See [Remote Sources](remote-sources.md) for full details.

Skip this entirely if you only plan to drop files into `brain/raw/`.

## 4. Create your first canonical pages

Canonical pages are the guardrails. Create them before ingesting anything:

```bash
# Example: create a taxonomy page
# The agent will help you draft it
```

In Claude Code, say: "Create a canonical taxonomy page for [your domain]"

## 5. Start ingesting

Drop files into `brain/raw/` and start Claude Code:

```bash
claude
```

The agent will detect files in `raw/`, extract entities, and propose wiki pages for your approval.

## 6. Build the site (optional)

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

## Where to go next

- [The Ingest Manifest](manifest.md) — how the agent tells a new source from one you edited, and what to do when the record drifts
- [Benchmarks](benchmarks.md) — the harness for measuring whether the compiled wiki actually beats reading the raw sources
