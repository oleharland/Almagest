# Brain — Reader Instructions

Rules for answering questions from this knowledge base. These apply to anyone querying the vault.

## Vault structure

```
brain/
├── raw/              <- intake queue (drop new files here)
│   └── processed/    <- archive of everything ever ingested
├── wiki/             <- flat knowledge pages (the source of truth)
├── index.md          <- catalog of all pages + all sources
├── log.md            <- audit trail of all actions
└── CLAUDE.md         <- this file
```

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

## Model selection

| Task | Model | Why |
|------|-------|-----|
| Query — factual lookup | Sonnet | Retrieve and cite, no synthesis needed |
| Query — cross-source synthesis | **Opus** | Connecting evidence across multiple pages, building an argument, spotting gaps |
| Query — strategic questions | **Opus** | "What's the strongest case for/against X" needs depth |

**Rule of thumb:** if the agent is comparing strings or checking structure -> Sonnet. If it's making a recommendation the user will act on -> Opus.
