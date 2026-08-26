---
title: "Every Enum Wrong"
type: nonesuch
tier: gold
origin: derived
status: wip
confidence: certain
tags: [dirty]
aliases: []
owner: marketing
date_created: "2026-01-01"
date_modified: "2026-01-05"
last_verified: "2026-01-05"
sources: []
related:
  - "[[bad-schema]]"
relations:
  supports: []
  endorses:
    - "[[bad-schema]]"
---

## Summary

`type`, `tier`, `origin`, `status` and `confidence` are all outside their
vocabularies — SCHEMA-002. `relations.endorses` is not a relation type.
`owner: marketing` is not in `owner_teams` — SCHEMA-004.
