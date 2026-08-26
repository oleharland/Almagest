---
title: "Remote Sources, Pinned Wrong"
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
  # Parses, but pins a commit the manifest has moved past — PROV-003.
  - id: platform-adr
    path: "github:acme/platform-docs/adr/0007-caching.md@deadbee"
    sha256: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    title: "ADR-0007 Caching strategy"
  # Does not parse as a remote path at all — PROV-001.
  - id: broken-remote
    path: "github:acme@abc"
    sha256: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
related:
  - "[[bad-schema]]"
---

## Summary

Remote sources are never on disk, so `PROV-001` checks the grammar and the
manifest commit instead. [source: platform-adr, §Caching]
