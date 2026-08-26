#!/usr/bin/env bash
#
# benchmarks/selftest.sh — verify the harness without spending a cent.
#
# Runs the whole pipeline against benchmarks/drivers/fake.sh, a test double
# that makes no API calls. It checks that the scaffolding works: parsers, arena
# isolation, capture, the driver layer and its capability guards, mechanical
# scoring, report rendering, and every failure branch. It proves nothing about
# answer quality — that is what the real run is for.
#
# Run this after changing anything under benchmarks/.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

STUB="$BM_DIR/drivers/fake.sh"
LABEL="selftest"
WORK="$BM_DIR/results/_selftest"
# Throwaway drivers and doctored copies live outside the results root, so the
# "dry run writes nothing" check keeps meaning what it says.
SCRATCH="$(mktemp -d -t almagest-selftest.XXXXXX)"
PASS=0; FAIL=0

check() {
    if eval "$2" >/dev/null 2>&1; then printf '  %s %s\n' "${C_GRN}✓${C_OFF}" "$1"; PASS=$((PASS+1))
    else                               printf '  %s %s\n' "${C_RED}✗${C_OFF}" "$1"; FAIL=$((FAIL+1)); fi
}

cleanup() { rm -rf "$WORK" "$SCRATCH"; }
trap cleanup EXIT
assert_inside_benchmarks "$WORK"
rm -rf "$WORK"; mkdir -p "$WORK"

# Blast-radius baseline, taken before anything runs. The trees the benchmark
# must never touch are compared before against after, which is stricter than
# "must be clean" — it catches a change this selftest made, and is not fooled by
# unrelated edits that were already in the working tree.
snapshot() { git -C "$REPO_DIR" status --porcelain -- "$1" 2>/dev/null || true; }
WIKI_BEFORE="$(snapshot brain/wiki/)"
SITE_BEFORE="$(snapshot site/)"

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
check "json extractor reads a payload"   "ALM_PROMPT=x '$STUB' run | awk -v raw=result -f '$LIB_DIR/json_scalar.awk' | grep -q 'Gannet'"
check "json extractor rejects non-object" "! echo '[]' | awk -f '$LIB_DIR/json_scalar.awk'"

# Quote, backslash, tab and newline are the four that turn a driver's plain-text
# answer into invalid JSON. Escape them, parse them back, compare bytes.
json_roundtrip() {
    printf 'a"b\\c\td\ne' > "$SCRATCH/esc.in"
    printf '{"r":"%s"}\n' "$(awk -f "$LIB_DIR/json_escape.awk" < "$SCRATCH/esc.in")" > "$SCRATCH/esc.json"
    awk -v raw=r -f "$LIB_DIR/json_scalar.awk" "$SCRATCH/esc.json" > "$SCRATCH/esc.out"
    cmp -s "$SCRATCH/esc.in" "$SCRATCH/esc.out"
}
check "json escaper survives a round trip" "json_roundtrip"

# ── 2. drivers ───────────────────────────────────────────────────────────────
info "Driver layer"
check "fake driver reports capabilities" "test \$('$STUB' capabilities | wc -l) -eq 6"
check "every capability key is present"  "for k in $CAP_KEYS; do '$STUB' capabilities | awk -F'\t' -v k=\$k '\$1==k{f=1} END{exit !f}' || exit 1; done"
check "every capability is yes or no"    "! '$STUB' capabilities | awk -F'\t' '\$2!=\"yes\" && \$2!=\"no\"' | grep -q ."
check "capability overrides work"        "ALMAGEST_STUB_CAPS=structured_output=no '$STUB' capabilities | awk -F'\t' '\$1==\"structured_output\" && \$2==\"no\" {f=1} END{exit !f}'"
check "driver reports a version"         "test -n \"\$('$STUB' version)\""
check "unknown subcommand -> nonzero"    "! '$STUB' banana"
check "shipped drivers all answer capabilities" \
      "for d in '$BM_DIR'/drivers/*.sh; do \$d capabilities | awk -F'\t' 'END{exit (NR<6)}' || exit 1; done"
check "shipped drivers are all executable" \
      "for d in '$BM_DIR'/drivers/*.sh; do test -x \$d || exit 1; done"
check "capability parser rejects a bad driver" \
      "printf '#!/bin/sh\nexit 0\n' > '$SCRATCH/bad.sh' && chmod +x '$SCRATCH/bad.sh' \
       && ! '$BM_DIR/run.sh' --dry-run --driver '$SCRATCH/bad.sh' --out '$WORK'"
check "unknown driver name -> nonzero exit" \
      "! '$BM_DIR/run.sh' --dry-run --driver nosuchdriver --out '$WORK'"

# ── 3. fixtures ──────────────────────────────────────────────────────────────
info "Fixtures"
check "fixture corpus is present"        "check_fixtures"
check "no fixture leaks into brain/raw"  "! ls '$REPO_DIR'/brain/raw/kb-*.md 2>/dev/null | grep -q ."
check "no fixture leaks into brain/wiki" "! ls '$REPO_DIR'/brain/wiki/kestrel*.md 2>/dev/null | grep -q ."
check "planted contradiction present"    "grep -q '2.9 MW' '$FIXTURES_DIR/raw/kb-04-independent-verification-memo.md' && grep -q '3.2 MW' '$FIXTURES_DIR/raw/kb-03-vendor-technical-note.md'"
check "absent topic really is absent"    "! grep -rlqi 'decommissioning cost' '$FIXTURES_DIR/raw/'"
check "every expected_source exists"     "for f in \$(parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"expected_sources\"{print \$3}' | sort -u); do test -f '$FIXTURES_DIR/raw/'\$f || exit 1; done"
check "every expected_page exists"       "for p in \$(parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"expected_pages\"{print \$3}' | sort -u); do test -f '$FIXTURES_DIR/wiki/'\$p.md || exit 1; done"

# ── 4. dry run ───────────────────────────────────────────────────────────────
info "Dry run"
check "dry run succeeds and writes nothing" \
      "'$BM_DIR/run.sh' --dry-run --driver '$STUB' --out '$WORK' && test -z \"\$(ls -A '$WORK')\""

# ── 5. end-to-end against the test double ────────────────────────────────────
info "End to end (test double)"
set +e
"$BM_DIR/run.sh" --driver "$STUB" \
    --only q01,q05,q10 --label "$LABEL" --out "$WORK" --yes >/dev/null 2>&1
rc=$?
set -e
check "run.sh completes"                 "test $rc -eq 0"
RUN_DIR="$(ls -d "$WORK"/$LABEL-* 2>/dev/null | head -1)"
check "run directory created"            "test -n '$RUN_DIR' -a -d '$RUN_DIR'"
check "run.env written"                  "test -s '$RUN_DIR/run.env'"
check "run.env records the stub driver"  "grep -q '^driver=fake$' '$RUN_DIR/run.env'"
check "run.env records the driver version" "grep -q '^driver_version=fake-claude' '$RUN_DIR/run.env'"
check "run.env records every capability" "test \$(grep -c '^cap_' '$RUN_DIR/run.env') -eq 6"
check "run.env capability values are yes/no" \
      "! grep '^cap_' '$RUN_DIR/run.env' | grep -vqE '=(yes|no)\$'"
check "run.env bumped harness_version"   "grep -q '^harness_version=2$' '$RUN_DIR/run.env'"
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

info "Driver guards"
check "every answer records the driver that produced it" \
      "test \$(awk -F'\t' '\$1==\"driver\"' '$RUN_DIR'/baseline/*.meta.tsv '$RUN_DIR'/treatment/*.meta.tsv | grep -c 'fake') -eq 6"
# Both arms of a run must come from the same driver. run.sh cannot produce a
# mixed run on its own; a hand-assembled one must still never be scored.
mixed_run() {
    local d="$WORK/mixed/$(basename "$RUN_DIR")" m
    rm -rf "$WORK/mixed"; mkdir -p "$WORK/mixed"
    cp -R "$RUN_DIR" "$d"
    m="$d/treatment/q01.meta.tsv"
    awk -F'\t' -v OFS='\t' '$1=="driver" { $2="someone-else" } 1' "$m" > "$m.new"
    mv "$m.new" "$m"
    grep -q 'someone-else' "$m" || return 1        # the doctoring itself must work
    if "$BM_DIR/score.sh" --run "$d" > "$WORK/mixed/score.log" 2>&1; then return 1; fi
    grep -q 'same driver' "$WORK/mixed/score.log"
}
check "a mixed-driver run is refused"    "mixed_run"
check "uncapped spend warns and needs --yes" \
      "! ALMAGEST_STUB_CAPS=budget_cap=no '$BM_DIR/run.sh' --driver '$STUB' --only q01 \
          --arm baseline --label 'cap-$LABEL' --out '$WORK' </dev/null"
check "uncapped spend proceeds with --yes" \
      "ALMAGEST_STUB_CAPS=budget_cap=no '$BM_DIR/run.sh' --driver '$STUB' --only q01 \
          --arm baseline --label 'cap-$LABEL' --out '$WORK' --yes </dev/null"

# run.sh narrates to stderr. Capture it to a file rather than piping into
# `grep -q`, which exits on the first match and would SIGPIPE the very run it is
# inspecting — killing it mid-preflight and proving nothing.
unrestricted_tools_warn() {
    ALMAGEST_STUB_CAPS=tool_restriction=no "$BM_DIR/run.sh" --driver "$STUB" --only q01 \
        --arm baseline --label "tools-$LABEL" --out "$WORK" --yes > "$SCRATCH/tools.log" 2>&1 </dev/null || return 1
    grep -q 'NOT comparable' "$SCRATCH/tools.log"
}
deprecated_env_warns() {
    ALMAGEST_BENCH_CLAUDE_BIN="$STUB" "$BM_DIR/run.sh" --only q01 --arm baseline \
        --label "dep-$LABEL" --out "$WORK" --yes > "$SCRATCH/dep.log" 2>&1 </dev/null || return 1
    grep -q 'deprecated' "$SCRATCH/dep.log" && grep -q '^driver=fake$' "$(ls -d "$WORK"/dep-$LABEL-*/run.env | head -1)"
}
check "unrestricted tools warn, loudly"  "unrestricted_tools_warn"
check "a no capability is recorded in run.env" \
      "grep -q '^cap_tool_restriction=no\$' \$(ls -d '$WORK'/tools-$LABEL-*/run.env | head -1)"
check "deprecated ALMAGEST_BENCH_CLAUDE_BIN still runs, with a warning" "deprecated_env_warns"

# ── 6. scoring ───────────────────────────────────────────────────────────────
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
check "report names the driver"          "grep -q '^| Driver | \`fake\`' '$RUN_DIR/report.md'"
check "report has a comparability block" "grep -q '^## Comparability' '$RUN_DIR/report.md'"
check "not-run judge table is all placeholders" \
      "test \$(grep -cE '^\| (Correctness|Fully correct|Citation support|Unsourced claims|Confabulation|Correct declines|Contradictions|Synthesis correctly) [^|]*\\| — \\| — \\|\$' '$RUN_DIR/report.md') -eq 8"
check "report has no numeral in the not-run table" \
      "! grep -E '^\| (Confabulation rate|Correct declines|Contradictions fully|Unsourced claims)' '$RUN_DIR/report.md' | grep -qE '\\| *[0-9]'"

# A capability reported `no` must reach the report, not stop at run.env.
set +e
TOOLS_RUN="$(ls -d "$WORK"/tools-$LABEL-* 2>/dev/null | head -1)"
"$BM_DIR/score.sh" --run "$TOOLS_RUN" >/dev/null 2>&1
set -e
check "comparability block names the missing capability" \
      "grep -q '\`tool_restriction\` = no' '$TOOLS_RUN/report.md'"

info "Judge (test double)"
set +e
ALMAGEST_STUB_MODE=verdict \
    "$BM_DIR/score.sh" --run "$RUN_DIR" --driver "$STUB" --judge --yes >/dev/null 2>&1
rc=$?
set -e
check "judge pass completes"             "test $rc -eq 0"
check "judge scores written"             "test -s '$RUN_DIR/scores-judge.tsv'"
check "judge verdict parsed"             "grep -q 'judge_correctness' '$RUN_DIR/scores-judge.tsv'"
check "report now shows judge metrics"   "grep -q 'Correctness (mean' '$RUN_DIR/report.md'"
set +e
ALMAGEST_STUB_CAPS=structured_output=no "$BM_DIR/score.sh" --run "$RUN_DIR" \
    --driver "$STUB" --judge --yes > "$SCRATCH/refuse.log" 2>&1
rc=$?
set -e
check "judge refuses a driver without structured output" "test $rc -ne 0"
check "the refusal says which capability is missing" \
      "grep -q 'structured_output=no' '$SCRATCH/refuse.log'"
check "the refusal names a driver that can judge" \
      "grep -q 'claude-code' '$SCRATCH/refuse.log'"
check "the refusal spends nothing"       "! grep -q 'judging ' '$SCRATCH/refuse.log'"

# ── 7. failure branches ──────────────────────────────────────────────────────
info "Failure branches (each must fail loudly, not silently)"
run_stub() {
    set +e
    ALMAGEST_STUB_MODE="$1" "$BM_DIR/run.sh" --driver "$STUB" \
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
      "! '$BM_DIR/run.sh' --driver '$STUB' --only q01 --arm baseline --out '$WORK' </dev/null"

# ── 8. nothing outside benchmarks/ was touched ───────────────────────────────
info "Blast radius"
# Scoped to files the benchmark could plausibly have created. A blanket
# "git status is clean" check would break in a repo with unrelated edits.
check "no fixture source escaped benchmarks/" \
      "test -z \"\$(find '$REPO_DIR' -name 'kb-0*-*.md' -not -path '*/benchmarks/*' 2>/dev/null)\""
check "no fixture wiki page escaped benchmarks/" \
      "test -z \"\$(find '$REPO_DIR' -name 'kestrel-basin-tidal-array.md' -o -name 'vm-320-turbine.md' | grep -v '/benchmarks/' 2>/dev/null)\""
check "no results directory outside benchmarks/" \
      "test -z \"\$(find '$REPO_DIR' -type d -name 'arena' -not -path '*/benchmarks/*' 2>/dev/null)\""
check "brain/wiki gained no pages"       "test \"\$(snapshot brain/wiki/)\" = \"\$WIKI_BEFORE\""
check "site/ untouched"                  "test \"\$(snapshot site/)\" = \"\$SITE_BEFORE\""

rule
if [ "$FAIL" -eq 0 ]; then
    ok "selftest passed — $PASS check(s), no API calls, no cost"
    rule
    exit 0
fi
printf '%s\n' "${C_RED}✗ selftest FAILED — $FAIL of $((PASS+FAIL)) check(s)${C_OFF}" >&2
rule
exit 1
