# Benchmarks

Almagest ships a benchmark harness that compares an agent answering from raw
source files against the same agent answering from a compiled Almagest wiki.
Same questions, same driver, same model, same instructions, same scoring — the
only variable is what is in the working directory.

It measures both directions. What compiling buys, against a competitor that is
allowed to search rather than one that is not. And what compiling **costs** when
the compiled page turns out to be wrong or out of date — a failure mode the raw
sources structurally cannot have.

**No results have been published.** The harness exists; the numbers do not. The
results tables in `benchmarks/README.md` ship empty and can only be filled by
running it. That is deliberate: this project's foremost rule is that every
finding cites its source or is flagged as a known unknown, and a benchmark
figure is a finding like any other.

Benchmarks are entirely optional. Skip this page if you just want to build a
knowledge base.

## What it measures

Speed and accuracy are the obvious things to benchmark, and both are here. They
are not the point. A knowledge base that answered fast and correctly while
inventing its citations would score well and fail its users — so the metric set
is built around the claim Almagest actually makes, which is trust.

| Metric | Question it answers |
|--------|--------------------|
| **Confabulation rate** | Asked something the corpus cannot answer, does the agent decline — or invent? |
| **Compiled-error propagation rate** | Given a wiki page that contradicts the source it cites, does the agent notice — or repeat the page? |
| **Citation support** | Does each citation point at a location that genuinely contains the claim? |
| **Unsourced claims** | How many facts are asserted with nothing behind them? |
| **Contradiction surfacing** | Given a real conflict between sources, are both sides shown — or is one silently picked? |
| **Synthesis flagging** | When the answer required inference across pages, is it marked as inference? |
| **Correctness** | Is the answer right? |
| **Citation integrity** | Do the cited pages and document IDs exist at all? |
| **Latency and cost** | What does an answer take, in seconds and dollars? |

Two rows carry most of the weight, and they point in opposite directions.

**Confabulation rate** is the failure a knowledge base is meant to prevent. A
wrong answer is a retrieval failure; a confidently invented answer with a
citation attached is the thing the whole apparatus exists to make impossible.

**Compiled-error propagation rate** is the failure a knowledge base
*introduces*. Compiling is a write, and a wrong write is durable: a false claim
on a wiki page has correct frontmatter, a real source id, a real section number,
and no hedging, so it reads as more authoritative than the document that
contradicts it. If you are deciding whether to adopt any of this, that is the
number to ask for.

Full definitions in `benchmarks/rubric.md`, including which metrics are computed
mechanically and which need a model to judge them.

## How it fits together

| Piece | Role |
|-------|------|
| `benchmarks/fixtures/` | A self-contained fictional corpus — five source documents and a complete hand-compiled brain. Never `brain/`. |
| `benchmarks/fixtures/wiki/` | The gold wiki. Schema v2; audits clean under `tools/audit.mjs`. |
| `benchmarks/fixtures/wiki-poisoned/` | The same wiki with four planted false claims. Also audits clean — see below. |
| `benchmarks/fixtures/drift/` | Version 2.0 of a source already in the corpus: same filename, different sha256. |
| `benchmarks/fixtures/scale/` | Deterministic distractor generator, for `--scale`. |
| `benchmarks/questions.yaml` | 19 questions with ground truth, one category per question. |
| `benchmarks/questions-drift.yaml` | 4 re-ingest questions. Separate file — the drift arms see a different corpus. |
| `benchmarks/prompts/_shared.md` | The answering protocol. **Identical for every arm.** |
| `benchmarks/drivers/` | One script per harness — how a question is actually put to an agent. |
| `benchmarks/run.sh` | Runs the arms, captures answers, timing, and cost. |
| `benchmarks/score.sh` | Scores a run and writes the report. |
| `benchmarks/selftest.sh` | Verifies the harness against a test double. No API calls. |

Nothing outside `benchmarks/` is read or written. Your knowledge base is never
in scope for any arm.

### The arms

| Arm | Working directory contains | Answers |
|-----|---------------------------|---------|
| `baseline` | `sources/` — the raw documents, nothing else | does compilation change anything, instructions held identical? |
| `baseline-retrieval` | `sources/`, plus an instruction to search it and a worked example | does compilation beat someone who knows to grep? |
| `treatment` | `wiki/` + `index.md` + `sources/` | the upper bound: what a correctly compiled wiki buys |
| `poisoned` | the same, but the wiki carries four planted false claims | what a *wrongly* compiled wiki costs |
| `drift-baseline` | an **amended** `sources/`, no wiki | control for the drift pair |
| `drift` | the amended `sources/` and the wiki compiled from the pre-amendment ones | does a stale page get repeated? |

`--arm both` is `baseline,treatment` — the original pair, and still the default.
`--arm all` adds the retrieval and poisoned arms. The drift arms need their own
question set and `run.sh` refuses to mix them; see *Drift* below.

**Why the bare baseline survives alongside the retrieval one.** "Raw documents
in a folder, no tools" is not what anyone would actually do, so
`baseline-retrieval` is the honest competitor. But it differs from `treatment`
in *two* things — compilation and several paragraphs of retrieval coaching — so
its delta cannot separate "compiling helped" from "prompting helped". The bare
baseline holds instructions identical and isolates one variable. `baseline` is
the floor; `baseline-retrieval` is the bar. Both are worth having. The tool
allowlist is the same for every arm — the bare baseline is un-prompted, not
tool-deprived.

### The fixtures are a real brain

`benchmarks/fixtures/` has `wiki/`, `index.md`, and `manifest.yaml` laid out the
way a real one is, written to schema v2, and both wikis audit clean:

```bash
node tools/audit.mjs --repo benchmarks/fixtures --config brain.config.yaml \
                     --wiki wiki --brain . --manifest manifest.yaml
```

`selftest.sh` runs that for both wikis, so a fixture that drifts out of schema
fails there rather than shipping. This is not tidiness: the treatment arm exists
to show what a compiled **Almagest** wiki does for an agent, and a wiki that
failed Almagest's own correctness tool would not be one.

That the **poisoned** wiki also audits clean is not a gap in the audit. Every
check it runs is mechanical, and a well-formed lie violates none of them — a
citation naming a real section that flatly contradicts the claim is valid by
every definition a program can apply without reading the document. The audit
bounds the *form* of a claim; the poisoned arm measures the gap that leaves.

### Corpus scale

Five documents is below the size at which retrieval is a constraint: an agent
reads the whole corpus, so a five-document result can show a summarisation
benefit and cannot show a retrieval benefit. "Compilation helps" is a curve in
corpus size, and one point is not a curve.

```bash
benchmarks/run.sh --arm all --scale 50     # 5 real + 45 generated distractors
benchmarks/run.sh --arm all --scale 500    # 5 real + 495
```

Padding is generated from `--scale` and `--scale-seed` alone — no clock, no
network, no package manager — so two runs with the same arguments produce
byte-identical corpora, and a larger tier is a strict superset of a smaller one.
Distractors answer nothing, and generation aborts rather than warns if one
mentions a fixture proper noun or a topic a planted absence depends on.

**It measures retrieval pressure, not domain breadth.** The answers still live
in the same five documents; no new entities, relationships, or contradictions
appear. It is a weaker instrument than 500 genuinely distinct documents, and it
exists because those do not. Runs at different `--scale` or `--scale-seed` are
not comparable to each other, and the report says so.

### Drift

Incremental re-ingest is a headline feature, so it should be measured.
`fixtures/drift/` holds version 2.0 of a document already in the corpus — same
filename, same agreement reference, different sha256 — changing a capacity
figure, a commissioning date, a damages cap, and adding an obligation the wiki
still records as absent.

```bash
benchmarks/run.sh --questions benchmarks/questions-drift.yaml \
                  --arm drift,drift-baseline
```

The drift arms see a different corpus, so the same question has a different
correct answer than in the main set. Two ground truths under one question id
would be a bug waiting to be quoted, so the drift questions live in their own
file with their own ids, and `run.sh` **refuses** to run a drift arm against the
main question set or a main arm against the drift set.

A stale page and a wrong page score on the same metric. From the reader's seat
they are the same defect: a compiled claim the source does not support, in the
same tone with the same citation.

## Requirements

Bash, awk, sed, find, and the CLI of whichever harness you are driving. Nothing
to install.

That is a constraint, not a coincidence. Almagest is markdown plus a coding
agent, with Node only for the site. A benchmark that needed a package manager
would not belong to the same project, so the YAML and JSON parsing is done in
awk — drivers included.

## Drivers

`run.sh` does not know how to talk to an agent. A **driver** does: one small
script per harness in `benchmarks/drivers/`, chosen with `--driver`.

| Driver | Drives | Notes |
|--------|--------|-------|
| `claude-code` | the `claude` CLI | Default. The reference harness |
| `codex` | the `codex` CLI | |
| `gemini-cli` | the `gemini` CLI | |
| `antigravity` | the `agy` CLI (Google Antigravity) | Not the Gemini CLI — different binary and flags. Runs with `--dangerously-skip-permissions`, which the arena tolerates and a real `brain/` does not |
| `fake` | nothing | Canned answers for `selftest.sh`. No API calls, no money |

`--driver NAME` resolves inside `benchmarks/drivers/`; `--driver PATH` runs one
of your own. `ALMAGEST_BENCH_DRIVER` sets the default. `score.sh` takes the same
flag for the judge. The old `ALMAGEST_BENCH_CLAUDE_BIN` is deprecated — it still
works and warns.

Writing your own is three subcommands — `capabilities`, `version`, `run` —
reading the job from environment variables and printing one flat JSON object.
Interface in `benchmarks/drivers/README.md`.

### Capabilities

A driver declares what its CLI can genuinely enforce. `run.sh` asks at preflight
and records every answer in `run.env`:

| Capability | What a `no` means for the run |
|-----------|------------------------------|
| `tool_restriction` | The arms were not confined to the read-only tool allowlist. See below — this is the one that breaks comparisons |
| `budget_cap` | Per-call spend is uncapped. `--budget-usd` is advisory, and the run needs an explicit confirmation |
| `structured_output` | The judge cannot be held to a schema. `score.sh --judge` refuses to run and names the drivers that can |
| `cost_reporting` | Cost columns read `n/a`. Latency is still real |
| `session_isolation` | State may carry between calls. Answers are not independent samples |
| `sandbox` | The arm was not run in a read-only mode |

A driver reports what its CLI can do, not what would be convenient. A `no` is a
recorded fact about the run, not something to work around.

### Comparability

> **A run whose driver cannot enforce the read-only tool allowlist is not
> comparable to a run whose driver can.** With `tool_restriction no` nothing
> stopped an arm from reaching material outside its arena — the baseline could
> have opened the wiki, the treatment could have opened the raw sources — and
> the single variable the whole design rests on stops being single.

`run.sh` warns loudly at preflight and writes `cap_tool_restriction=no` into
`run.env`. The rendered report carries a **Comparability** block naming every
capability reported `no` and what it costs you. Quote a number from such a run
only alongside that block.

Both arms of one run must use the same driver — `run.sh` asserts it. Baseline on
one harness and treatment on another measures the harness, not the wiki.

### Cross-harness comparison

One run per harness, everything else fixed:

```bash
for d in claude-code codex gemini-cli antigravity; do
  benchmarks/run.sh --driver "$d" --label "$d"
done
```

Score each and compare the per-question tables. Four conditions, all of them
checkable in `run.env`:

1. **Same question set.** The hash is in `run.env`.
2. **Same capabilities.** Compare the `cap_*` lines before comparing any number.
   A run with `tool_restriction no` is not in the comparison.
3. **Same judge.** Same driver and same judge model across every run, or you are
   comparing judges rather than harnesses.
4. **Read the result as harness + model.** A harness's system prompt, tool set,
   and retry behaviour are part of what you measured. Nothing here isolates the
   model.

## 1. Run the selftest

Free. No API calls. Do this first, and after any change under `benchmarks/`.

```bash
benchmarks/selftest.sh
```

It exercises the parsers, the fixture corpus, arena isolation, answer capture,
capability reporting, mechanical scoring, report rendering, and every failure
branch — against `drivers/fake.sh`, which returns canned output. It also runs
`tools/audit.mjs` over both fixture wikis, checks every planted error in the
poisoned wiki in both directions, and verifies the scale generator is
deterministic. If Node is absent the audit checks are skipped, not failed: the
harness itself needs no runtime.

## 2. Dry run

```bash
benchmarks/run.sh --dry-run
```

Resolves the driver, prints its version and capabilities, and prints the exact
command each arm would issue. Calls nothing, writes nothing, costs nothing.

## 3. One question

```bash
benchmarks/run.sh --only q01 --arm both
```

Two API calls. Read the two answers in
`benchmarks/results/<run-id>/{baseline,treatment}/q01.answer.md` before
committing to a full run — if the arms are not doing what you expect, this is
where you find out for two calls instead of seventy-six.

## 4. Full run

```bash
benchmarks/run.sh --driver claude-code --model sonnet --label v1
```

### What it costs

**This spends real money.** Each question goes to the API once **per arm**, and
`--judge` sends each captured answer once more. Arms multiply; `--scale` does
not — a larger corpus costs more tokens per call, not more calls.

The main set is 19 questions; the drift set is 4.

| Command | Arms | API calls | Judge calls | Total |
|---------|------|-----------|-------------|-------|
| `run.sh --arm both` | 2 | 38 | 38 | **76** |
| `run.sh --arm all` | 4 | 76 | 76 | **152** |
| `run.sh --arm all --scale 50` | 4 | 76 | 76 | **152**, at more tokens each |
| `run.sh --arm all --scale 500` | 4 | 76 | 76 | **152**, at many more tokens each |
| `run.sh --questions questions-drift.yaml --arm drift,drift-baseline` | 2 | 8 | 8 | **16** |
| Everything: `--arm all` at three scales, plus drift | — | 236 | 236 | **472** |

The script prints the call count and asks for confirmation before starting. It
refuses to run unattended without `--yes`, and caps per-call spend with
`--budget-usd`.

### Options

| Flag | Meaning |
|------|---------|
| `--arm LIST` | Comma list of arm names, or a group: `both` = `baseline,treatment` (default), `all` = the four main arms |
| `--driver NAME\|PATH` | Harness driver. Default `claude-code`; env `ALMAGEST_BENCH_DRIVER` |
| `--model NAME` | Model that answers, spelled the way the driver's CLI spells it. Default `sonnet` |
| `--questions FILE` | Question set. Use `benchmarks/questions-drift.yaml` with the drift arms |
| `--scale N` | Corpus size. Above 5 the corpus is padded with generated distractors |
| `--scale-seed N` | Which padding. Same seed, same bytes, forever. Default `1` |
| `--only q05,q10` | Run just these question ids |
| `--label NAME` | Prefix for the run directory |
| `--budget-usd N` | Per-call spend cap. Default `1.00` |
| `--dry-run` | Print, do not call |
| `--yes` | Skip the cost confirmation |

## 5. Score it

```bash
benchmarks/score.sh --run v1-<timestamp>            # mechanical only — free
benchmarks/score.sh --run v1-<timestamp> --judge    # adds the LLM pass — costs tokens
```

Scoring runs in two passes, and the split is the honest part of the design.

**Mechanical** — deterministic, free, reproducible. Do cited wiki pages exist?
Do cited document IDs exist in the corpus? Were the documents that hold the
answer actually cited? Is there a section-level reference? Latency, cost. These
are syntactic checks: none of them can tell you whether an answer is true.

**Judge** — opt-in, costs tokens. A model reads the question, the ground truth,
and the answer, and scores correctness, citation support, unsourced claims,
abstention, contradiction handling, synthesis flagging, and compiled-error
propagation. It is blind to which arm produced the answer.

`compiled_error` has three values, not two. `propagated` asserts the page's
claim as fact. `caught` gives the value the source supports **and** says the
page disagrees. `corrected_silently` gives the right answer without mentioning
the page — **not a defect**: arms with no wiki, or with the correct one, land
there and should. Reading it as a defect would turn every baseline answer into a
failure and the metric into noise.

Use a different model for the judge than for the arms where you can:

```bash
benchmarks/score.sh --run v1-<timestamp> --judge --judge-model <other model>
```

The judge needs schema-constrained output. A driver reporting
`structured_output no` makes `--judge` refuse to run rather than score against
whatever the CLI happened to print.

The report labels every number with which pass produced it. Never quote one
without the label.

## 6. Read the report

```
benchmarks/results/<run-id>/
├── run.env                    driver, driver version, capabilities, model, arms, scale, date, question-set hash
├── report.md                  the rendered report
├── scores-mechanical.tsv      machine-readable
├── scores-judge.tsv           machine-readable, only if --judge ran
├── corpus.files               the documents the arms saw (scale manifests)
├── corpus.docids              their document ids — what "fabricated" is checked against
├── arena/<arm>/               the exact directory each arm saw
└── <arm>/
    ├── <qid>.answer.md        the answer, verbatim
    ├── <qid>.meta.tsv         latency, cost, turns
    ├── <qid>.raw.json         the full CLI response
    └── <qid>.judge.verdict.json
```

`benchmarks/results/` is gitignored. Runs are timestamped and never overwrite
each other.

The report prints `not run` or `n/a` for any metric it has no data for. It never
prints a number it did not compute. A run with any failure exits non-zero and
says so — do not quote a partial run.

The per-question table is the useful part. Aggregates hide which question moved.

## Publishing a result

If you publish numbers from this harness, publish the run configuration with
them: driver and driver version, model, judge model, date, question-set hash,
`--scale`, `--scale-seed`, the arms that ran, and every capability the driver
reported `no`. All of them are in `run.env` and
in the report's metadata and comparability blocks. A benchmark figure
without them is not reproducible, and an unreproducible figure is exactly the
kind of claim this project refuses to write into a wiki page.

## What it cannot tell you

1. **It does not measure ingest.** The treatment arm reads a *gold wiki* —
   hand-compiled from the fixtures to the letter of `agent/rules/wiki.md`.
   A treatment result is therefore an upper bound: it says what a correctly
   compiled wiki buys you, not whether Almagest's ingest produces one.

2. **Nineteen questions is a small sample.** One question flipping moves a
   percentage by roughly five points, and a per-category rate by far more — the
   compiled-error propagation rate has a denominator of four, so one flip is 25
   points. Smaller differences are noise. The harness makes one call per
   question and does not estimate variance.

3. **The judge is a model.** Score the same answers twice and the numbers move.
   If judge and answerer share a model family, a fabrication convincing to one
   may be convincing to the other.

4. **The corpus is synthetic, small, and clean.** Real sources are longer,
   messier, and contradict each other more subtly. Results here are a floor on
   difficulty, not a ceiling.

5. **One corpus, one domain.** Nothing here establishes that a result
   generalises to your material.

6. **It scores a harness, not a model.** The driver is the harness's own CLI,
   with its system prompt, tool set, and retry behaviour intact. Swapping the
   driver swaps both halves at once.

7. **Scaling is padding, not breadth.** `--scale 50` and `--scale 500` add
   generated distractors that answer nothing. That produces real retrieval
   pressure and nothing else — no new entities, relationships, or
   contradictions, and documents more uniform than any real corpus. Never report
   a scaled figure without its `--scale-seed`.

8. **The planted errors were written by the same hand as the questions**, and
   the contradicting source is sitting in the same arena, and
   `prompts/treatment.md` tells the agent that the source outranks the page.
   Four deliberately catchable errors under generous conditions are not a sample
   of the errors a real ingest makes. Read a good compiled-error propagation
   score as a ceiling, not a floor.

9. **One planted error contaminates one row.** The fourth closes the corpus's
   only contradiction, which three of the main questions also probe, so the
   `poisoned` arm's contradiction figure is not a control. That trade is
   deliberate and is restated wherever the metric is defined.

These are restated at the end of `benchmarks/README.md` because a number quoted
without them is a number misquoted.

## Using your own corpus

The shipped fixtures are fictional and deliberately constructed — a fact stated
in exactly one place, a fact stated consistently in two, a contradiction that
recency cannot resolve, and topics that are conspicuously absent with plausible
bait beside them. Swapping in your own material means preserving those
properties or dropping the questions that depend on them.

The checklist is at the end of `benchmarks/fixtures/README.md`. Run
`benchmarks/selftest.sh` afterwards — it verifies that every expected source and
page named in the question set resolves to a file that exists.
