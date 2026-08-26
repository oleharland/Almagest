# Index

Catalog of all wiki pages and ingested sources for the Kestrel Basin benchmark
fixture. The machine-readable counterpart is `manifest.yaml`.

## Wiki pages

| Page | Type | Tier | Status | Last modified |
|------|------|------|--------|---------------|
| [[kestrel-basin-tidal-array]] | topic | curated | draft | 2027-10-01 |
| [[vm-320-turbine]] | entity | curated | draft | 2027-10-01 |
| [[gannet-narrows-site-conditions]] | topic | evidence | draft | 2027-10-01 |
| [[harrowgate-grid-connection]] | entity | curated | draft | 2027-10-01 |
| [[marrowfen-coastal-authority]] | entity | curated | stub | 2027-10-01 |

## Raw sources (local)

| Source file | Source id | Doc ID | Date | Ingested | Pages created/updated |
|------------|-----------|--------|------|----------|-----------------------|
| `raw/kb-01-programme-charter.md` | `kb-01-charter` | MCA-CHT-0001 | 2027-01-18 | 2027-10-01 | kestrel-basin-tidal-array, vm-320-turbine, marrowfen-coastal-authority |
| `raw/kb-02-site-survey-report.md` | `kb-02-survey` | MCA-SUR-0014 | 2027-04-11 | 2027-10-01 | gannet-narrows-site-conditions, harrowgate-grid-connection, marrowfen-coastal-authority |
| `raw/kb-03-vendor-technical-note.md` | `kb-03-vendor-note` | VMS-TN-2027-041 | 2027-06-15 | 2027-10-01 | vm-320-turbine, kestrel-basin-tidal-array |
| `raw/kb-04-independent-verification-memo.md` | `kb-04-verification-memo` | HVS-MEM-0207 | 2027-06-15 | 2027-10-01 | vm-320-turbine, kestrel-basin-tidal-array, gannet-narrows-site-conditions, marrowfen-coastal-authority |
| `raw/kb-05-grid-connection-agreement.md` | `kb-05-grid-agreement` | WGN-CA-4471 | 2027-09-30 | 2027-10-01 | harrowgate-grid-connection, kestrel-basin-tidal-array, marrowfen-coastal-authority |

The **source id** column is what inline `[source: ...]` citations name. The
**Doc ID** is the document's own reference, and is what a citation back to the
original should quote.

## Remote sources

| Repo | Path | Last ingested | Commit | Pages created/updated |
|------|------|---------------|--------|-----------------------|
| _(none)_ | | | | |

## Known gaps

Topics named as out of scope or absent by the sources themselves, with no content anywhere in the corpus:

| Topic | Named absent by |
|-------|-----------------|
| Decommissioning, end-of-life removal, seabed restoration | MCA-CHT-0001 §5, VMS-TN-2027-041 §6, WGN-CA-4471 §6 |
| Operational staffing and workforce planning | MCA-CHT-0001 §5, WGN-CA-4471 §6 |
| Control-system / telemetry security | MCA-CHT-0001 §5, WGN-CA-4471 §6 |
| Energy yield, capacity factor, lifetime output | HVS-MEM-0207 §6 |
| Connection charge amount | WGN-CA-4471 §4 (appendix C confidential) |
