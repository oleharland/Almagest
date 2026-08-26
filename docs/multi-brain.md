# Multi-Brain Expansion

By default, Almagest ships with a single `brain/` directory. This guide covers expanding to multiple knowledge domains.

## When to use multiple brains

One brain is the right answer far more often than people expect. Wikilinks already cross domains, and `tags` already partition content. Reach for a second brain only when two bodies of knowledge genuinely differ in **kind**:

- **Different page types** — e.g. a brain of literature notes (`paper`, `author`, `finding`) vs. a brain of system documentation (`service`, `decision`, `runbook`)
- **Different sensitivity** — e.g. public notes you publish vs. private material that must never reach the built site
- **Different update cadences** — stable reference material vs. a daily-churn journal
- **Different consumers** — content you query yourself vs. content a team queries

If the only difference is subject matter, use tags instead.

## Architecture

```
your-repo/
├── research-brain/             ← what you READ (papers, articles, talks)
│   ├── raw/
│   │   └── processed/
│   ├── wiki/
│   ├── index.md
│   ├── log.md
│   ├── CLAUDE.md               ← reader-rule pointers (generated)
│   └── AGENTS.md
├── projects-brain/             ← what you BUILD (systems, decisions, runbooks)
│   ├── raw/
│   │   └── processed/
│   ├── wiki/
│   ├── index.md
│   ├── log.md
│   ├── CLAUDE.md               ← reader-rule pointers (generated)
│   └── AGENTS.md
├── site/                       ← reads from ALL brains
├── brain.config.yaml           ← config for all brains
└── agent/rules/
    ├── read.md                 ← shared by every brain
    ├── research-brain-ingest.md
    ├── research-brain-wiki.md
    ├── projects-brain-ingest.md
    └── projects-brain-wiki.md
```

The rules are canonical in `agent/rules/`. Whatever your harness loads — `.claude/rules/*.md`, `.cursor/rules/*.mdc`, `AGENTS.md` — is a pointer at one of them. See [Agent Harnesses](agent-harnesses.md).

## How to add a second brain

1. **Duplicate the `brain/` directory** with a new name:
   ```bash
   cp -r brain/ research-brain/
   rm -rf research-brain/wiki/*.md research-brain/raw/processed/*
   ```

2. **Copy the canonical rules** for the new brain:
   ```bash
   cp agent/rules/ingest.md agent/rules/research-brain-ingest.md
   cp agent/rules/wiki.md   agent/rules/research-brain-wiki.md
   ```
   Edit the `brain/` paths inside each copy to point at `research-brain/`. `agent/rules/read.md` is not copied — the query protocol is the same for every brain.

3. **Point your harness at them.** Copy the shim for each rule and retarget its path glob. On a harness with strong loading:
   ```yaml
   # .claude/rules/research-brain-ingest.md
   paths:
     - "research-brain/raw/**"
   ```
   ```yaml
   # .cursor/rules/almagest-research-ingest.mdc
   globs: research-brain/raw/**
   ```
   On a weak-loading harness, add a row per brain to the routing table in `AGENTS.md` / `GEMINI.md` instead.

   `tools/agent-shims.sh` generates shims for the default `brain/` only. Per-brain shims are yours: `generate` will not create them and will not touch them.

4. **Update `brain.config.yaml`** — add a section for the new brain with its own page types and canonical pages.

5. **Update `.gitignore`** — add the binary patterns for the new brain's `raw/processed/`.

6. **Update the site** — point `site/src/lib/wiki.ts` at both brain directories (see `WIKI_DIRS` in that file).

## Cross-brain linking

Brains can reference each other with prefixed wikilinks:

```markdown
See [[projects-brain:retrieval-pipeline]] for the implementation.
```

The site and the query agent resolve these across brain boundaries. Unprefixed links resolve within the current brain first.

## Shared guardrails

Canonical pages can be shared across brains. A `glossary` in `projects-brain/` can serve as the guardrail for `research-brain/` too — the config defines which canonical pages each brain respects. Sharing a glossary is usually a good idea; sharing a taxonomy usually is not, since taxonomies are what make the brains different in the first place.
