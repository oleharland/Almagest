---
title: "Fixed backoff makes Beta unsuitable for bursty workloads"
type: claim
tier: curated
origin: self
status: draft
confidence: medium
tags: [beta]
aliases: []
owner: ""
date_created: "2026-01-05"
date_modified: "2026-01-05"
last_verified: "2026-01-05"
sources: []
related:
  - "[[beta]]"
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on:
    - "[[alpha]]"
---

## Summary

Beta should not front bursty workloads.

## Basis

- [[alpha]]
- [[beta]]

## Argument

A fixed backoff makes recovery time scale linearly with burst depth, and nothing in the configuration surface changes that.
