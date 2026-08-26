# Almagest benchmark harness

A multi-arm benchmark for the thing Almagest actually claims to do: produce
answers you can check. It measures what compiling buys, against a competitor
that is allowed to search — and what compiling costs when the compiled page is
wrong or out of date.

**No results have been published.** The tables below ship empty, and the harness
is built so that they can only be filled in by running it. See
[Status](#status--no-results-yet).

---

## The question it answers

> Does compiling sources into an Almagest wiki change how an agent answers
> questions about them — and in which direction?

Six arms, the same questions, the same model, the same scoring, the same
answering protocol:

| Arm | Working directory contains | Answers |
|-----|---------------------------|---------|
| **baseline** | `sources/` — the raw documents, nothing else | "does compilation change anything, instructions held identical?" |
| **baseline-retrieval** | `sources/`, and an instruction to search it, with a worked example | "does compilation beat someone who knows to grep?" |
| **treatment** | `wiki/` + `index.md` + `sources/` — the compiled Almagest wiki, its catalog, and the originals behind it | the upper bound: what a correctly compiled wiki buys |
| **poisoned** | the same, but the wiki carries four planted false claims | what a *wrongly* compiled wiki costs |
| **drift-baseline** | an **amended** `sources/`, no wiki | control for the drift pair |
| **drift** | the amended `sources/` and the wiki compiled from the pre-amendment ones | does a stale page get repeated? |

Every arm is given the identical answering protocol from `prompts/_shared.md`:
cite everything, name section-level locations, surface contradictions rather
than resolving them, flag synthesis, decline when the corpus cannot answer.
**The baseline is not a strawman.** It is told to do exactly what the treatment
arm is told to do. The only variable is whether the material has been compiled.

That constraint costs the benchmark headline numbers — a baseline told nothing
about citations would score far worse — and it is the reason the comparison is
worth anything at all.

`poisoned` and `drift` reuse `prompts/treatment.md` unchanged. If they had
prompts of their own they would differ from `treatment` in two ways at once and
neither difference could be attributed to anything.

The default is still `--arm both` — `baseline` and `treatment`. `--arm all`
adds the retrieval and poisoned arms. The drift arms need their own question
set; see [Drift](#drift--is-a-stale-page-repeated).

## What is measured, and why not just speed

The obvious benchmark is speed and accuracy. Both matter, and both are here. But
a knowledge base that answered fast and correctly while inventing its citations
would pass that benchmark and fail its users, and citation integrity is the
whole of Almagest's claim. So the metric set is built around **trust**:

| Metric | Question it answers | Scored by |
|--------|--------------------|-----------|
| **Confabulation rate on unanswerable questions** | Asked something the corpus cannot answer, does the agent say so — or invent? | judge |
| **Compiled-error propagation rate** | Given a wiki page that contradicts the source it cites, does the agent notice — or repeat the page? | judge |
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

Two rows carry most of the weight, and they point in opposite directions.

**Confabulation rate** is the failure a knowledge base is supposed to prevent.
An answer that is merely wrong is a retrieval failure. An answer that is
confidently invented, with a citation attached, is the thing the whole apparatus
exists to make impossible.

**Compiled-error propagation rate** is the failure a knowledge base
*introduces*. Compiling is a write, and a wrong write is durable: a false claim
inside a wiki page has correct frontmatter, a real document ID, a real section
number, and no hedging, so it reads as more authoritative than the source that
contradicts it. The baseline arms structurally cannot fail this way — they have
no compiled layer to be wrong. If you are deciding whether to adopt any of this,
this is the number to ask for, and it is why the `poisoned` and `drift` arms
exist. Full definition and limits in [`rubric.md`](rubric.md).

## The corpus

A fictional marine energy programme, five source documents, five compiled wiki
pages and their catalog. It contains, by construction: a fact stated in exactly one place, a fact
stated consistently in two, a contradiction that recency cannot resolve, and
several topics that are conspicuously absent with plausible-looking bait sitting
next to the hole.

Alongside it: a **poisoned** copy of the wiki with four planted false claims,
each cited to a section that says otherwise; an **amended** version of one
source, same filename and different bytes, for the drift arms; and a
**generator** that pads the corpus to 50 or 500 documents deterministically.

Details in [`fixtures/README.md`](fixtures/README.md). Everything is invented —
no real organisation, product, or person appears, and no personal names appear
at all.

Fixtures live entirely inside `benchmarks/`. The harness never reads from or
writes to `brain/`, so running it cannot touch your knowledge base.

The fixture is a **complete Almagest brain** — `wiki/`, `index.md`, and
`manifest.yaml`, laid out the way a real one is and written to schema v2. Both
wikis audit clean under `tools/audit.mjs`, and `selftest.sh` checks that they
still do. The treatment arm is supposed to demonstrate what a compiled Almagest
wiki does for an agent, and a wiki that failed Almagest's own correctness tool
would not be one.

That the **poisoned** wiki also audits clean is not a gap in the audit. Every
check it runs is mechanical, and a well-formed lie violates none of them: a
citation naming a real section that flatly contradicts the claim is valid by
every definition a program can apply without reading the document. The audit
bounds the form of a claim; the poisoned arm measures the gap that leaves.

## Corpus scale — "compilation helps" is a curve, not a point

Five documents is below the size at which retrieval is a constraint. An agent
reads the whole corpus, so a five-document result can show a summarisation
benefit and cannot show a retrieval benefit, which is most of what compilation
is claimed to buy. One point is not a curve.

`--scale` runs the same question set against progressively larger corpora:

```bash
benchmarks/run.sh --arm all --scale 5      # the real sources only
benchmarks/run.sh --arm all --scale 50     # + 45 generated distractors
benchmarks/run.sh --arm all --scale 500    # + 495
```

The padding is generated by `fixtures/scale/generate.sh` from `--tier` and
`--seed` alone: no clock, no network, no `$RANDOM`, no package manager. Two runs
with the same arguments produce byte-identical corpora, and a larger tier is a
strict superset of a smaller one under the same seed. Distractors answer
nothing, and generation aborts if one mentions a fixture proper noun or any
topic a planted absence depends on.

**It measures retrieval pressure, not domain breadth.** The answers still live
in the same five documents; no new entities, relationships, or contradictions
appear; the distractors are shallower and more uniform than real material. It is
a weaker instrument than 500 genuinely distinct documents, and it is here
because those do not exist. Read a scaled result as a lower bound on the
retrieval effect.

Runs at different `--scale` or `--scale-seed` are not comparable to each other,
and the report says so in its own Comparability block.

## Drift — is a stale page repeated?

Incremental re-ingest is a headline feature of Almagest and was, until now,
entirely unmeasured. `fixtures/drift/` holds version 2.0 of a document already
in the corpus — same filename, same agreement reference, different sha256 — that
changes a capacity figure, a commissioning date, a damages cap, and adds an
obligation the wiki still records as absent.

```bash
benchmarks/run.sh --questions benchmarks/questions-drift.yaml \
                  --arm drift,drift-baseline
```

The drift arms see a different corpus, so the same question has a different
correct answer than it does in the main set. Two ground truths under one
question id would be a bug waiting to be quoted, so the drift questions live in
their own file with their own ids, and `run.sh` **refuses** to run a drift arm
against the main question set or a main arm against the drift set.

A stale page and a wrong page score on the same metric. From the reader's seat
they are the same defect: a compiled claim the source does not support, stated
in the same tone with the same citation.

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
arm; `--judge` sends each captured answer once more. Arms multiply, `--scale`
does not — a bigger corpus costs more tokens per call, not more calls.

The shipped main set is **19 questions**; the drift set is **4**.

| Command | Arms | API calls | Judge calls | Total |
|---------|------|-----------|-------------|-------|
| `run.sh --arm both` | 2 | 38 | 38 | **76** |
| `run.sh --arm all` | 4 | 76 | 76 | **152** |
| `run.sh --arm all --scale 50` | 4 | 76 | 76 | **152**, at more tokens each |
| `run.sh --arm all --scale 500` | 4 | 76 | 76 | **152**, at many more tokens each |
| `run.sh --questions questions-drift.yaml --arm drift,drift-baseline` | 2 | 8 | 8 | **16** |
| The full picture: `--arm all` at three scales, plus drift | — | 236 | 236 | **472** |

Actual cost depends on the model, and at `--scale 500` on how much of a
two-megabyte corpus the agent decides to read. The harness caps per-call spend
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
benchmarks/run.sh --arm all --model sonnet --label v1
benchmarks/score.sh --run v1-<timestamp>            # free, mechanical only
benchmarks/score.sh --run v1-<timestamp> --judge    # costs tokens
```

Then the two axes the headline table cannot show on its own:

```bash
benchmarks/run.sh --arm all --scale 50  --label v1-s50
benchmarks/run.sh --arm all --scale 500 --label v1-s500
benchmarks/run.sh --questions benchmarks/questions-drift.yaml \
                  --arm drift,drift-baseline --label v1-drift
```

Each run writes to `benchmarks/results/<run-id>/`, which is gitignored. Runs
never overwrite each other — the directory is timestamped.

### Options worth knowing

| Flag | Why |
|------|-----|
| `--driver` | Which harness answers. `NAME` resolves in `drivers/`, or give a path |
| `--model` | Which model answers, spelled the way that driver's CLI spells it |
| `--judge-model` | Which model scores. **Use a different one from `--model`** where you can — see the judge limits in `rubric.md` |
| `--only q05,q10` | Iterate on one question without paying for the whole set |
| `--arm baseline` | Re-run one arm after a prompt change. Takes a comma list, or `both` / `all` |
| `--scale 50` | Corpus size. Above 5 the corpus is padded with generated distractors |
| `--scale-seed 3` | Which padding. Same seed, same bytes, forever |
| `--budget-usd` | Per-call spend cap |

---

## Comparability

Numbers from this harness line up with each other only under conditions the
report states explicitly in its own Comparability block. Three of them are worth
spelling out here.

### Why the bare baseline is kept alongside the retrieval one

`baseline-retrieval` exists because "raw docs in a folder, no tools" is not what
anyone would actually do. Nobody drops five hundred documents on an agent and
declines to mention that search exists. The honest competitor is raw documents
plus a retrieval instruction, and without that arm the treatment arm is beating
a straw man.

It does **not** replace the bare baseline, for three reasons:

1. **They isolate different variables.** `baseline` differs from `treatment` in
   exactly one thing: whether the material has been compiled. `baseline-retrieval`
   differs in two — compilation *and* several paragraphs of retrieval coaching —
   so a `baseline-retrieval` vs `treatment` delta cannot separate "compiling
   helped" from "prompting helped". Both comparisons are worth having and
   neither substitutes for the other.
2. **`baseline` is the floor and `baseline-retrieval` is the bar.** The first
   says whether compilation does anything at all; the second says whether it
   beats the cheap alternative. Publishing only the second hides the size of the
   effect; publishing only the first inflates it.
3. **Across `--scale` they diverge.** At five documents an agent reads
   everything and the two baselines should converge. At five hundred they should
   not. That gap *is* the retrieval-pressure measurement, and it needs both arms
   to exist.

Note that the tool allowlist is identical across all arms — every arm has
`Read,Grep,Glob`. The bare baseline is not tool-deprived, it is un-prompted.
That is the difference being measured, and it is a smaller difference than
"gave one arm a search tool" would be.

### What has to match before two runs can be compared

| Must match | Because |
|---|---|
| `--scale` and `--scale-seed` | A different corpus size is a different experiment; a different seed is a different corpus |
| Question set sha256 | Different ground truth |
| Driver, and every `cap_*` line in `run.env` | A capability the driver could not enforce changes what the numbers mean |
| Answering model and judge model | Obvious, and recorded for you |

All of it is in `run.env` and repeated in `report.md`.

### What the arms cannot be compared on

The `poisoned` arm's **contradiction** row is contaminated by design. The fourth
planted error closes the corpus's only contradiction, which three of the main
questions also probe. On that arm those three are not a control. The trade was
deliberate — there is one contradiction in the fixture, and testing whether a
compiled page can close one is worth more than three comparable cells — and it
is restated wherever the metric is defined.

---

## Status — no results yet

The tables below are the published-results tables. They are empty because the
benchmark has not been run. **Do not fill them in by hand.** Run the harness and
copy the numbers out of `benchmarks/results/<run-id>/report.md`, which computes
every figure from captured answers and prints `not run` for anything it has no
data for.

### Headline — main arms, `--scale 5`

| | baseline | baseline-retrieval | treatment | poisoned |
|---|---|---|---|---|
| Correctness (mean, 0–2) | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| Citation support (mean, 0–2) | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| **Confabulation rate on unanswerable questions** | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| **Compiled-error propagation rate** | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| Compiled errors caught and named | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| Contradictions fully surfaced | _not yet run_ | _not yet run_ | _not yet run_ | ⚠ not a control — see Comparability |
| Unsourced claims (total) | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| Broken or fabricated citations | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| Median latency | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| Cost per question | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |

**Run configuration:** _not yet run_ — driver and driver version, model, judge
model, date, question-set hash, `--scale`, `--scale-seed`, and every capability
the driver reported `no` go here, copied from `report.md`'s metadata and
comparability blocks.

### The scale curve

The point of the axis is the shape, not any single cell. Fill a column only from
a run at that `--scale`, and record the `--scale-seed` alongside it.

| `--scale` | Corpus | baseline correctness | baseline-retrieval correctness | treatment correctness | treatment − baseline |
|---|---|---|---|---|---|
| 5 | 5 real | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| 50 | 5 real + 45 generated | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| 500 | 5 real + 495 generated | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |

**Scale-seed used:** _not yet run_.

### Compiled-error propagation

Only the `poisoned` and `drift` arms can put a meaningful number here. The other
arms are the control and should sit at zero; a non-zero one there is a bug in
the fixture or the judge, not a result.

| | poisoned (n=4) | drift (n=4) | drift-baseline (n=4) | treatment (n=4) |
|---|---|---|---|---|
| Propagated | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| Caught and named | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| Corrected silently | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |

### By category — main set

| Category | n | baseline | baseline-retrieval | treatment | poisoned |
|----------|---|---|---|---|---|
| `single_source` | 3 | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| `multi_source_agreement` | 1 | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| `contradiction` | 2 | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| `synthesis` | 3 | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| `unanswerable` + `unanswerable_trap` | 5 | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| `citation_precision` | 1 | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |
| `poisoned_claim` | 4 | _not yet run_ | _not yet run_ | _not yet run_ | _not yet run_ |

### Drift set

Separate question set, separate arms, separate run. Never merge these rows into
the tables above.

| Question | What went stale | drift-baseline | drift |
|---|---|---|---|
| `d01` | firm export capacity 50 → 45 MW, flipping a conclusion | _not yet run_ | _not yet run_ |
| `d02` | commissioning Q3 2029 → Q1 2030, breaking an agreement | _not yet run_ | _not yet run_ |
| `d03` | damages cap 4 → 8 percent | _not yet run_ | _not yet run_ |
| `d04` | an absence the amendment closed | _not yet run_ | _not yet run_ |

> **Format illustration only.** A filled table has the shape below. The `<value>`
> tokens are placeholders and are not results — nothing on this page has been
> measured.
>
> | | baseline | treatment |
> |---|---|---|
> | Correctness (mean, 0–2) | `<value>` | `<value>` |
> | Confabulation rate | `<value>` | `<value>` |
> | Compiled-error propagation rate | `<value>` | `<value>` |

---

## What this cannot tell you

Read this section before quoting any number this harness produces.

1. **It does not measure Almagest's ingest.** The treatment arm reads a *gold
   wiki* — hand-compiled from the fixtures to the letter of the wiki rules. So a
   treatment result is an **upper bound**: it says what a correctly compiled
   wiki buys you, not whether the ingest pipeline produces one. Measuring ingest
   quality is a different benchmark and this is not it.

2. **Nineteen questions is a small sample.** One question flipping moves a
   percentage by roughly five points, and a per-category rate by far more — the
   compiled-error propagation rate has a denominator of four, so one flip is 25
   points. Differences smaller than that are noise. There is no confidence
   interval here because the harness makes one call per question — it does not
   repeat runs.

3. **The judge is a model.** Score the same answers twice and the numbers move.
   If judge and answerer are the same model family, a fabrication convincing to
   one may be convincing to the other. `rubric.md` lists the judge's limits in
   full; they are not incidental.

4. **The corpus is synthetic and small.** Five short, clean, well-structured
   documents. Real sources are longer, messier, worse formatted, and contradict
   each other in subtler ways. Results here are a floor on difficulty, not a
   ceiling.

5. **Scaling is padding, not breadth.** `--scale 50` and `--scale 500` add
   generated distractors that answer nothing. That produces real retrieval
   pressure and nothing else: no new entities, no new relationships, no new
   contradictions, and documents more uniform than any real corpus. A scaled
   result is a lower bound on the retrieval effect, and it is a weaker
   instrument than 500 genuinely distinct documents would be. Do not report a
   scaled figure without its `--scale-seed`.

6. **The planted errors were written by the same hand as the questions.** Four
   deliberately catchable errors are not a sample of the errors a real ingest
   makes, and in the fixture the contradicting source is sitting in the same
   arena — often it would not be. The compiled-error propagation rate says
   whether propagation happens under generous conditions, not how often it
   happens in the field. Read a good score there as a ceiling.

7. **The drift experiment is easy on purpose.** The amended document carries a
   §0 revision table naming every change. If an agent fails to notice, it failed
   with every advantage; if it succeeds, that establishes a floor and nothing
   more.

8. **Mechanical metrics are syntactic.** "Cited a document that exists" is not
   "cited the right document for that claim". The mechanical pass catches
   fabricated citations; only the judge catches misapplied ones.

9. **One corpus, one domain.** Nothing here establishes that the result
   generalises to your material.

10. **Latency and cost are single-sample and environment-bound.** Network
   conditions, model load, and caching all move them. They are reported because
   they are cheap to capture, not because one run establishes them.

---

## Files

| Path | What |
|------|------|
| `run.sh` | Runs the arms, captures answers, timing, and cost |
| `score.sh` | Mechanical scoring always; `--judge` adds the LLM pass; writes the report |
| `selftest.sh` | Verifies the harness against a test double. No API calls |
| `questions.yaml` | 19 questions with ground truth. Format documented in the file header |
| `questions-drift.yaml` | 4 re-ingest questions. Separate file because the drift arms see a different corpus |
| `rubric.md` | Every metric, how it is computed, and what it cannot tell you |
| `prompts/_shared.md` | The answering protocol. **Identical for every arm** |
| `prompts/baseline.md`, `prompts/baseline-retrieval.md`, `prompts/treatment.md` | Corpus orientation — the only prompt difference between arms |
| `prompts/judge.md` | The judge's rubric |
| `fixtures/raw/` | The five fictional source documents |
| `fixtures/wiki/` | The hand-compiled gold wiki. Schema v2; audits clean |
| `fixtures/wiki-poisoned/` | The same wiki with four planted false claims. Also audits clean — see `fixtures/README.md` |
| `fixtures/index.md` | The catalog, beside the wikis and shared by them |
| `fixtures/manifest.yaml` | The machine record. Not copied into any arena |
| `fixtures/poison-manifest.tsv` | What is falsified where. Deliberately outside `wiki-poisoned/` so it never reaches an arena |
| `fixtures/drift/` | Version 2.0 of one source, same filename, different sha256 |
| `fixtures/scale/generate.sh` | Deterministic corpus padding for `--scale` |
| `fixtures/scale/blocklist.txt` | Terms a generated distractor must never contain. Enforced, not advisory |
| `lib/*.awk` | YAML and JSON parsing, in awk, so the harness needs no dependencies |
| `drivers/*.sh` | One per harness: how a question is actually put to an agent |
| `drivers/README.md` | The driver interface, for writing your own |
| `drivers/fake.sh` | Test double used by `selftest.sh`. No API calls, no money |
| `results/` | Run output. Gitignored |

## Extending it

- **Add a question:** append to `questions.yaml` following the format in its
  header, then run `selftest.sh` — it checks that every `expected_sources` and
  `expected_pages` entry resolves.
- **Add an arm:** register it in `MAIN_ARMS` in `lib/common.sh` and give it
  entries in `arm_prompt` and `arm_wiki`. If it needs a prompt of its own, ask
  first whether the new arm then differs from its comparator in more than one
  way — that is how a benchmark stops measuring what it says it measures.
- **Plant another error:** edit `fixtures/wiki-poisoned/`, add a row to
  `fixtures/poison-manifest.tsv`, add a `poisoned_claim` question naming its
  `poison_id`, then run `selftest.sh`. It verifies the literals in both
  directions and that no other page moved.
- **Add a scale tier:** nothing to change. `--scale N` accepts any N at or above
  the real source count; 5 / 50 / 500 are documented because they are the ones
  worth plotting.
- **Swap the corpus:** see the checklist at the end of `fixtures/README.md`.
- **Change the protocol:** edit `prompts/_shared.md` and every arm changes
  together. If you edit `agent/rules/read.md`, `run.sh` warns that the two have
  drifted and records the drift in `run.env`.
- **Add a harness:** write `drivers/<name>.sh` to the interface in
  `drivers/README.md`, then run `selftest.sh`.
