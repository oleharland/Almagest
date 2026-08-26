# brain/raw/extracted/

Committed plain-text sidecars for binary sources.

`brain/raw/processed/` holds the originals, and its binaries are gitignored — PDFs,
video, spreadsheets, decks, images. On a fresh clone those files are simply not
there. Every citation pointing into them would then be permanently unverifiable:
the receipt survives in `manifest.yaml`, the evidence does not.

This directory is the evidence. One `.txt` per binary source, committed, diffable,
greppable.

## Naming

`<original-filename-with-extension>.txt` — the original name is kept whole so the
mapping back is unambiguous.

| Original | Sidecar |
|---|---|
| `brain/raw/processed/system-overview.pdf` | `brain/raw/extracted/system-overview.pdf.txt` |
| `brain/raw/processed/capability-matrix.xlsx` | `brain/raw/extracted/capability-matrix.xlsx.txt` |
| `brain/raw/processed/kickoff-call.mp4` | `brain/raw/extracted/kickoff-call.mp4.txt` |

Names are sanitized before the sidecar is written — see
`agent/rules/ingest.md` → *Filename sanitization*. The sidecar inherits the
sanitized name.

## Page markers

A locator in a citation has to resolve to a place in the sidecar, so the extraction
carries markers. A marker sits alone on its own line and contains exactly:

```
=== page 12 ===
=== slide 4 ===
=== sheet: Capability Matrix ===
=== t 00:14:32 ===
```

Marker vocabulary is fixed. Do not invent `--- page 12 ---`, `[page 12]`, or
`=== Page 12 ===`.

## Rules

- **Full text, never a summary.** A summarised sidecar cannot verify a citation,
  which is the only reason this directory exists.
- **The sidecar is what pages cite.** `sources[].path` points here for binary
  sources, and `sources[].sha256` is the digest of the sidecar.
- **Agent-written.** Hand-edit only to fix a broken extraction, and re-run
  `tools/audit.mjs` afterwards — the digest on every citing page has to follow.
- **Committed.** `.gitignore` re-includes this whole directory on purpose.

Full protocol: `agent/rules/ingest.md` → *Extracted-source sidecars*.
