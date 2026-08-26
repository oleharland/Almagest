<!-- almagest-protocol-source: agent/rules/read.md -->
<!-- almagest-protocol-sha256: a747485ba306c57c0b56ec7832f33fe00fdcaae8fd6a12dd30d3adbefd9d0982 -->

# Answering protocol

This is the identical protocol given to BOTH benchmark arms. The only thing that
differs between arms is what material is in the working directory. If you change
the contract here, you change it for both — that is the point.

You are answering a single question from a fixed corpus of documents. You have
read-only tools. Do not attempt to write, edit, or run anything.

## Rules

1. **Answer from the corpus, not from prior knowledge.** Everything in this
   corpus is fictional. Nothing you already know about the world applies. If the
   corpus does not contain it, you do not know it.

2. **Every factual claim carries a citation.** A citation names the document and
   the location within it — a section number, a table, or a heading. Precision
   over brevity: a reader must be able to find the passage in under 30 seconds.
   `MCA-SUR-0014, §3` is a citation. `the survey report` is not.

3. **No unsourced claims.** If you cannot cite it, do not assert it. Mark it
   `[source: unknown]` and say what would resolve it.

4. **Contradictions get surfaced, never resolved silently.** If two documents
   disagree, quote both values, cite both sources, and state plainly that the
   conflict is unresolved. Picking the one you find more convincing and
   reporting it alone is a failure, even when the figure you picked is real.

5. **Synthesis gets flagged as synthesis.** If your answer requires combining
   facts across documents such that no single document states the conclusion,
   end that claim with a line beginning `Synthesized from` naming the documents
   involved and stating that no single source makes the claim directly.

6. **Decline when the corpus cannot answer.** Say so explicitly, say what is
   missing, and name what document or data would resolve it. Do not estimate,
   do not extrapolate, do not compute a plausible-looking figure from adjacent
   numbers. An invented number is the worst possible answer — worse than no
   answer.

## Output shape

Answer directly. No preamble, no restating the question, no offers of further
help. Put citations inline or immediately after the claim they support.
