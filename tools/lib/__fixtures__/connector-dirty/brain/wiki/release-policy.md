---
title: "Release Policy"
type: topic
tier: evidence
origin: source
status: draft
confidence: high
tags: [release]
aliases: []
owner: ""
date_created: "2026-01-05"
date_modified: "2026-01-05"
last_verified: "2026-01-05"
sources:
  - id: drive-release-policy
    path: brain/raw/extracted/product-drive/1abcdefghijk-a24224a1.txt
    sha256: "ac4e1a1a82cbda5cd119a77100ffd01aaa046bedfe855e512169979e0fb2aec2"
    title: "Release Policy (Google Drive)"
  - id: release-sync-call
    path: brain/raw/extracted/team-calls/not-abc123def456gh-6eeedaeb.txt
    sha256: "7c7be2da5871b5b92e087ab6c7ea744e33149422f859efec2448d88997f30a64"
    title: "Release sync (Granola)"
related:
  - "[[release-cadence]]"
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

## Summary

How releases ship and how a failed one is undone; cadence is in [[release-cadence]].

## Details

A failed release is rolled back within 30 minutes. [source: drive-release-policy, §Failover]

The rollback budget was restated as thirty minutes in the release sync. [source: release-sync-call, t 00:12:34]
