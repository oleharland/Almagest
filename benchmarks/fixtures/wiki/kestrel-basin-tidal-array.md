---
title: "Kestrel Basin Tidal Array"
type: topic
tier: curated
origin: source
status: draft
confidence: high
tags: [tidal, marrowfen, programme]
aliases: ["KBTA"]
owner: ""
date_created: "2027-10-01"
date_modified: "2027-10-01"
last_verified: "2027-10-01"
sources:
  - id: kb-01-charter
    path: raw/kb-01-programme-charter.md
    sha256: "29de9f90400b5981439153b2d97b5b7ed4d24558e5d79cff840297341126c718"
    title: "MCA-CHT-0001 Kestrel Basin Tidal Array Programme Charter"
  - id: kb-03-vendor-note
    path: raw/kb-03-vendor-technical-note.md
    sha256: "cfc1a4c7899119c5565ffbd678af66c3bcd1312a8321dabae508adb7f07c9b76"
    title: "VMS-TN-2027-041 VM-320 Technical Note for Kestrel Basin"
  - id: kb-04-verification-memo
    path: raw/kb-04-independent-verification-memo.md
    sha256: "f3f0c0cedff67340c0ff2c94a23b2ba74ee6f3deae122a32093b9f55d16491c4"
    title: "HVS-MEM-0207 Independent Verification Memo"
  - id: kb-05-grid-agreement
    path: raw/kb-05-grid-connection-agreement.md
    sha256: "73e3b6f11c935f58b203e4d480f416bf2cfdceb6637dbb07fdb3e592189b4e37"
    title: "WGN-CA-4471 Grid Connection Agreement"
related:
  - "[[vm-320-turbine]]"
  - "[[gannet-narrows-site-conditions]]"
  - "[[harrowgate-grid-connection]]"
  - "[[marrowfen-coastal-authority]]"
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on:
    - "[[vm-320-turbine]]"
    - "[[harrowgate-grid-connection]]"
---

## Summary

The Kestrel Basin Tidal Array (KBTA) is a 15-unit fixed-bottom tidal stream array in the Kestrel Basin channel, run by [[marrowfen-coastal-authority]] and connected at [[harrowgate-grid-connection]]. Nameplate capacity is disputed — 48 MW per the charter and supplier, 43.5 MW per the independent verifier. Target commissioning is Q3 2029.

## Scope

| Item | Value | Source |
|------|-------|--------|
| Turbine count | 15 units | [source: kb-01-charter, §2, (2027-01-18)] |
| Turbine | VM-320, see [[vm-320-turbine]] | [source: kb-01-charter, §2, (2027-01-18)] |
| Supplier | Verrick Marine Systems | [source: kb-01-charter, §4, (2027-01-18)] |
| Grid operator | Wold Grid Networks | [source: kb-01-charter, §4, (2027-01-18)] |
| Independent verifier | Halbrook Verification Services | [source: kb-01-charter, §4, (2027-01-18)] |
| Design operating life | 25 years from commissioning | [source: kb-01-charter, §2, (2027-01-18)] |

## Capacity

> **Disputed** — two documents issued on the same date give different array capacities, and neither supersedes the other. MCA has issued no direction on which figure is the programme baseline. See [[vm-320-turbine]] §Rating for the underlying per-unit dispute.

| Figure | Value | Source |
|--------|-------|--------|
| Nameplate (charter) | 48 MW | [source: kb-01-charter, §2, (2027-01-18)] |
| Nameplate (supplier) | 48 MW = 15 × 3.2 MW | [source: kb-03-vendor-note, §2, (2027-06-15)] [source: kb-03-vendor-note, §3, (2027-06-15)] |
| Verified site capacity | 43.5 MW = 15 × 2.9 MW | [source: kb-04-verification-memo, §3, (2027-06-15)] |

Halbrook states explicitly that it does not accept 48 MW as the array capacity for Kestrel Basin.
[source: kb-04-verification-memo, §4, (2027-06-15)]

## Schedule

| Milestone | Date | Source |
|-----------|------|--------|
| Target commissioning | Q3 2029 | [source: kb-01-charter, §2, (2027-01-18)] |
| Generator commissioning (grid agreement) | Q3 2029 | [source: kb-05-grid-agreement, §3, (2027-09-30)] |

The charter target and the grid connection agreement agree on Q3 2029.
[source: kb-01-charter, §2, (2027-01-18)] [source: kb-05-grid-agreement, §3, (2027-09-30)]

## Phasing

| Phase | Name | Window | Source |
|-------|------|--------|--------|
| Phase 1 | Site characterisation | 2027-01 → 2027-09 | [source: kb-01-charter, §3, (2027-01-18)] |
| Phase 2 | Detailed design and consent | 2027-10 → 2028-08 | [source: kb-01-charter, §3, (2027-01-18)] |
| Phase 3 | Fabrication and installation | 2028-09 → 2029-07 | [source: kb-01-charter, §3, (2027-01-18)] |
| Phase 4 | Operations | 2029-08 → 2054-08 | [source: kb-01-charter, §3, (2027-01-18)] |

Activity beyond 2054-08 is outside the charter's scope.
[source: kb-01-charter, §3, (2027-01-18)]

## Open questions

- **No decommissioning arrangements exist in any ingested source.** End-of-life removal, seabed restoration, and decommissioning cost are named as out of scope by the charter (§5) and as not covered by the grid agreement (§6). No document states a plan, a cost, a bond, or a responsible party. [source: unknown] — would be resolved by an MCA decommissioning instrument, which has not been issued.
- **No operational staffing establishment exists in any ingested source.** Charter §5 lists workforce planning as out of scope; grid agreement §6 excludes workforce arrangements. Headcount, shift pattern, and shore base are unstated. [source: unknown]
- **No control-system or telemetry security architecture exists in any ingested source.** Charter §5 and grid agreement §6 both exclude it. [source: unknown]
- **No energy yield, capacity factor, or annual output figure exists in any ingested source.** HVS-MEM-0207 §6 states explicitly that it addresses electrical rating only and makes no statement about yield, capacity factor, availability, or lifetime output. [source: unknown] — would be resolved by an energy yield assessment.
- **Which capacity figure is the programme baseline is undirected.** Halbrook has requested a written direction from MCA; none has been received. [source: kb-04-verification-memo, §5, (2027-06-15)]
