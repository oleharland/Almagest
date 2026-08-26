---
title: "Citations That Do Not Check Out"
type: topic
tier: curated
origin: source
status: draft
confidence: medium
tags: [dirty]
aliases: []
owner: engineering
date_created: "2026-01-01"
date_modified: "2026-01-05"
last_verified: "2026-01-05"
sources:
  - id: dirty-src
    path: brain/raw/extracted/dirty.txt
    sha256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    title: "Dirty fixture source"
related:
  - "[[bad-schema]]"
relations:
  supports: []
---

## Summary

Every citation below fails a different way.

## Details

The retired prose form does not parse.
[source: Dirty Fixture / Overview, §Failover, p.3]

The id is well-formed but is not in this page's `sources`.
[source: not-declared, p.1]

This paragraph makes an assertion and cites nothing at all.

The page's own digest disagrees with the manifest's, so every citation on it is
stale. [source: dirty-src, p.1]
