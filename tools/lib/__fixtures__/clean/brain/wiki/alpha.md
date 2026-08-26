---
title: "Alpha System"
type: topic
tier: curated
origin: source
status: draft
confidence: high
tags: [alpha]
aliases: ["Alpha"]
owner: ""
date_created: "2026-01-01"
date_modified: "2026-01-05"
last_verified: "2026-01-05"
sources:
  - id: alpha-pdf
    path: brain/raw/extracted/alpha.pdf.txt
    sha256: "3b50e003ca81fc8afceca1f8d8a259adfd2a3940144e429640ee160e4f8677d9"
    title: "Alpha System Overview"
related:
  - "[[beta]]"
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

## Summary

Alpha is the scheduling subsystem inside [[beta]].

## Details

The scheduler retries on a fixed 30-second backoff. [source: alpha-pdf, p.3]

| Parameter | Value | Source |
|---|---|---|
| Backoff | 30 s | [source: alpha-pdf, p.3, (2026-01-01)] |

## Open questions

- What is the ceiling under load? [source: unknown]
