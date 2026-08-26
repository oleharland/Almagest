---
title: "Example Topic"
type: topic                       # see brain.config.yaml → page_types
tier: curated                     # canonical | curated | evidence
origin: source                    # source | self — see agent/rules/wiki.md
status: draft                     # stub | draft | evergreen
confidence: medium                # high | medium | low | unknown
tags: [example]                   # lowercase, for filtering
aliases: ["Example Subject"]      # alternative names for this page's subject
owner: ""                         # optional — see brain.config.yaml → require_owner
date_created: "2026-01-01"
date_modified: "2026-08-26"
last_verified: "2026-08-26"       # last human confirmation date
sources:                          # objects, not paths — `id` is what citations name
  - id: example-doc
    path: brain/raw/extracted/example-doc.pdf.txt
    sha256: "0000000000000000000000000000000000000000000000000000000000000000"
    title: "Example Documentation v2.1"
related:                          # untyped "see also"
  - "[[_example-claim]]"
relations:                        # typed edges — omit any key you do not use
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

> **This is an example page.** It shows schema v2 for an `origin: source` page —
> every body claim carries an inline citation naming a `sources[].id`.
> Delete it when you create your first real page.
>
> **It is not fully validated.** Its slug starts with `_`, which exempts it from
> `PROV-001`, `PROV-003`, and `CITE-005` — the checks that reach out to the
> filesystem and `manifest.yaml`. That is why the `path` below points at a file
> that does not exist and the `sha256` is zeroes: a template cannot ship with a
> real ingested source. Everything else — schema, links, citation grammar — is
> enforced here exactly as on a real page. Never put a leading underscore on a
> real page; it means "provenance unchecked", not "draft". See `docs/audit.md`.

## Summary

Feature X is the scheduling component of the example system. It ships with constraint-aware scheduling enabled by default. Throughput under sustained load is unmeasured.

## Details

| Capability | State | Citation |
|---|---|---|
| Automatic processing | Shipped | [source: example-doc, p.3] |
| Constraint-aware scheduling | Shipped, default on | [source: example-doc, §Features] |
| Multi-region failover | Not shipped | [source: example-doc, §Roadmap, (2026-03)] |

Retry backoff is fixed at 30 seconds and is not configurable. [source: example-doc, p.14]

## Open questions

- What is the throughput ceiling under sustained load? [source: unknown]
