---
title: "Cites An Unextractable Scan"
type: topic
tier: curated
origin: source
status: draft
confidence: low
tags: [dirty]
aliases: []
owner: engineering
date_created: "2026-01-01"
date_modified: "2026-01-05"
last_verified: "2026-01-05"
sources:
  - id: scan-pdf
    path: brain/raw/processed/scan.pdf
    sha256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    title: "Unpaginated scan, no OCR"
related:
  - "[[bad-schema]]"
---

## Summary

The manifest records `extracted: none`, so the original is gitignored and
absent on a fresh clone. PROV-001 reports that as a warning, not an error.
[source: scan-pdf, p.1]
