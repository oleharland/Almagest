---
title: "Connector Drift"
type: topic
tier: evidence
origin: source
status: draft
confidence: medium
tags: [dirty]
aliases: []
owner: ""
date_created: "2026-01-05"
date_modified: "2026-01-05"
last_verified: "2026-01-05"
sources:
  # Manifest entry has no `ref` — PROV-003.
  - id: wiki-owners
    path: brain/raw/extracted/wiki-export/owners-1a2b3c4d.txt
    sha256: "be71ff064d6c5a6a43e631dddd034942f0dae5723217ef63f0e2083a895437cc"
  # Ephemeral snapshot, not committed — PROV-001 warning.
  - id: eng-channel
    path: brain/raw/extracted/slack-eng/c024be91l-0badc0de.txt
    sha256: "1111111111111111111111111111111111111111111111111111111111111111"
  # Committed-mode snapshot missing from the repo — PROV-001 error.
  - id: eng-42
    path: brain/raw/extracted/linear-eng/eng-42-deadbeef.txt
    sha256: "2222222222222222222222222222222222222222222222222222222222222222"
  # A snapshot no manifest entry records — PROV-003.
  - id: notion-orphan
    path: brain/raw/extracted/notion-wiki/orphan-5e6f7a8b.txt
    sha256: "c89d1e52eabf004c584c76dec739a2f7786f59d1ce52e9db702bdf05fdb676e1"
related:
  - "[[release-policy]]"
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

## Summary

Connector provenance gone wrong, one way per source; see [[release-policy]].

## Details

Ops owns releases. [source: wiki-owners, §Owners]

Releases are announced in the channel. [source: eng-channel, row 1]

Rollbacks are tracked as issues. [source: eng-42, §Properties]

Nobody recorded this snapshot. [source: notion-orphan, §Notes]
