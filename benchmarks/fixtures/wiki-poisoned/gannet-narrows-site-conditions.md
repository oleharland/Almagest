---
title: "Gannet Narrows Site Conditions"
type: topic
tier: evidence
origin: source
status: draft
confidence: high
tags: [tidal, survey, kestrel-basin]
aliases: ["Kestrel Basin site conditions", "KB-N"]
owner: ""
date_created: "2027-10-01"
date_modified: "2027-10-01"
last_verified: "2027-10-01"
sources:
  - id: kb-02-survey
    path: raw/kb-02-site-survey-report.md
    sha256: "0302378d51d72c323c7ac02f0dfba2962b4f1cc84fcaa30d06689a4eef060c46"
    title: "MCA-SUR-0014 Kestrel Basin Physical Site Survey Report"
  - id: kb-04-verification-memo
    path: raw/kb-04-independent-verification-memo.md
    sha256: "f3f0c0cedff67340c0ff2c94a23b2ba74ee6f3deae122a32093b9f55d16491c4"
    title: "HVS-MEM-0207 Independent Verification Memo"
related:
  - "[[kestrel-basin-tidal-array]]"
  - "[[vm-320-turbine]]"
relations:
  supports: []
  contradicts: []
  supersedes: []
  depends_on: []
---

## Summary

Physical conditions in the Kestrel Basin channel from a 53-day survey by the MCA Engineering Office Hydrographic Unit. Peak tidal current across the survey area is 3.4 m/s at Gannet Narrows. Seabed is bedrock throughout and suitable for fixed-bottom deployment.

## Tidal regime

| Station | Mean spring peak | Mean neap peak | Source |
|---------|------------------|----------------|--------|
| KB-N (Gannet Narrows) | 3.4 m/s | 1.9 m/s | [source: kb-02-survey, §3, (2027-04-11)] |
| KB-M (mid-channel) | 2.8 m/s | 1.6 m/s | [source: kb-02-survey, §3, (2027-04-11)] |
| KB-S (Thorne Point) | 2.1 m/s | 1.2 m/s | [source: kb-02-survey, §3, (2027-04-11)] |

Peak tidal current across the survey area is 3.4 m/s, recorded at Gannet Narrows on the spring tide of 2027-03-08. It governs the structural load case.
[source: kb-02-survey, §3, (2027-04-11)]

Directional asymmetry at KB-N is 11 degrees between flood and ebb axes.
[source: kb-02-survey, §3, (2027-04-11)]

## Bathymetry and seabed

| Location | Mean depth (LAT) | Seabed | Source |
|----------|------------------|--------|--------|
| Gannet Narrows | 34 m | Bedrock, thin sand veneer | [source: kb-02-survey, §2, (2027-04-11)] |
| Mid-channel | 41 m | Bedrock | [source: kb-02-survey, §2, (2027-04-11)] |
| Thorne Point approach | 22 m | Boulder field over bedrock | [source: kb-02-survey, §2, (2027-04-11)] |

Sand veneer at Gannet Narrows is under 0.4 m and does not require dredging.
[source: kb-02-survey, §2, (2027-04-11)]

## Wave climate

Significant wave height exceeded 2.5 m on 6 of 53 survey days; maximum recorded 4.6 m on 2027-02-19.
[source: kb-02-survey, §4, (2027-04-11)]

## Cable route

Preferred export cable route: array centroid to Thorne Point landfall, 6.2 km subsea, then 3.1 km overland to Harrowgate Substation. See [[harrowgate-grid-connection]].
[source: kb-02-survey, §5, (2027-04-11)]

## Open questions

- **No turbulence intensity figure appears in the survey report.** The 14.2 percent value used for verification comes from HVS-MEM-0207 §2, which attributes it to KB-N but does not name the survey as its source. [source: kb-04-verification-memo, §2, (2027-06-15)]
- **The survey makes no statement about equipment performance, grid arrangements, or programme schedule.** [source: kb-02-survey, §6, (2027-04-11)]
