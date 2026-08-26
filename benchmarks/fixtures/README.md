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
├── raw/                  5 source documents — what the baseline arms see
├── wiki/                 5 compiled pages — the GOLD wiki, correct throughout
├── wiki-poisoned/        the same 5 pages with 4 planted false claims
├── index.md              the catalog — shared by both wikis
├── manifest.yaml         the machine record of every ingested source
├── poison-manifest.tsv   the register of what is falsified where
├── drift/                an AMENDED version of one source, same filename
└── scale/                the distractor generator for larger corpora
```

**This is a complete Almagest brain, laid out the way a real one is.** `index.md`
and `manifest.yaml` sit beside `wiki/`, not inside it — the same shape as
`brain/index.md`, `brain/manifest.yaml`, and `brain/wiki/`. That is not
cosmetic: a catalog inside the wiki directory gets scanned as a wiki page, and
it is not one.

| Tree | Arm that gets it | In the arena? |
|------|-----------------|---------------|
| `raw/` | every arm | yes, as `sources/` |
| `wiki/` | `treatment`, `drift` | yes, as `wiki/` |
| `wiki-poisoned/` | `poisoned` | yes, as `wiki/` |
| `index.md` | every arm with a wiki | yes, beside `wiki/` |
| `manifest.yaml` | — | **no** |
| `poison-manifest.tsv` | — | **no** |
| `drift/` | `drift`, `drift-baseline` — overlaid on `raw/` | yes, as `sources/` |
| `scale/` | any arm, when `--scale` is above 5 | as `sources/` |

Two files are deliberately kept out of the arena.

`poison-manifest.tsv` would hand the agent the answer. It sits one level ABOVE
`wiki-poisoned/` because `run.sh` copies `wiki-poisoned/*.md` wholesale.

`manifest.yaml` would change what the drift arm measures. It carries the sha256
of every source as ingested, so an agent given it could detect the amended
document by comparing two hex strings instead of by reading. The question is "did
you notice the page disagrees with the document", not "can you diff a digest".

## Schema v2, and the audit

Both fixture wikis are written to the frozen schema v2: `sources` as
`{id, path, sha256, title}` objects, inline citations in the frozen grammar
`[source: <id>, <locator>, (<date>)]`, and `origin` / `aliases` / `relations` on
every page. Both audit clean:

```bash
node tools/audit.mjs --repo benchmarks/fixtures \
                     --config brain.config.yaml \
                     --wiki wiki --brain . --manifest manifest.yaml
node tools/audit.mjs --repo benchmarks/fixtures \
                     --config brain.config.yaml \
                     --wiki wiki-poisoned --brain . --manifest manifest.yaml
```

`--repo benchmarks/fixtures` is what makes it work: `sources[].path` is
`raw/kb-0N-*.md`, `--brain .` finds `index.md` beside the wiki, and
`--manifest manifest.yaml` gives `PROV-003` and `CITE-005` something real to
reconcile against. `selftest.sh` runs both, so a fixture that drifts out of
schema fails there rather than shipping.

This matters beyond tidiness. The treatment arm exists to show what a compiled
**Almagest** wiki does for an agent; a wiki that fails Almagest's own correctness
tool is not one, and a reader who ran the audit against the fixtures would
reasonably conclude that one of the two was broken.

### The poisoned wiki audits clean too — and that is the point

Zero errors, zero warnings, on a wiki containing four false claims.

Nothing is wrong with the audit. Every check it runs is mechanical: does the
frontmatter hold up, does the citation parse, is the `id` declared, does the
digest match the manifest, does the path exist, does the link resolve. A
well-formed lie violates none of them. `[source: kb-04-verification-memo, §5]`
attached to a claim that §5 flatly contradicts is a **valid** citation by every
definition a program can apply without reading the document.

So the audit bounds the *form* of a claim, never its truth, and the poisoned arm
measures precisely the gap the audit cannot close. Neither the tool nor the
benchmark is redundant; they check different things, and the fixture is the
demonstration.

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

## The poisoned wiki

`fixtures/wiki-poisoned/` is a byte-for-byte copy of the gold wiki with four
claims deliberately falsified. It exists because the treatment arm has a failure
mode the baseline arms **structurally cannot have**: a wrong claim compiled once
into a page, cited, and thereafter repeated with more authority than the source
that contradicts it. A benchmark that only tests the baseline's failure modes is
not a fair test of the thing being proposed.

Every planted error is, by construction:

- **plausible** — the sort of mistake a compiler actually makes, not a typo;
- **properly formatted** — correct frontmatter, correct citation grammar, no
  `[source: unknown]`, nothing that looks wrong on the page;
- **cited to something that does not support it** — the citation names a real
  document and a real section, and that section says otherwise. Catching it
  requires opening the source, which is sitting in `sources/` in the same arena.

| | Page | What it says | What the source says | Q |
|---|------|--------------|---------------------|---|
| **P1** | `gannet-narrows-site-conditions` | Maximum recorded wave height 4.6 m | 3.9 m (MCA-SUR-0014 §4). 4.6 m/s is the VM-320 survival *current*, from a different document | `q16` |
| **P2** | `harrowgate-grid-connection` | The **Connection Provider** may terminate on 24 months notice | The **Generator** may (WGN-CA-4471 §5). Parties inverted, no number moves | `q17` |
| **P3** | `vm-320-turbine` | Maximum operating depth 40 m | 55 m (VMS-TN-2027-041 §4). At 40 m the 41 m mid-channel depth would put the site out of envelope — the error changes a conclusion, not just a figure | `q18` |
| **P4** | `kestrel-basin-tidal-array` (+2 pages) | MCA directed on 2027-08-02 that 48 MW is the baseline | No direction has been issued (HVS-MEM-0207 §5). A live contradiction reported as settled, cited to the section saying it is open | `q19` |

P4 is the one that matters most, because closing an open contradiction is the
exact inverse of the third non-negotiable in `CLAUDE.md`. It also has two
mechanically checkable tells: no document in the corpus is dated 2027-08-02, and
the memo it cites predates the direction it is said to record.

**The cost of P4, stated plainly.** P1 to P3 sit on facts no other question
touches, so the poisoned arm is a clean control everywhere except its own four
questions. P4 does not: it edits the capacity dispute, which `q05`, `q06`, and
`q09` also probe. The poisoned arm's contradiction row is therefore contaminated
by design and is not a control. That was accepted rather than avoided — the
corpus has exactly one contradiction, and testing whether a compiled page can
close one is worth more than keeping three cells comparable. `rubric.md` repeats
this where the metric is defined.

`selftest.sh` verifies every row of the manifest in both directions, and that
every page NOT named in it is byte-identical between the two wikis.

## The drift pair

`fixtures/drift/kb-05-grid-connection-agreement.md` is **version 2.0 of a
document already in the corpus** — same filename, same agreement reference
`WGN-CA-4471`, different content and therefore a different sha256. Incremental
re-ingest is a headline feature of Almagest and detecting exactly this is what it
is for, so it should be measured.

Amendment 1, dated 2028-02-14, changes four things and records them in a §0
revision table:

| Clause | v1.0 | v2.0 | Question |
|--------|------|------|----------|
| §2 Firm export capacity | 50 MW | 45 MW | `d01` |
| §3 Generator commissioning | Q3 2029 | Q1 2030 | `d02` |
| §3a Delay damages cap | 4 percent | 8 percent | `d03` |
| §7 Export cable removal | absent | new obligation on the Generator | `d04` |

Each change breaks the gold wiki differently. `d01` flips a conclusion: 45 MW is
below the 48 MW nameplate, so the connection becomes the binding constraint and
the wiki says in terms that it is not. `d02` destroys an agreement: the charter
and the agreement no longer give the same commissioning date, and the wiki
records that they do. `d03` is a plain superseded number. `d04` closes an
absence the wiki still asserts — **an absence is a claim, and it goes stale like
any other.**

The revision table makes the staleness easy to find. That is deliberate. If
agents fail here they fail with every advantage; if they pass, the harness has
established a floor and nothing more.

Because the drift arms see a different corpus, they have their own question set
(`benchmarks/questions-drift.yaml`) and `run.sh` refuses to mix the two.

## The wiki — and an honest caveat

`fixtures/wiki/` is a **gold wiki**: hand-compiled from `fixtures/raw/` to the
letter of `agent/rules/wiki.md` and schema v2, with typed frontmatter, object
`sources`, inline `[source: <id>, <locator>]` citations that parse against the
frozen grammar, a `> Disputed` block on both pages carrying the capacity
conflict, and `## Open questions` sections naming each absent topic. It audits
clean against `tools/audit.mjs`.

It was written by hand, not produced by running Almagest's ingest. That means:

- The treatment arm measures **the query layer given a correctly compiled
  wiki** — an upper bound on what the compiled artifact buys you.
- It does **not** measure whether Almagest's ingest produces a wiki this good.
  That is a separate question and this harness does not answer it.

Both points are restated in `benchmarks/README.md` under *What this cannot tell
you*, because a result quoted without them is a result misquoted.

## Corpus scale

Five documents is below the size at which retrieval is a constraint. An agent
reads the whole corpus, so a five-document result can only show a summarisation
benefit — never the retrieval benefit compilation is actually claimed to buy.
"Compilation helps" is a curve in corpus size, not a point, and one point is not
a curve.

`fixtures/scale/generate.sh` builds a larger corpus by keeping the five real
documents and padding with generated distractors:

```bash
benchmarks/run.sh --scale 50   --arm all      # 5 real + 45 generated
benchmarks/run.sh --scale 500  --arm all      # 5 real + 495 generated
```

Output is a function of `--tier` and `--seed` and nothing else: no clock, no
network, no `$RANDOM`, no package manager. The generator carries its own LCG
because `rand()` is not portable across awk implementations. Two runs with the
same arguments produce byte-identical corpora, and **a larger tier is a strict
superset of a smaller one under the same seed** — scaling up does not resample
the small corpus into a different one.

Distractors are drawn from a vocabulary disjoint from the fixture corpus, and
`fixtures/scale/blocklist.txt` is enforced against the output: a generated
document mentioning a fixture proper noun, or any topic a planted absence
depends on, aborts generation rather than warning. One distractor mentioning a
decommissioning cost would silently convert five questions into different
questions.

**What this measures, and what it does not.** Padding measures **retrieval
pressure** — how hard it is to find the right document when it is one of many.
It does **not** measure domain breadth: the answers still live in the same five
documents, no new entity relationships exist, no new contradictions arise, and
the distractors are shallower and more uniform than material written by fifty
offices over three years would be. **This is a weaker instrument than 500
genuinely distinct documents**, and it is here because 500 genuinely distinct
fictional documents do not exist and writing them is a larger job than the rest
of this harness combined. Read a scaled result as a lower bound on the retrieval
effect and nothing more.

## Changing the corpus

If you swap in your own fixtures:

1. Keep all four planted properties, or delete the questions that depend on them.
2. Give every source a `**Document ID:**` or `**Agreement reference:**` line —
   `score.sh` builds its known-citation set by scanning for those.
3. Check `DOCID_RE` in `score.sh` still matches your document IDs and still
   fails to match your model numbers and station codes. The fabricated-citation
   metric depends on that pattern being tight.
4. Rebuild `wiki-poisoned/` and `poison-manifest.tsv` together. The manifest is
   the contract: `selftest.sh` checks every literal in both directions and every
   unnamed page for byte-equality, so a poisoned wiki that has drifted from its
   manifest fails the selftest rather than quietly measuring something else.
5. Rebuild `drift/` as an edited copy of a file that already exists in `raw/`,
   under the same filename. `selftest.sh` refuses a drift file with a name of
   its own — that would be a new document, not a revision, and the point is that
   the path is stable while the bytes are not.
6. Replace the proper nouns in `fixtures/scale/blocklist.txt` with yours, and
   the vocabulary in `fixtures/scale/distractors.awk` with something disjoint
   from your corpus.
7. Rewrite `manifest.yaml`: one entry per source, `path` matching the page's
   `sources[].path` exactly and `sha256` matching the file on disk. `PROV-003`
   and `CITE-005` are the checks that depend on it, and `selftest.sh` verifies
   the digests against `raw/` so a stale one fails loudly.
8. Keep `index.md` and `manifest.yaml` BESIDE `wiki/`, never inside it. A
   catalog inside the wiki directory is audited as a page, and it is not one —
   `check_fixtures` refuses to start if one appears there.
9. Run `benchmarks/selftest.sh`. It verifies every `expected_sources` and
   `expected_pages` entry resolves to a file that exists, that both wikis audit
   clean against `tools/audit.mjs`, plus everything above.
