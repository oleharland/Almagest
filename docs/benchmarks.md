# Benchmarks

Almagest ships a benchmark harness that compares an agent answering from raw
source files against the same agent answering from a compiled Almagest wiki.
Same questions, same driver, same model, same instructions, same scoring — the
only variable is whether the material has been compiled.

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
| **Citation support** | Does each citation point at a location that genuinely contains the claim? |
| **Unsourced claims** | How many facts are asserted with nothing behind them? |
| **Contradiction surfacing** | Given a real conflict between sources, are both sides shown — or is one silently picked? |
| **Synthesis flagging** | When the answer required inference across pages, is it marked as inference? |
| **Correctness** | Is the answer right? |
| **Citation integrity** | Do the cited pages and document IDs exist at all? |
| **Latency and cost** | What does an answer take, in seconds and dollars? |

Confabulation rate is the row that matters most. A wrong answer is a retrieval
failure. A confidently invented answer with a citation attached is the failure a
knowledge base is meant to make impossible.

Full definitions in `benchmarks/rubric.md`, including which metrics are computed
mechanically and which need a model to judge them.

## How it fits together

| Piece | Role |
|-------|------|
| `benchmarks/fixtures/` | A self-contained fictional corpus — five source documents and a hand-compiled wiki. Never `brain/`. |
| `benchmarks/questions.yaml` | 15 questions with ground truth, one category per question. |
| `benchmarks/prompts/_shared.md` | The answering protocol. **Identical for both arms.** |
| `benchmarks/drivers/` | One script per harness — how a question is actually put to an agent. |
| `benchmarks/run.sh` | Runs the arms, captures answers, timing, and cost. |
| `benchmarks/score.sh` | Scores a run and writes the report. |
| `benchmarks/selftest.sh` | Verifies the harness against a test double. No API calls. |

Nothing outside `benchmarks/` is read or written. Your knowledge base is never
in scope for either arm.

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
branch — against `drivers/fake.sh`, which returns canned output.

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
where you find out for two calls instead of thirty.

## 4. Full run

```bash
benchmarks/run.sh --driver claude-code --model sonnet --label v1
```

### What it costs

**This spends real money.** Each question goes to the API once per arm.

| Command | API calls, 15-question set |
|---------|---------------------------|
| `run.sh` (both arms) | 30 |
| `score.sh --judge` | 30 |
| Full run, judged | **60** |

The script prints the call count and asks for confirmation before starting. It
refuses to run unattended without `--yes`, and caps per-call spend with
`--budget-usd`.

### Options

| Flag | Meaning |
|------|---------|
| `--arm baseline\|treatment\|both` | Which arm(s) to run. Default `both` |
| `--driver NAME\|PATH` | Harness driver. Default `claude-code`; env `ALMAGEST_BENCH_DRIVER` |
| `--model NAME` | Model that answers, spelled the way the driver's CLI spells it. Default `sonnet` |
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
abstention, contradiction handling, and synthesis flagging. It is blind to which
arm produced the answer.

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
├── run.env                    driver, driver version, capabilities, model, date, question-set hash
├── report.md                  the rendered report
├── scores-mechanical.tsv      machine-readable
├── scores-judge.tsv           machine-readable, only if --judge ran
├── arena/{baseline,treatment} the exact directory each arm saw
└── {baseline,treatment}/
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
and every capability the driver reported `no`. All of them are in `run.env` and
in the report's metadata and comparability blocks. A benchmark figure
without them is not reproducible, and an unreproducible figure is exactly the
kind of claim this project refuses to write into a wiki page.

## What it cannot tell you

1. **It does not measure ingest.** The treatment arm reads a *gold wiki* —
   hand-compiled from the fixtures to the letter of `agent/rules/wiki.md`.
   A treatment result is therefore an upper bound: it says what a correctly
   compiled wiki buys you, not whether Almagest's ingest produces one.

2. **Fifteen questions is a small sample.** One question flipping moves a
   percentage by roughly seven points. Smaller differences are noise. The
   harness makes one call per question and does not estimate variance.

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
