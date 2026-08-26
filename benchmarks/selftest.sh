#!/usr/bin/env bash
#
# benchmarks/selftest.sh — verify the harness without spending a cent.
#
# Runs the whole pipeline against benchmarks/lib/fake_claude.sh, a test double
# that makes no API calls. It checks that the scaffolding works: parsers, arena
# isolation, capture, mechanical scoring, report rendering, and every failure
# branch. It proves nothing about answer quality — that is what the real run is
# for.
#
# Run this after changing anything under benchmarks/.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

STUB="$BM_DIR/lib/fake_claude.sh"
LABEL="selftest"
WORK="$BM_DIR/results/_selftest"
PASS=0; FAIL=0

check() {
    if eval "$2" >/dev/null 2>&1; then printf '  %s %s\n' "${C_GRN}✓${C_OFF}" "$1"; PASS=$((PASS+1))
    else                               printf '  %s %s\n' "${C_RED}✗${C_OFF}" "$1"; FAIL=$((FAIL+1)); fi
}

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT
assert_inside_benchmarks "$WORK"
rm -rf "$WORK"; mkdir -p "$WORK"

rule
info "${C_BLD}Almagest benchmark harness — selftest${C_OFF} (no API calls, no cost)"
rule

# ── 1. parsers ───────────────────────────────────────────────────────────────
info "Parsers"
check "questions.yaml parses"            "parse_questions '$DEFAULT_QUESTIONS'"
check "every question has a category"    "test \$(parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"category\"' | wc -l) -eq \$(parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"id\"' | wc -l)"
check "unanswerable questions exist"     "parse_questions '$DEFAULT_QUESTIONS' | grep -q 'unanswerable'"
check "contradiction questions exist"    "parse_questions '$DEFAULT_QUESTIONS' | grep -q 'contradiction'"
check "synthesis questions exist"        "parse_questions '$DEFAULT_QUESTIONS' | grep -q 'synthesis'"
check "malformed yaml is rejected"       "! printf 'questions:\n  - id: bad\n' | awk -f '$LIB_DIR/parse_questions.awk'"
check "json extractor reads a payload"   "'$STUB' -p x | awk -v raw=result -f '$LIB_DIR/json_scalar.awk' | grep -q 'Gannet'"
check "json extractor rejects non-object" "! echo '[]' | awk -f '$LIB_DIR/json_scalar.awk'"

# ── 2. fixtures ──────────────────────────────────────────────────────────────
info "Fixtures"
check "fixture corpus is present"        "check_fixtures"
check "no fixture leaks into brain/raw"  "! ls '$REPO_DIR'/brain/raw/kb-*.md 2>/dev/null | grep -q ."
check "no fixture leaks into brain/wiki" "! ls '$REPO_DIR'/brain/wiki/kestrel*.md 2>/dev/null | grep -q ."
check "planted contradiction present"    "grep -q '2.9 MW' '$FIXTURES_DIR/raw/kb-04-independent-verification-memo.md' && grep -q '3.2 MW' '$FIXTURES_DIR/raw/kb-03-vendor-technical-note.md'"
check "absent topic really is absent"    "! grep -rlqi 'decommissioning cost' '$FIXTURES_DIR/raw/'"
check "every expected_source exists"     "for f in \$(parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"expected_sources\"{print \$3}' | sort -u); do test -f '$FIXTURES_DIR/raw/'\$f || exit 1; done"
check "every expected_page exists"       "for p in \$(parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"expected_pages\"{print \$3}' | sort -u); do test -f '$FIXTURES_DIR/wiki/'\$p.md || exit 1; done"

# ── 3. dry run ───────────────────────────────────────────────────────────────
info "Dry run"
check "dry run succeeds and writes nothing" \
      "'$BM_DIR/run.sh' --dry-run --out '$WORK' && test -z \"\$(ls -A '$WORK')\""

# ── 4. end-to-end against the test double ────────────────────────────────────
info "End to end (test double)"
set +e
ALMAGEST_BENCH_CLAUDE_BIN="$STUB" "$BM_DIR/run.sh" \
    --only q01,q05,q10 --label "$LABEL" --out "$WORK" --yes >/dev/null 2>&1
rc=$?
set -e
check "run.sh completes"                 "test $rc -eq 0"
RUN_DIR="$(ls -d "$WORK"/$LABEL-* 2>/dev/null | head -1)"
check "run directory created"            "test -n '$RUN_DIR' -a -d '$RUN_DIR'"
check "run.env written"                  "test -s '$RUN_DIR/run.env'"
check "run.env records the stub binary"  "grep -q 'claude_bin=.*fake_claude' '$RUN_DIR/run.env'"
check "6 answers captured (3 x 2 arms)"  "test \$(ls '$RUN_DIR'/baseline/*.answer.md '$RUN_DIR'/treatment/*.answer.md | wc -l) -eq 6"
check "latency captured from the payload" "grep -q 'latency_ms	18420' '$RUN_DIR/baseline/q01.meta.tsv'"
check "cost captured from the payload"   "grep -q 'cost_usd	0.0374' '$RUN_DIR/baseline/q01.meta.tsv'"

info "Arena isolation"
check "baseline arena has sources"       "test -d '$RUN_DIR/arena/baseline/sources'"
check "baseline arena has NO wiki"       "! test -e '$RUN_DIR/arena/baseline/wiki'"
check "treatment arena has wiki"         "test -d '$RUN_DIR/arena/treatment/wiki'"
check "treatment arena has the index"    "test -f '$RUN_DIR/arena/treatment/wiki/index.md'"
check "arena is a copy, not a symlink"   "! test -L '$RUN_DIR/arena/treatment/wiki'"
check "arena holds no brain/ content"    "! grep -rlq 'Almagest' '$RUN_DIR/arena/' "

# ── 5. scoring ───────────────────────────────────────────────────────────────
info "Scoring"
set +e
"$BM_DIR/score.sh" --run "$RUN_DIR" >/dev/null 2>&1
rc=$?
set -e
check "score.sh completes"               "test $rc -eq 0"
MECH="$RUN_DIR/scores-mechanical.tsv"
check "mechanical scores written"        "test -s '$MECH'"
check "broken wikilink detected"         "awk -F'\t' '\$4==\"cited_pages_broken\" && \$5>0' '$MECH' | grep -q ."
check "fabricated doc id detected"       "awk -F'\t' '\$4==\"fabricated_doc_ids\" && \$5>0' '$MECH' | grep -q ."
check "real doc id NOT flagged"          "! grep -q 'MCA-SUR-0014' \$(awk -F'\t' '\$4==\"fabricated_doc_id_list\"{print}' '$MECH' >/dev/null; echo '$MECH')"
check "section precision detected"       "awk -F'\t' '\$4==\"section_precision\" && \$5==1' '$MECH' | grep -q ."
check "synthesis marker detected"        "awk -F'\t' '\$4==\"synthesis_marker\" && \$5==1' '$MECH' | grep -q ."
check "must_contain recall computed"     "awk -F'\t' '\$4==\"must_contain_hits\"' '$MECH' | grep -q ."
check "report written"                   "test -s '$RUN_DIR/report.md'"
check "report marks judge as NOT run"    "grep -q 'Not run' '$RUN_DIR/report.md'"
check "report flags the stub binary"     "grep -q 'stub, not the real CLI' '$RUN_DIR/report.md'"
check "not-run judge table is all placeholders" \
      "test \$(grep -cE '^\| (Correctness|Fully correct|Citation support|Unsourced claims|Confabulation|Correct declines|Contradictions|Synthesis correctly) [^|]*\\| — \\| — \\|\$' '$RUN_DIR/report.md') -eq 8"
check "report has no numeral in the not-run table" \
      "! grep -E '^\| (Confabulation rate|Correct declines|Contradictions fully|Unsourced claims)' '$RUN_DIR/report.md' | grep -qE '\\| *[0-9]'"

info "Judge (test double)"
set +e
ALMAGEST_BENCH_CLAUDE_BIN="$STUB" ALMAGEST_STUB_MODE=verdict \
    "$BM_DIR/score.sh" --run "$RUN_DIR" --judge --yes >/dev/null 2>&1
rc=$?
set -e
check "judge pass completes"             "test $rc -eq 0"
check "judge scores written"             "test -s '$RUN_DIR/scores-judge.tsv'"
check "judge verdict parsed"             "grep -q 'judge_correctness' '$RUN_DIR/scores-judge.tsv'"
check "report now shows judge metrics"   "grep -q 'Correctness (mean' '$RUN_DIR/report.md'"

# ── 6. failure branches ──────────────────────────────────────────────────────
info "Failure branches (each must fail loudly, not silently)"
run_stub() {
    set +e
    ALMAGEST_BENCH_CLAUDE_BIN="$STUB" ALMAGEST_STUB_MODE="$1" "$BM_DIR/run.sh" \
        --only q01 --arm baseline --label "fail-$1" --out "$WORK" --yes >/dev/null 2>&1
    local r=$?; set -e; return $r
}
check "empty answer -> nonzero exit"     "! run_stub empty"
check "malformed json -> nonzero exit"   "! run_stub malformed"
check "cli failure -> nonzero exit"      "! run_stub error"
check "bad --only id -> nonzero exit"    "! '$BM_DIR/run.sh' --dry-run --only nosuch --out '$WORK'"
check "bad --arm -> nonzero exit"        "! '$BM_DIR/run.sh' --dry-run --arm sideways --out '$WORK'"
check "missing --run -> nonzero exit"    "! '$BM_DIR/score.sh'"
check "unknown run dir -> nonzero exit"  "! '$BM_DIR/score.sh' --run nope --out '$WORK'"
check "score.sh accepts a relative path" "( cd '$REPO_DIR' && '$BM_DIR/score.sh' --run \"\${RUN_DIR#$REPO_DIR/}\" >/dev/null )"
check "unattended run without --yes fails" \
      "! ALMAGEST_BENCH_CLAUDE_BIN='$STUB' '$BM_DIR/run.sh' --only q01 --arm baseline --out '$WORK' </dev/null"

# ── 7. nothing outside benchmarks/ was touched ───────────────────────────────
info "Blast radius"
# Scoped to files the benchmark could plausibly have created. A blanket
# "git status is clean" check would break in a repo with unrelated edits.
check "no fixture source escaped benchmarks/" \
      "test -z \"\$(find '$REPO_DIR' -name 'kb-0*-*.md' -not -path '*/benchmarks/*' 2>/dev/null)\""
check "no fixture wiki page escaped benchmarks/" \
      "test -z \"\$(find '$REPO_DIR' -name 'kestrel-basin-tidal-array.md' -o -name 'vm-320-turbine.md' | grep -v '/benchmarks/' 2>/dev/null)\""
check "no results directory outside benchmarks/" \
      "test -z \"\$(find '$REPO_DIR' -type d -name 'arena' -not -path '*/benchmarks/*' 2>/dev/null)\""
check "brain/wiki gained no pages"       "test -z \"\$(git -C '$REPO_DIR' status --porcelain -- brain/wiki/ 2>/dev/null)\""
check "site/ untouched"                  "test -z \"\$(git -C '$REPO_DIR' status --porcelain -- site/ 2>/dev/null)\""

rule
if [ "$FAIL" -eq 0 ]; then
    ok "selftest passed — $PASS check(s), no API calls, no cost"
    rule
    exit 0
fi
printf '%s\n' "${C_RED}✗ selftest FAILED — $FAIL of $((PASS+FAIL)) check(s)${C_OFF}" >&2
rule
exit 1
