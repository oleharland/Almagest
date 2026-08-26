# Brain — Reader Instructions

**Load this when** you are about to answer a question from the knowledge base — anything that reads `brain/wiki/`, `brain/.index/`, or `brain/index.md`, and anything that writes a citation. Read it in full first; it is the authoritative version.

Rules for answering questions from this knowledge base. These apply to anyone querying the vault.

## Vault structure

```
brain/
├── raw/              <- intake queue (drop new files here)
│   ├── extracted/    <- committed text sidecars for binary sources
│   └── processed/    <- archive of everything ever ingested
├── wiki/             <- flat knowledge pages (the source of truth)
├── .index/           <- pages.tsv + aliases.tsv (generated — grep these first)
├── index.md          <- catalog of all pages + all sources (for humans)
├── manifest.yaml     <- record of every ingested source (for the agent)
├── canonical-challenges.md <- rejected data that contradicts a canonical page
├── log.md            <- audit trail of all actions
└── rules-index.md    <- index of the rule files
```

Rules live in `agent/rules/` — this file, plus `agent/rules/ingest.md` and `agent/rules/wiki.md`.

## Query protocol

1. **Grep `brain/.index/pages.tsv`** for the entities, aliases, tags, or types the question names. Its columns are `slug title type tier status origin confidence aliases tags source_ids backlinks last_verified`, tab-separated, one row per page; `brain/.index/aliases.tsv` maps every alias *and* every lowercased title to a slug, so "is there already a page for X" is one grep. Read whole rows, not the whole file.

   *Why this and not `index.md`:* reading the catalog before every question costs context proportional to the size of the brain, and that cost lands on every question regardless of how narrow it is. `pages.tsv` is greppable, so retrieval scales with the answer instead of the corpus.

   Fall back to `brain/index.md` when you need orientation rather than lookup — what this brain covers, how it is grouped, which sources exist. Fall back to it also when `.index/` is missing or `tools/audit.mjs --check-index` reports it stale; say so in the answer, because a stale index means you may not have seen a page that exists.
2. Read the wiki pages the grep named, in full. A `pages.tsv` row is a pointer, never a source — never answer from the row alone.
3. Answer from the page bodies, with citations (format below).
4. If the answer synthesizes new understanding → propose it as a `claim` page (`origin: self`, with `## Basis`) to the user. Do not write it; wiki writes go through `agent/rules/wiki.md`.

## Citation grammar

Frozen and parseable, because `tools/audit.mjs` checks it:

```
[source: <id>, <locator>]
[source: <id>, <locator>, (<date>)]
[source: unknown]
```

- `<id>` MUST match an `id` in that page's `sources` list, or be the literal `unknown`. It is a short kebab-case slug — `kb-02-site-survey`, not a title.
- `<locator>` is one of: `§<section name>` · `p.<n>` · `pp.<n>-<m>` · `row <n>` · `slide <n>` · `t <hh:mm:ss>` · `line <n>`.
- The human-readable label of the source lives in `sources[].title` in the page's frontmatter. **It does not go in the citation.** The old prose form — `[source: System Documentation / Architecture, §Failover, p.3]` — is retired; it could not be checked against anything.

When you answer a user, resolve the `id` to its `sources[].title` and `path` for them. The page cites by `id` so a machine can verify it; you quote the title so a human can find it.

## Citation format for query answers

Every claim must give the reader two things:

1. **The wiki page** it came from (so they can read the full context)
2. **The original source** behind that page's claim (so they can verify)

### Single-source format

```
A: Yes. The system supports automatic failover with constraint-aware
   routing and load balancing.

   Source: [[system-architecture]], §Failover
   Original: "System Documentation / Architecture Overview" (arch-overview), p.3
             brain/raw/extracted/architecture-overview.pdf.txt
```

The page's own line reads `... load balancing. [source: arch-overview, p.3]`;
`arch-overview` resolves through that page's `sources` to the title and path
shown above.

### Multi-source format

Cite each claim separately:

```
A: Service A has full support for real-time processing. Service B has
   partial support — it handles batch processing but lacks streaming.

   [[service-comparison]], §Coverage Matrix
   Original: "Capability Assessment" (cap-assessment), §Coverage, 2026-06

   [[service-b]], §Processing
   Original: "Service B Documentation v3" (svc-b-docs-v3), p.7
```

### Synthesis flag

If the answer requires inference beyond what a single source states:

```
   Synthesized from [[system-architecture]] + [[performance-profile]]
   — no single source makes this claim directly.
```

## Answering from `origin: self` pages

A page with `origin: self` — normally a `claim` page — is the author's own conclusion, not something a source said. Its body carries no `[source:]` citations by design; its `## Basis` section lists wikilinks to the `origin: source` pages the conclusion rests on.

Treat those pages as a different kind of evidence, and say so:

- **Attribute it.** "This is a conclusion recorded in this brain, not a claim from a source" — never present it as if a document stated it.
- **Show the basis.** Reproduce the `## Basis` wikilinks in the answer. The basis is the only thing that makes the conclusion checkable.
- **Say when it is the whole answer.** If nothing `origin: source` supports the point independently, the honest answer is "the brain concludes X on the basis of Y and Z; no source states X directly."
- **Do not launder it.** A claim page cited by another page does not turn its conclusion into sourced fact. Follow the `## Basis` down to `origin: source` pages before asserting anything as established.
- `relations.supports` / `relations.contradicts` on a claim page tell you what else in the brain agrees or disagrees. If a claim you are about to rely on names a `contradicts` target, surface both.

`confidence` is a real signal on these pages. `confidence: low` on a claim page means the author flagged it as shaky — never present it flatly.

## Citation rules

- **No unsourced claims.** If you can't cite it, mark it `[source: unknown]` and add to `## Open questions`.
- **Cite the original, not just the wiki page.** The wiki page is the index; the original source is the authority. Always provide both when answering queries.
- **Precision over brevity.** `§Failover, p.3` is better than `Architecture Overview`. The reader should be able to find the passage in under 30 seconds — and for a binary source the sidecar in `brain/raw/extracted/` carries `=== page 3 ===` markers, so the locator lands somewhere real.
- **A stale citation is a broken one.** If `tools/audit.mjs` reports `CITE-005` on a page you are about to quote (the page's `sources[].sha256` no longer matches `manifest.yaml`), say the source has changed since the page was written rather than quoting the locator as current.
- **Never invent an `id`.** If the claim you want to cite has no matching entry in that page's `sources`, it is unsourced — that is `CITE-002`, and it is an error, not a formatting problem.

## Capability tier

| Task | Tier | Why |
|------|------|-----|
| Query — index grep and retrieval | mechanical | Matching slugs and aliases against a TSV |
| Query — factual lookup | mechanical | Retrieve and cite, no synthesis needed |
| Query — cross-source synthesis | **judgment** | Connecting evidence across multiple pages, building an argument, spotting gaps |
| Query — weighing an `origin: self` claim | **judgment** | Deciding whether the basis actually carries the conclusion |
| Query — strategic questions | **judgment** | "What's the strongest case for/against X" needs depth |

**Rule of thumb:** if the agent is comparing strings or checking structure -> mechanical. If it's making a recommendation the user will act on -> judgment.

Tiers map to concrete models via `brain.config.yaml` → `agent.profiles[agent.harness]`. This is advisory: steps marked **judgment** warrant your most capable available model; if your harness cannot switch models, run the whole session on it.
