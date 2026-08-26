---
title: "Fixed retry backoff makes Feature X unsuitable for bursty workloads"
type: claim                       # see brain.config.yaml → page_types
tier: curated                     # canonical | curated | evidence
origin: self                      # YOUR conclusion — no inline citations required
status: draft                     # stub | draft | evergreen
confidence: medium                # high | medium | low | unknown
tags: [example, scheduling]
aliases: []
owner: ""
date_created: "2026-08-26"
date_modified: "2026-08-26"
last_verified: "2026-08-26"
sources: []                       # empty is legal here — origin: self
related:
  - "[[_example]]"
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on:
    - "[[_example]]"              # if the retry-backoff fact falls, this claim falls
---

> **This is an example page.** It shows a `claim` page: `origin: self`, no inline
> citations in the body, and a `## Basis` section of wikilinks carrying the weight.
> Delete it when you create your first real page.

## Summary

Feature X should not be put in front of bursty workloads. A fixed 30-second retry backoff turns a short burst of failures into a queue that drains at a rate the operator cannot tune, and the failover that would absorb the burst is not shipped.

## Basis

- [[_example]]

## Argument

The backoff is fixed, so recovery time scales linearly with burst depth and nothing in the configuration surface changes that. Multi-region failover is the documented mitigation and it is on the roadmap rather than in the product, so the mitigation is unavailable in every currently shippable topology.

Constraint-aware scheduling helps steady-state utilisation and does not help here — it schedules work, it does not shorten a retry interval.

## Open questions

- Does the backoff become configurable in the roadmap release that adds failover?
- At what burst depth does the queue stop draining within an operator's tolerance? Unmeasured, because throughput under sustained load is itself unmeasured.
