---
title: "VM-320 Tidal Turbine"
type: entity
tier: curated
origin: source
status: draft
confidence: medium
entity_type: product
tags: [tidal, turbine, verrick]
aliases: ["VM-320"]
owner: ""
date_created: "2027-10-01"
date_modified: "2027-10-01"
last_verified: "2027-10-01"
sources:
  - id: kb-03-vendor-note
    path: raw/kb-03-vendor-technical-note.md
    sha256: "cfc1a4c7899119c5565ffbd678af66c3bcd1312a8321dabae508adb7f07c9b76"
    title: "VMS-TN-2027-041 VM-320 Technical Note for Kestrel Basin"
  - id: kb-04-verification-memo
    path: raw/kb-04-independent-verification-memo.md
    sha256: "f3f0c0cedff67340c0ff2c94a23b2ba74ee6f3deae122a32093b9f55d16491c4"
    title: "HVS-MEM-0207 Independent Verification Memo"
  - id: kb-01-charter
    path: raw/kb-01-programme-charter.md
    sha256: "29de9f90400b5981439153b2d97b5b7ed4d24558e5d79cff840297341126c718"
    title: "MCA-CHT-0001 Kestrel Basin Tidal Array Programme Charter"
related:
  - "[[kestrel-basin-tidal-array]]"
  - "[[gannet-narrows-site-conditions]]"
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

## Summary

The VM-320 is a horizontal-axis, bottom-mounted tidal stream turbine from Verrick Marine Systems, selected for [[kestrel-basin-tidal-array]]. Its rated output is disputed: 3.2 MW per unit on the supplier's type test, 2.9 MW per unit as verified for Kestrel Basin conditions.

## Rating

> **Disputed** — the supplier's technical note and the independent verifier's memo were both issued on 2027-06-15 and give different per-unit ratings. HVS-MEM-0207 §4 states the two documents disagree and that neither supersedes the other.

| Claim | Value | Basis | Source |
|-------|-------|-------|--------|
| Supplier rated output | 3.2 MW/unit | Type-test power curve, uniform inflow, no site derating applied | [source: kb-03-vendor-note, §2, (2027-06-15)] [source: kb-03-vendor-note, §5, (2027-06-15)] |
| Verified site output | 2.9 MW/unit | Type-test curve corrected for 14.2% turbulence intensity, blockage, and wake interaction | [source: kb-04-verification-memo, §2, (2027-06-15)] [source: kb-04-verification-memo, §3, (2027-06-15)] |

Rolled up to 15 units this is 48 MW versus 43.5 MW.
[source: kb-04-verification-memo, §3, (2027-06-15)]

Verrick states the 3.2 MW figure has no site-specific derating for turbulence, blockage, or wake interaction.
[source: kb-03-vendor-note, §5, (2027-06-15)]

Halbrook states the 3.2 MW figure is not a site rating and that it does not accept 48 MW as the array capacity.
[source: kb-04-verification-memo, §4, (2027-06-15)]

## Machine parameters

| Parameter | Value | Source |
|-----------|-------|--------|
| Rotor diameter | 20 m | [source: kb-03-vendor-note, §2, (2027-06-15)] |
| Hub height above seabed | 14 m | [source: kb-03-vendor-note, §2, (2027-06-15)] |
| Rated current speed | 3.1 m/s | [source: kb-03-vendor-note, §2, (2027-06-15)] |
| Cut-in current speed | 0.9 m/s | [source: kb-03-vendor-note, §2, (2027-06-15)] |
| Foundation | Gravity base | [source: kb-03-vendor-note, §1, (2027-06-15)] |

## Environmental envelope

| Parameter | Limit | Source |
|-----------|-------|--------|
| Maximum survival current | 4.6 m/s | [source: kb-03-vendor-note, §4, (2027-06-15)] |
| Maximum operating depth | 55 m | [source: kb-03-vendor-note, §4, (2027-06-15)] |
| Maximum significant wave height (operating) | 4.5 m | [source: kb-03-vendor-note, §4, (2027-06-15)] |

## Selection

The VM-320 is the unit named in the programme charter, supplied by Verrick Marine Systems.
[source: kb-01-charter, §2, (2027-01-18)]

## Warranty

Availability warranty of 93 percent for the first 5 operating years.
[source: kb-03-vendor-note, §6, (2027-06-15)]

## Open questions

- **No end-of-life removal or disposal terms exist in any ingested source.** VMS-TN-2027-041 §6 states explicitly that it makes no statement about end-of-life removal or disposal. [source: kb-03-vendor-note, §6, (2027-06-15)]
- **Which per-unit rating is the programme baseline is undirected.** [source: kb-04-verification-memo, §5, (2027-06-15)]
- **No unit price or supply contract value exists in any ingested source.** [source: unknown]
