# Almagest benchmark harness

A baseline-versus-treatment benchmark for the thing Almagest actually claims to
do: produce answers you can check.

**No results have been published.** The tables below ship empty, and the harness
is built so that they can only be filled in by running it. See
[Status](#status--no-results-yet).

---

## The question it answers

> Does compiling sources into an Almagest wiki change how an agent answers
> questions about them — and in which direction?

Two arms, the same questions, the same model, the same scoring, the same
instructions:

| Arm | Working directory contains |
|-----|---------------------------|
| **baseline** | `sources/` — the raw documents, nothing else |
| **treatment** | `wiki/` + `wiki/index.md` + `sources/` — the compiled Almagest wiki, and the originals behind it |

Both arms are given the identical answering protocol from
`prompts/_shared.md`: cite everything, name section-level locations, surface
contradictions rather than resolving them, flag synthesis, decline when the
corpus cannot answer. **The baseline is not a strawman.** It is told to do
exactly what the treatment arm is told to do. The only variable is whether the
material has been compiled.

That constraint costs the benchmark headline numbers — a baseline told nothing
about citations would score far worse — and it is the reason the comparison is
worth anything at all.

## What is measured, and why not just speed

The obvious benchmark is speed and accuracy. Both matter, and both are here. But
a knowledge base that answered fast and correctly while inventing its citations
would pass that benchmark and fail its users, and citation integrity is the
whole of Almagest's claim. So the metric set is built around **trust**:

| Metric | Question it answers | Scored by |
|--------|--------------------|-----------|
| **Confabulation rate on unanswerable questions** | Asked something the corpus cannot answer, does the agent say so — or invent? | judge |
| **Citation support** | Does each citation point at a place that genuinely contains the claim? | judge |
| **Unsourced-claim count** | How many facts are asserted with nothing behind them? | judge |
| **Contradiction surfacing** | Given a real conflict, are both sides shown — or is one silently picked? | judge |
| **Synthesis flagging** | When the answer required inference, is it marked as inference? | judge |
| **Correctness** | Is the answer right? | judge |
| **Broken / fabricated citations** | Do cited pages and document IDs exist at all? | mechanical |
| **Expected-source coverage** | Were the documents that hold the answer actually cited? | mechanical |
| **Section-level precision** | Is the citation specific enough to check in 30 seconds? | mechanical |
| **Latency and cost** | What does an answer take, in seconds and dollars? | mechanical |

Full definitions, and an honest account of what each one cannot tell you, in
[`rubric.md`](rubric.md).

The single most important row is **confabulation rate**. An answer that is
merely wrong is a retrieval failure. An answer that is confidently invented,
with a citation attached, is the failure mode a knowledge base is supposed to
make impossible.

## The corpus

A fictional marine energy programme, five source documents, six compiled wiki
pages. It contains, by construction: a fact stated in exactly one place, a fact
stated consistently in two, a contradiction that recency cannot resolve, and
several topics that are conspicuously absent with plausible-looking bait sitting
next to the hole.

Details in [`fixtures/README.md`](fixtures/README.md). Everything is invented —
no real organisation, product, or person appears, and no personal names appear
at all.

Fixtures live entirely inside `benchmarks/`. The harness never reads from or
writes to `brain/`, so running it cannot touch your knowledge base.

---

## Running it

### Requirements

Bash, awk, sed, find, cp, and the CLI of whichever agent harness you point it
at. Nothing to install — no language runtime, no package manager. That is a hard
constraint: Almagest is markdown and an AI coding agent, with Node only for the
site, and a benchmark that needed `pip install` would not be part of the same
project.

### Which agent

`run.sh` reaches an agent through a **driver** — one script per harness in
`drivers/`, picked with `--driver` (default `claude-code`). A driver declares
what its CLI can genuinely enforce: the tool allowlist, a spend cap, a JSON
schema for the judge. Anything it reports as `no` is warned about at preflight,
recorded in `run.env`, and repeated in the report's Comparability block, because
it changes what the numbers can be compared against.

Interface and rules for writing your own: `drivers/README.md`.

### Costs

**Running this spends real money.** Each question is sent to the API once per
arm; `--judge` sends each captured answer once more.

| Command | API calls with the shipped 15-question set |
|---------|-------------------------------------------|
| `run.sh` (both arms) | 30 |
| `score.sh --judge` | 30 |
| Full run, both arms, judged | **60** |

Actual cost depends on the model. The harness caps per-call spend
(`--budget-usd`), prints the call count before it starts, and refuses to run
unattended without `--yes`.

### First, spend nothing

```bash
benchmarks/selftest.sh          # exercises the whole harness against a test
                                # double. No API calls. No cost.
benchmarks/run.sh --dry-run     # prints exactly what would run
```

### Then a single question

```bash
benchmarks/run.sh --only q01 --arm both
```

### Then the real thing

```bash
benchmarks/run.sh --model sonnet --label baseline-v1
benchmarks/score.sh --run baseline-v1-<timestamp>            # free, mechanical only
benchmarks/score.sh --run baseline-v1-<timestamp> --judge    # costs tokens
```

Each run writes to `benchmarks/results/<run-id>/`, which is gitignored. Runs
never overwrite each other — the directory is timestamped.

### Options worth knowing

| Flag | Why |
|------|-----|
| `--driver` | Which harness answers. `NAME` resolves in `drivers/`, or give a path |
| `--model` | Which model answers, spelled the way that driver's CLI spells it |
| `--judge-model` | Which model scores. **Use a different one from `--model`** where you can — see the judge limits in `rubric.md` |
| `--only q05,q10` | Iterate on one question without paying for thirty |
| `--arm baseline` | Re-run one arm after a prompt change |
| `--budget-usd` | Per-call spend cap |

---

## Status — no results yet

The tables below are the published-results tables. They are empty because the
benchmark has not been run. **Do not fill them in by hand.** Run the harness and
copy the numbers out of `benchmarks/results/<run-id>/report.md`, which computes
every figure from captured answers and prints `not run` for anything it has no
data for.

### Headline

| | Baseline (raw sources) | Treatment (Almagest wiki) |
|---|---|---|
| Correctness (mean, 0–2) | _not yet run_ | _not yet run_ |
| Citation support (mean, 0–2) | _not yet run_ | _not yet run_ |
| **Confabulation rate on unanswerable questions** | _not yet run_ | _not yet run_ |
| Contradictions fully surfaced | _not yet run_ | _not yet run_ |
| Unsourced claims (total) | _not yet run_ | _not yet run_ |
| Broken or fabricated citations | _not yet run_ | _not yet run_ |
| Median latency | _not yet run_ | _not yet run_ |
| Cost per question | _not yet run_ | _not yet run_ |

**Run configuration:** _not yet run_ — driver and driver version, model, judge
model, date, question-set hash, and every capability the driver reported `no` go
here, copied from `report.md`'s metadata and comparability blocks.

### By category

| Category | n | Baseline correctness | Treatment correctness |
|----------|---|---------------------|----------------------|
| `single_source` | 3 | _not yet run_ | _not yet run_ |
| `multi_source_agreement` | 1 | _not yet run_ | _not yet run_ |
| `contradiction` | 2 | _not yet run_ | _not yet run_ |
| `synthesis` | 3 | _not yet run_ | _not yet run_ |
| `unanswerable` + `unanswerable_trap` | 5 | _not yet run_ | _not yet run_ |
| `citation_precision` | 1 | _not yet run_ | _not yet run_ |

> **Format illustration only.** A filled table has the shape below. The `<value>`
> tokens are placeholders and are not results — nothing on this page has been
> measured.
>
> | | Baseline | Treatment |
> |---|---|---|
> | Correctness (mean, 0–2) | `<value>` | `<value>` |
> | Confabulation rate | `<value>` | `<value>` |

---

## What this cannot tell you

Read this section before quoting any number this harness produces.

1. **It does not measure Almagest's ingest.** The treatment arm reads a *gold
   wiki* — hand-compiled from the fixtures to the letter of the wiki rules. So a
   treatment result is an **upper bound**: it says what a correctly compiled
   wiki buys you, not whether the ingest pipeline produces one. Measuring ingest
   quality is a different benchmark and this is not it.

2. **Fifteen questions is a small sample.** One question flipping moves a
   percentage by roughly seven points. Differences smaller than that are noise.
   There is no confidence interval here because the harness makes one call per
   question — it does not repeat runs.

3. **The judge is a model.** Score the same answers twice and the numbers move.
   If judge and answerer are the same model family, a fabrication convincing to
   one may be convincing to the other. `rubric.md` lists the judge's limits in
   full; they are not incidental.

4. **The corpus is synthetic and small.** Five short, clean, well-structured
   documents. Real sources are longer, messier, worse formatted, and contradict
   each other in subtler ways. Results here are a floor on difficulty, not a
   ceiling.

5. **Mechanical metrics are syntactic.** "Cited a document that exists" is not
   "cited the right document for that claim". The mechanical pass catches
   fabricated citations; only the judge catches misapplied ones.

6. **One corpus, one domain.** Nothing here establishes that the result
   generalises to your material.

7. **Latency and cost are single-sample and environment-bound.** Network
   conditions, model load, and caching all move them. They are reported because
   they are cheap to capture, not because one run establishes them.

---

## Files

| Path | What |
|------|------|
| `run.sh` | Runs the arms, captures answers, timing, and cost |
| `score.sh` | Mechanical scoring always; `--judge` adds the LLM pass; writes the report |
| `selftest.sh` | Verifies the harness against a test double. No API calls |
| `questions.yaml` | 15 questions with ground truth. Format documented in the file header |
| `rubric.md` | Every metric, how it is computed, and what it cannot tell you |
| `prompts/_shared.md` | The answering protocol. **Identical for both arms** |
| `prompts/baseline.md`, `prompts/treatment.md` | Corpus orientation — the only prompt difference between arms |
| `prompts/judge.md` | The judge's rubric |
| `fixtures/raw/` | The five fictional source documents |
| `fixtures/wiki/` | The hand-compiled gold wiki |
| `lib/*.awk` | YAML and JSON parsing, in awk, so the harness needs no dependencies |
| `drivers/*.sh` | One per harness: how a question is actually put to an agent |
| `drivers/README.md` | The driver interface, for writing your own |
| `drivers/fake.sh` | Test double used by `selftest.sh`. No API calls, no money |
| `results/` | Run output. Gitignored |

## Extending it

- **Add a question:** append to `questions.yaml` following the format in its
  header, then run `selftest.sh` — it checks that every `expected_sources` and
  `expected_pages` entry resolves.
- **Swap the corpus:** see the checklist at the end of `fixtures/README.md`.
- **Change the protocol:** edit `prompts/_shared.md` and both arms change
  together. If you edit `agent/rules/read.md`, `run.sh` warns that the two have
  drifted and records the drift in `run.env`.
- **Add a harness:** write `drivers/<name>.sh` to the interface in
  `drivers/README.md`, then run `selftest.sh`.
