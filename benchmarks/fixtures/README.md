# Fixture corpus — Kestrel Basin

Everything in this directory is **fictional**. The Marrowfen Coastal Authority,
Verrick Marine Systems, Halbrook Verification Services, Wold Grid Networks, the
VM-320 turbine, and the Kestrel Basin channel do not exist. No real organisation,
product, place, or person appears anywhere in it. No personal names appear at
all — every party is an organisation or a role-holding body.

It lives here, and only here. The benchmark never reads from or writes to
`brain/`, so running it cannot pollute a real knowledge base.

```
fixtures/
├── raw/     5 source documents — what the baseline arm sees
└── wiki/    6 compiled pages   — what the treatment arm sees, plus raw/
```

## The sources

| File | Document ID | Issuer | Date |
|------|-------------|--------|------|
| `raw/kb-01-programme-charter.md` | MCA-CHT-0001 | Marrowfen Coastal Authority | 2027-01-18 |
| `raw/kb-02-site-survey-report.md` | MCA-SUR-0014 | MCA Engineering Office | 2027-04-11 |
| `raw/kb-03-vendor-technical-note.md` | VMS-TN-2027-041 | Verrick Marine Systems | 2027-06-15 |
| `raw/kb-04-independent-verification-memo.md` | HVS-MEM-0207 | Halbrook Verification Services | 2027-06-15 |
| `raw/kb-05-grid-connection-agreement.md` | WGN-CA-4471 | Wold Grid Networks / MCA | 2027-09-30 |

## What is planted where

The corpus is built around four properties. Each one exists so a specific metric
has something real to measure.

### 1. A fact stated in exactly one place

**Peak tidal current, 3.4 m/s at Gannet Narrows** — `kb-02` §3, nowhere else.
Tests plain retrieval and single-source citation (`q01`).

Also single-place: the 93 percent availability warranty (`kb-03` §6, `q02`) and
the delay-damages terms (`kb-05` §3a, `q03`).

### 2. A fact stated consistently in two places

**Target commissioning, Q3 2029** — `kb-01` §2 and `kb-05` §3, in agreement.
Tests whether an answer cites both independent sources or stops at the first
one it finds (`q04`).

### 3. A planted contradiction

**VM-320 rated output: 3.2 MW versus 2.9 MW per unit; array total 48 MW versus
43.5 MW.**

- `kb-03` §2 — Verrick Marine Systems: 3.2 MW/unit, 48 MW array. §5 concedes the
  figure is an uncorrected type-test value.
- `kb-04` §3 — Halbrook Verification Services: 2.9 MW/unit verified for site
  conditions, 43.5 MW array. §4 states Halbrook does not accept 48 MW.

The contradiction is constructed so recency cannot resolve it: **both documents
are dated 2027-06-15**, they come from equally authorised parties named in the
charter, and `kb-04` §4 states in terms that neither supersedes the other.
`kb-04` §5 records that MCA has been asked to direct which figure is the
baseline and has not. There is no correct single answer — only a correct way of
reporting that there isn't one (`q05`, `q06`).

A decoy sits alongside it: `kb-05` §2 gives a **50 MW** firm export capacity,
which is a network limit and not a plant rating. `kb-05` §2 says so explicitly.
Reporting 50 MW as the array capacity is a specific, checkable error.

### 4. A conspicuously absent topic

**Decommissioning.** Nothing anywhere states a plan, a cost, a bond, a date, or
a responsible party. It is conspicuous rather than merely missing: three
documents name it as out of scope (`kb-01` §5, `kb-03` §6, `kb-05` §6), and the
charter's phase table stops at Phase 4 ending 2054-08 with the note that later
activity is outside scope. An agent looking for it will find the hole, not
silence (`q10`).

Three further absences, each with bait attached:

| Absent | Bait present in the corpus | Question |
|--------|---------------------------|----------|
| Energy yield / capacity factor | Full tidal current regime, rated and cut-in speeds, unit count — enough to make a calculation look derivable. `kb-04` §6 disclaims yield explicitly | `q12` |
| Connection charge amount | The charging *basis* is stated (`kb-05` §4); the schedule is in a confidential appendix | `q13` |
| Operational staffing | Named out of scope twice | `q11` |
| Control-system security | Named out of scope twice | `q14` |

`q12` and `q13` are the sharpest tests in the set. Both have real numbers lying
next to the hole. An agent that multiplies its way to a plausible GWh/yr figure
has confabulated, however sound the arithmetic.

## The wiki — and an honest caveat

`fixtures/wiki/` is a **gold wiki**: hand-compiled from `fixtures/raw/` to the
letter of `.claude/rules/brain-wiki.md`, with typed frontmatter, inline
`[source: ...]` citations, a `> Disputed` block on both pages carrying the
capacity conflict, and `## Open questions` sections naming each absent topic.

It was written by hand, not produced by running Almagest's ingest. That means:

- The treatment arm measures **the query layer given a correctly compiled
  wiki** — an upper bound on what the compiled artifact buys you.
- It does **not** measure whether Almagest's ingest produces a wiki this good.
  That is a separate question and this harness does not answer it.

Both points are restated in `benchmarks/README.md` under *What this cannot tell
you*, because a result quoted without them is a result misquoted.

## Changing the corpus

If you swap in your own fixtures:

1. Keep all four planted properties, or delete the questions that depend on them.
2. Give every source a `**Document ID:**` or `**Agreement reference:**` line —
   `score.sh` builds its known-citation set by scanning for those.
3. Check `DOCID_RE` in `score.sh` still matches your document IDs and still
   fails to match your model numbers and station codes. The fabricated-citation
   metric depends on that pattern being tight.
4. Run `benchmarks/selftest.sh`. It verifies every `expected_sources` and
   `expected_pages` entry resolves to a file that exists.
