# Brain — Reader Instructions

**Load this when** you are about to answer a question from the knowledge base — anything that reads `brain/wiki/` or `brain/index.md`, and anything that writes a citation. Read it in full first; it is the authoritative version.

Rules for answering questions from this knowledge base. These apply to anyone querying the vault.

## Vault structure

```
brain/
├── raw/              <- intake queue (drop new files here)
│   └── processed/    <- archive of everything ever ingested
├── wiki/             <- flat knowledge pages (the source of truth)
├── index.md          <- catalog of all pages + all sources (for humans)
├── manifest.yaml     <- record of every ingested source (for the agent)
├── log.md            <- audit trail of all actions
└── rules-index.md    <- index of the rule files
```

Rules live in `agent/rules/` — this file, plus `agent/rules/ingest.md` and `agent/rules/wiki.md`.

## Query protocol

1. **Read `index.md` first** to understand available content
2. Retrieve relevant wiki pages
3. Answer from captured content with source citations (see format below)
4. If the answer synthesizes new understanding -> propose a new wiki page or update to the user

## Citation format for query answers

Every claim must cite:

1. **The wiki page** it came from (so the user can read the full context)
2. **The original source** behind that wiki page's claim (so the user can verify)

### Single-source format

```
A: Yes. The system supports automatic failover with constraint-aware
   routing and load balancing.

   Source: [[system-architecture]], §Failover
   Original: System Documentation / Architecture Overview, §Failover, p.3
```

### Multi-source format

Cite each claim separately:

```
A: Service A has full support for real-time processing. Service B has
   partial support — it handles batch processing but lacks streaming.

   [[service-comparison]], §Coverage Matrix
   Original: Capability Assessment, §Coverage, 2026-06

   [[service-b]], §Processing
   Original: Service B Documentation v3, §Current Capabilities, p.7
```

### Synthesis flag

If the answer requires inference beyond what a single source states:

```
   Synthesized from [[system-architecture]] + [[performance-profile]]
   — no single source makes this claim directly.
```

## Citation rules

- **No unsourced claims.** If you can't cite it, mark it `[source: unknown]` and add to `## Open questions`.
- **Cite the original, not the wiki page.** The wiki page is the index; the original source is the authority. Always provide both when answering queries.
- **Precision over brevity.** `§Failover, p.3` is better than `Architecture Overview`. The reader should be able to find the passage in under 30 seconds.

## Capability tier

| Task | Tier | Why |
|------|------|-----|
| Query — factual lookup | mechanical | Retrieve and cite, no synthesis needed |
| Query — cross-source synthesis | **judgment** | Connecting evidence across multiple pages, building an argument, spotting gaps |
| Query — strategic questions | **judgment** | "What's the strongest case for/against X" needs depth |

**Rule of thumb:** if the agent is comparing strings or checking structure -> mechanical. If it's making a recommendation the user will act on -> judgment.

Tiers map to concrete models via `brain.config.yaml` → `agent.profiles[agent.harness]`. This is advisory: steps marked **judgment** warrant your most capable available model; if your harness cannot switch models, run the whole session on it.
