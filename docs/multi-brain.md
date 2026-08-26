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
│   └── CLAUDE.md
├── projects-brain/             ← what you BUILD (systems, decisions, runbooks)
│   ├── raw/
│   │   └── processed/
│   ├── wiki/
│   ├── index.md
│   ├── log.md
│   └── CLAUDE.md
├── site/                       ← reads from ALL brains
├── brain.config.yaml           ← config for all brains
└── .claude/rules/
    ├── research-brain-ingest.md
    ├── research-brain-wiki.md
    ├── projects-brain-ingest.md
    └── projects-brain-wiki.md
```

## How to add a second brain

1. **Duplicate the `brain/` directory** with a new name:
   ```bash
   cp -r brain/ research-brain/
   rm -rf research-brain/wiki/*.md research-brain/raw/processed/*
   ```

2. **Create rules files** for the new brain:
   ```bash
   cp .claude/rules/brain-ingest.md .claude/rules/research-brain-ingest.md
   cp .claude/rules/brain-wiki.md  .claude/rules/research-brain-wiki.md
   ```

3. **Update the `paths:` frontmatter** in the new rules files so they activate on the right directory:
   ```yaml
   # research-brain-ingest.md
   paths:
     - "research-brain/raw/**"
   ```
   ```yaml
   # research-brain-wiki.md
   paths:
     - "research-brain/wiki/**"
   ```

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
