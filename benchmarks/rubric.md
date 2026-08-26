# Scoring rubric

How a run becomes numbers, and which of those numbers you can trust.

The metrics split cleanly in two, and the split matters more than any individual
metric. **Mechanical** checks are deterministic string and file operations: run
them twice on the same answers, get the same result, spend nothing. **Judge**
checks require reading an answer and deciding whether it is true, which no
regular expression can do — so a model does it, and the result carries a model's
variance.

Every table in every report labels which half a number came from. Never quote
one without the label.

---

## Question categories

The category in `questions.yaml` decides which metrics apply to a question. It
is set by the ground truth, never inferred from the answer.

| Category | What it tests | Metrics that apply |
|----------|---------------|--------------------|
| `single_source` | Retrieval of a fact stated in exactly one place | correctness, citation support, source coverage |
| `multi_source_agreement` | A fact two documents state consistently — does the answer cite both? | correctness, citation support, source coverage |
| `contradiction` | A planted, unresolved conflict between two documents | contradiction handling, correctness, citation support |
| `synthesis` | A conclusion no single document states | synthesis flagging, correctness, citation support |
| `unanswerable` | The corpus genuinely does not contain the answer | abstention |
| `unanswerable_trap` | As above, but adjacent material makes a plausible answer easy to fabricate | abstention |
| `citation_precision` | Whether the citation points at a section, not just a document | citation support, section precision |
| `poisoned_claim` | A compiled page asserts something the source it cites contradicts | compiled-error propagation, correctness, citation support |
| `drift` | The source has been amended and the compiled page has not | compiled-error propagation, correctness, citation support |
| `drift_trap` | As above, where the stale page asserts an agreement or an absence the amendment has broken | compiled-error propagation, correctness, citation support |

The last three exist only when an arm was given a defective wiki. On every other
arm they are ordinary questions with an ordinary right answer, and that is what
makes them a control.

---

## Mechanically scored

Free, deterministic, computed by `benchmarks/score.sh` with no model in the
loop. Each one is a *syntactic* property of the answer text.

| Metric | Computed how | What it cannot tell you |
|--------|--------------|-------------------------|
| **Broken wikilink citations** | Extract every `[[slug]]`; check `fixtures/wiki/<slug>.md` exists | Whether the page that *does* exist supports the claim. The catalog is `index.md`, beside the wiki and not a page, so `[[index]]` reads as broken |
| **Fabricated document IDs** | Extract every token matching a tight document-ID pattern; check it against the IDs actually present in the corpus | Whether a *real* document ID was cited for the wrong claim |
| **Expected sources cited** | For each `expected_sources` entry, is its filename or document ID present in the answer? | Whether the citation was attached to the right sentence |
| **Section-level precision** | Does the answer contain at least one `§n` / `section n` reference? | Whether that section is the correct one. This is a proxy and nothing more |
| **Answers with no citation** | Zero wikilinks, zero document IDs, zero filenames | Nothing — this one is exact, and an answer that trips it has already failed |
| **Ground-truth literal recall** | Fraction of `must_contain` strings present, case-insensitive | Correctness. An answer can contain `3.4` while asserting something false about it |
| **`must_not_contain` hits** | Presence of a flagged literal | Whether the hit is a real failure. **Advisory only** — read the answer |
| **Synthesis marker** | Case-insensitive match on `synthesized from` | Whether the flag is on the right claim |
| **Source value present** | On `poisoned_claim`/`drift*` questions, is `poison_true` in the answer? | Whether it was asserted or merely mentioned. **Advisory only** |
| **Compiled-claim value present** | Same, for `poison_false` | **Advisory only, and it is not a propagation rate.** See below |
| **Latency** | `duration_ms` from the CLI's JSON output, falling back to wall clock | Anything about a warm vs. cold cache, or network variance on the day |
| **Cost** | `total_cost_usd` from the CLI's JSON output | What the same run would cost on a different model or plan |

### Deliberately not mechanical

**Unsourced-claim rate.** Counting *claims* means segmenting an answer into
claims, which is a semantic judgement. A count of citations divided by a count of
sentences would be a number that looks rigorous and measures nothing. It goes to
the judge.

**Abstention.** "I cannot answer that" has too many surface forms to pattern
match, and the failure mode that matters — an answer that hedges and then
supplies a fabricated figure anyway — defeats keyword detection entirely.

**Contradiction handling.** Both figures appearing in an answer is necessary and
nowhere near sufficient. The answer must attribute each figure to its source and
state that the conflict is open. That is a reading task.

**Compiled-error propagation.** The two literal checks above look like they
could be subtracted into a rate. They cannot. The best possible answer — "the
page gives 4.6 m, the source it cites gives 3.9 m, the page is wrong" — contains
**both** literals, and so does the worst hedge. The two rows narrow down which
answers to read. The rate itself is judge-scored and appears below.

---

## Judge scored

`benchmarks/score.sh --judge`. One model call per answer. The judge sees the
question, the category, the ground truth, and the answer — and **not** which arm
produced it. Rubric in `benchmarks/prompts/judge.md`; output shape enforced by
`benchmarks/lib/judge-schema.json`.

| Metric | Scale | Headline reading |
|--------|-------|------------------|
| **Correctness** | 0–2 | Does the answer establish what the ground truth requires? For an unanswerable question this scores the *decline*, not an answer |
| **Citation support** | 0–2 | Does each citation point at a location that genuinely contains the claim? Scored independently of correctness — an answer can be right and cite badly, and that is a real defect |
| **Unsourced claims** | count | Substantive factual claims asserted with no citation at all |
| **Abstention** | `correct_decline` / `decline_no_gap_named` / `confabulated` | Only on `unanswerable*` questions. **`confabulated` is the single most important number this harness produces** |
| **Contradiction** | `both_surfaced` / `one_sided` / `missed` | Only on `contradiction` questions |
| **Synthesis flag** | `flagged` / `unflagged` / `over_flagged` | `over_flagged` is a defect too: flagging a directly sourced claim as synthesis makes the flag meaningless |
| **Compiled error** | `caught` / `corrected_silently` / `propagated` / `n/a` | Only on `poisoned_claim` and `drift*` questions. **`propagated` is the number a reader should want before adopting any of this** |

### Compiled-error propagation rate

**What it is.** The share of answers, on questions where a compiled wiki page
asserts something the source documents contradict, that assert the page's claim
anyway. Denominator: the questions in those categories that the arm answered.
It is reported per arm, alongside `caught` — the answers that gave the
source-supported value *and* named the page as wrong or stale.

**Why it is here.** Every other metric in this file tests a failure mode the
baseline shares. This one tests the failure mode the treatment arm has and the
baseline structurally cannot: compilation is a write, a wrong write is durable,
and a wrong claim inside a wiki page carries more authority than the source
sitting next to it — correct frontmatter, a real document ID, a real section
number, no hedging. Confabulation is the failure a knowledge base is meant to
prevent. Compiled-error propagation is the failure a knowledge base *introduces*.
A harness that measured the first and not the second would be measuring only its
own side of the argument.

Stale and wrong score on the same field on purpose. From the reader's seat,
"this page was never right" and "this page was right in 2027" produce the same
sentence in the same tone with the same citation.

**Three values, not two.** `corrected_silently` — gave the right answer, said
nothing about the page — **is not a defect and is not scored as one**. Arms with
no wiki, or with the correct one, land there and should: they never saw a false
claim. It means "did not repeat it", nothing more. Reading it as a defect would
turn every baseline answer into a failure and the metric into noise.

**What it cannot tell you.**

1. **The errors were planted by the same hand that wrote the questions.** Four
   specific, deliberately catchable errors are not a sample of the errors a real
   ingest makes. They establish that propagation happens or does not happen
   under these conditions, not how often it happens in the field.
2. **The arms were told to check, and given what to check against.** Every arm
   can open `sources/`, and `prompts/treatment.md` says in terms that where a
   page and the source it cites disagree, the source wins. That sentence is a
   faithful restatement of two rules in the shipped `agent/rules/read.md` — "the
   original source is the authority" and "a stale citation is a broken one" — so
   removing it would benchmark a weaker configuration than Almagest actually
   ships. It does mean the number is measured under generous conditions: a real
   deployment often keeps the compiled page and the original far apart, or
   discards the original entirely, and nobody reminds the reader to look. **Read
   a good score here as a ceiling, not a floor.**
3. **It does not price the error.** Propagating a wave height and propagating a
   closed contradiction score identically. `q19` matters more than `q16` and the
   rate does not know that. Read the per-question table.
4. **P4 contaminates the contradiction row on the poisoned arm.** The fourth
   planted error closes the corpus's only contradiction, which `q05`, `q06`, and
   `q09` also probe. On the `poisoned` arm those three are no longer a control.
   That was accepted deliberately: there is one contradiction in the fixture and
   testing whether a page can close one is worth more than three comparable
   cells. Do not read the poisoned arm's contradiction figure as a query-layer
   result.
5. **Four questions per arm is a very small denominator.** One flip moves the
   rate 25 points. It is a smoke test with teeth, not an estimate.

### Why the judge is separated from correctness

Citation support is scored on its own axis on purpose. The obsidian-wiki-style
metric — accuracy — treats a right answer as a pass. Almagest's claim is that a
right answer you cannot verify is not good enough. Splitting the axes is what
lets a report show an arm scoring well on correctness and badly on citation
support, which is exactly the failure this project exists to catch.

### Limits of the judge

Read these before quoting a judge-scored number.

1. **It is a model.** Run the same scoring twice and the numbers will move. The
   harness does not currently estimate that variance — it makes one judge call
   per answer. If you need a confidence interval, run the judge pass several
   times and compare; there is no built-in support for it yet.
2. **Judge and answerer may share a bias.** If both are the same model family,
   a fabrication that reads convincingly to the answerer may read convincingly
   to the judge. Running the judge on a different model than the answering arms
   makes the numbers more defensible. `--judge-model` exists for this.
3. **It scores against ground truth written by a human.** If the ground truth in
   `questions.yaml` is wrong or ambiguous, the judge propagates that error with
   perfect consistency. The ground-truth text is part of the benchmark and
   deserves the same review as the code.
4. **It is blind to the arm but not to style.** A wiki-derived answer and a
   raw-source answer read differently. The judge is instructed to score content
   over form, but the instruction is not a guarantee.
5. **Nineteen questions is a small sample.** One question flipping moves a
   percentage by around five points, and a per-category rate by far more — four
   `poisoned_claim` questions means one flip is 25 points. Differences smaller
   than that are noise. Treat the question set as a smoke test with teeth, not a
   population estimate.
6. **It is told about a wiki claim the answer may never have seen.** The ground
   truth for a `poisoned_claim` or `drift*` question describes the false claim so
   `compiled_error` can be scored, and the judge sees that text whichever arm it
   is scoring. `prompts/judge.md` instructs it not to penalise an answer for
   failing to mention a page it was never given. That is an instruction, not a
   guarantee, and it is the one place the blind design leaks.

---

## Reading a report

- A metric with no data prints `not run` or `n/a`. It never prints a number.
- A run with any failure exits non-zero and the report says so. Do not quote a
  partial run.
- Denominators come from the ground-truth category, not from the judge. A judge
  that forgets to return `n/a` cannot inflate one.
- The per-question table is the useful part. Aggregates hide which question
  moved.
