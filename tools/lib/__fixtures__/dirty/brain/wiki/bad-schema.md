---
title: "Missing Almost Everything"
type: organisation
tags: [dirty]
date_created: "2026-01-01"
date_modified: "2026-01-05"
sources:
  - "raw/processed/gone.pdf"
related:
  - "[[bad-enum]]"
---

## Summary

Missing `tier`, `status`, `confidence` and `origin` — SCHEMA-001 four times over.
`type: organisation` is an `entity_type` value, not a page type — SCHEMA-005.
No `owner` while `require_owner: true` — SCHEMA-004. The single source is still
the retired v1 string form.
