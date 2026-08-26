---
title: "Harrowgate Grid Connection"
type: entity
tier: curated
origin: source
status: draft
confidence: high
entity_type: system
tags: [grid, kestrel-basin, wold-grid-networks]
aliases: ["WGN-CA-4471", "Harrowgate Substation connection"]
owner: ""
date_created: "2027-10-01"
date_modified: "2027-10-01"
last_verified: "2027-10-01"
sources:
  - id: kb-05-grid-agreement
    path: raw/kb-05-grid-connection-agreement.md
    sha256: "73e3b6f11c935f58b203e4d480f416bf2cfdceb6637dbb07fdb3e592189b4e37"
    title: "WGN-CA-4471 Grid Connection Agreement"
  - id: kb-02-survey
    path: raw/kb-02-site-survey-report.md
    sha256: "0302378d51d72c323c7ac02f0dfba2962b4f1cc84fcaa30d06689a4eef060c46"
    title: "MCA-SUR-0014 Kestrel Basin Physical Site Survey Report"
related:
  - "[[kestrel-basin-tidal-array]]"
  - "[[gannet-narrows-site-conditions]]"
  - "[[marrowfen-coastal-authority]]"
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on:
    - "[[marrowfen-coastal-authority]]"
---

## Summary

Executed grid connection agreement WGN-CA-4471 between Wold Grid Networks and [[marrowfen-coastal-authority]] for [[kestrel-basin-tidal-array]]. Connection is at the 132 kV busbar, Harrowgate Substation bay 4, with 50 MW firm export capacity.

## Connection

| Parameter | Value | Source |
|-----------|-------|--------|
| Connection point | 132 kV busbar, Harrowgate Substation, bay 4 | [source: kb-05-grid-agreement, §1, (2027-09-30)] |
| Firm export capacity | 50 MW | [source: kb-05-grid-agreement, §2, (2027-09-30)] |
| Import capacity (auxiliary) | 2 MW | [source: kb-05-grid-agreement, §2, (2027-09-30)] |
| Connection voltage | 132 kV | [source: kb-05-grid-agreement, §2, (2027-09-30)] |

Firm export capacity is a network limit, not a statement about the Generator's plant rating. It is therefore not a third capacity claim against the 48 MW / 43.5 MW dispute on [[kestrel-basin-tidal-array]].
[source: kb-05-grid-agreement, §2, (2027-09-30)]

## Dates

| Milestone | Date | Source |
|-----------|------|--------|
| Substation bay works complete | Q1 2029 | [source: kb-05-grid-agreement, §3, (2027-09-30)] |
| Energisation | Q2 2029 | [source: kb-05-grid-agreement, §3, (2027-09-30)] |
| Generator commissioning | Q3 2029 | [source: kb-05-grid-agreement, §3, (2027-09-30)] |

## Commercial terms

| Term | Value | Source |
|------|-------|--------|
| Delay damages | Accrue against the Connection Provider from the day after energisation date if the bay is not energised, capped at 4 percent of connection charges | [source: kb-05-grid-agreement, §3a, (2027-09-30)] |
| Charging basis | Annual, levied on firm export capacity | [source: kb-05-grid-agreement, §4, (2027-09-30)] |
| Term | Execution to the earlier of 30 years or termination by the Connection Provider on 24 months notice | [source: kb-05-grid-agreement, §5, (2027-09-30)] |

## Cable route

The export cable reaches the substation from the Thorne Point landfall, 3.1 km overland. See [[gannet-narrows-site-conditions]].
[source: kb-02-survey, §5, (2027-04-11)]

## Open questions

- **The connection charge amount is not available.** The charge schedule is in appendix C, described as commercially confidential and not reproduced in the agreement text. [source: kb-05-grid-agreement, §4, (2027-09-30)]
- **The agreement does not address decommissioning, export cable removal at end of term, workforce arrangements, or control-system security.** [source: kb-05-grid-agreement, §6, (2027-09-30)]
- **The 30-year agreement term exceeds the 25-year design operating life on [[kestrel-basin-tidal-array]].** No source states what happens in the gap. [source: unknown]
