#!/usr/bin/env bash
#
# benchmarks/score.sh — turn a run into numbers, and write the report.
#
# Two passes:
#   1. MECHANICAL (free, deterministic, always runs). Syntactic checks on the
#      answers: do cited pages exist, do cited document IDs exist, were the
#      expected sources cited, is there a section-level reference, is there a
#      synthesis marker, do the ground-truth literals appear, latency, cost.
#   2. JUDGE (--judge, COSTS REAL TOKENS, opt-in). One agent call per answer,
#      scoring correctness, citation support, unsourced claims, abstention,
#      contradiction handling, synthesis flagging, and compiled-error
#      propagation against ground truth.
#      It goes through the same driver layer as run.sh, and refuses to run on a
#      driver that cannot hold its CLI to the verdict schema.
#
# The split is the honest part of this harness. Pass 1 numbers are reproducible
# and free. Pass 2 numbers involve a model's judgement and will move between
# runs. Both are labelled as such everywhere they appear.
#
# Writes only inside the run directory, which is inside benchmarks/.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

RUN=""
RESULTS_DIR="$DEFAULT_RESULTS_DIR"
QUESTIONS="$DEFAULT_QUESTIONS"
DO_JUDGE=0
JUDGE_MODEL="opus"
BUDGET_USD="0.50"
ASSUME_YES=0
DRY_RUN=0

# Which harness judges. Same driver layer as run.sh; it need not be the driver
# that produced the run — judging with a different harness is a deliberate
# choice, the same way judging with a different model is.
DRIVER_SPEC="${ALMAGEST_BENCH_DRIVER:-}"
DRIVER_SPEC_FROM_FLAG=""

# A token that looks like a document ID in this corpus. Anything matching it
# that is not in the corpus is a fabricated citation. Tight on purpose: it must
# not match model names (VM-320) or station codes (KB-N). Adjust this if you
# replace the fixture corpus with your own.
# Spelled out as [A-Z]{2,5}-[A-Z]{2,5}-[0-9]{4}(-[0-9]{3})? would read better,
# but mawk (Ubuntu's default awk) panics on {m,n} intervals. Keep it expanded.
DOCID_RE='[A-Z][A-Z][A-Z]?[A-Z]?[A-Z]?-[A-Z][A-Z][A-Z]?[A-Z]?[A-Z]?-[0-9][0-9][0-9][0-9](-[0-9][0-9][0-9])?'

usage() {
    cat <<'USAGE'
Usage: benchmarks/score.sh --run <run-id> [options]

  --run ID|PATH        Run directory to score (id under benchmarks/results, or a path)
  --questions FILE     Question set used for the run (default: benchmarks/questions.yaml)
  --out DIR            Results root (default: benchmarks/results)
  --judge              Also run the LLM judge. COSTS REAL TOKENS.
  --driver NAME|PATH   Harness driver for the judge (default: claude-code)
                       Env: ALMAGEST_BENCH_DRIVER
  --judge-model NAME   Model for the judge (default: opus)
  --budget-usd N       Per-judge-call spend cap (default: 0.50)
  --dry-run            Show what the judge would do. Calls nothing.
  --yes                Skip the judge cost confirmation
  -h, --help           This

The mechanical pass is free and always runs. --judge is the expensive half.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --run)         RUN="${2:?--run needs a value}"; shift 2 ;;
        --questions)   QUESTIONS="${2:?}"; shift 2 ;;
        --out)         RESULTS_DIR="${2:?}"; shift 2 ;;
        --judge)       DO_JUDGE=1; shift ;;
        --driver)      DRIVER_SPEC_FROM_FLAG="${2:?--driver needs a value}"; shift 2 ;;
        --judge-model) JUDGE_MODEL="${2:?}"; shift 2 ;;
        --budget-usd)  BUDGET_USD="${2:?}"; shift 2 ;;
        --dry-run)     DRY_RUN=1; shift ;;
        --yes|-y)      ASSUME_YES=1; shift ;;
        -h|--help)     usage; exit 0 ;;
        *)             usage >&2; die "unknown argument: $1" ;;
    esac
done

RESULTS_DIR="$(abspath "$RESULTS_DIR")"

[ -n "$RUN" ] || { usage >&2; die "--run is required"; }

# A bare name is a run id under the results root; anything with a slash is a path.
case "$RUN" in
    */*) RUN_DIR="$(abspath "$RUN")" ;;
    *)   RUN_DIR="$RESULTS_DIR/$RUN" ;;
esac
[ -d "$RUN_DIR" ] || die "run directory not found: $RUN_DIR"
assert_inside_benchmarks "$RUN_DIR"
[ -f "$RUN_DIR/run.env" ] || die "$RUN_DIR has no run.env — not a benchmark run directory"

need_cmd awk
need_cmd sed
[ -f "$QUESTIONS" ] || die "question set not found: $QUESTIONS"

# ── driver preflight — fail loudly, before spending anything ─────────────────
# The mechanical pass needs no agent at all, so the driver is only resolved and
# interrogated when --judge is asked for.
if [ -n "${ALMAGEST_BENCH_CLAUDE_BIN:-}" ]; then
    warn "ALMAGEST_BENCH_CLAUDE_BIN is deprecated — use --driver (or ALMAGEST_BENCH_DRIVER)."
    if [ -n "$DRIVER_SPEC_FROM_FLAG" ] || [ -n "$DRIVER_SPEC" ]; then
        warn "  a driver was given explicitly — ignoring ALMAGEST_BENCH_CLAUDE_BIN=$ALMAGEST_BENCH_CLAUDE_BIN"
    else
        case "$(basename "$ALMAGEST_BENCH_CLAUDE_BIN")" in
            fake*)
                warn "  mapping it onto --driver fake"
                DRIVER_SPEC="fake" ;;
            *)
                warn "  mapping it onto --driver claude-code with ALM_CLI=$ALMAGEST_BENCH_CLAUDE_BIN"
                DRIVER_SPEC="claude-code"
                case "$ALMAGEST_BENCH_CLAUDE_BIN" in */*) export ALM_CLI="$(abspath "$ALMAGEST_BENCH_CLAUDE_BIN")" ;;
                                                   *)    export ALM_CLI="$ALMAGEST_BENCH_CLAUDE_BIN" ;; esac ;;
        esac
    fi
fi
[ -n "$DRIVER_SPEC_FROM_FLAG" ] && DRIVER_SPEC="$DRIVER_SPEC_FROM_FLAG"
[ -n "$DRIVER_SPEC" ] || DRIVER_SPEC="claude-code"

DRIVER="$(resolve_driver "$DRIVER_SPEC")"
DRIVER_NAME="$(driver_name_of "$DRIVER")"

if [ "$DO_JUDGE" -eq 1 ]; then
    load_capabilities "$DRIVER" "$DRIVER_NAME"

    # The judge's verdict is parsed field by field. Without a schema the driver
    # returns whatever the CLI happened to print, and a prose paragraph parses
    # into zero metrics — or worse, into some of them. Refuse instead.
    if [ "$(cap structured_output)" = "no" ]; then
        SUPPORTING=""
        for d in "$DRIVERS_DIR"/*.sh; do
            [ -x "$d" ] || continue
            if [ "$("$d" capabilities 2>/dev/null | awk -F'\t' '$1=="structured_output" { print $2; exit }')" = "yes" ]; then
                SUPPORTING="$SUPPORTING $(driver_name_of "$d")"
            fi
        done
        die "driver '$DRIVER_NAME' reports structured_output=no — refusing to run the judge.
    The judge pass parses a strict JSON verdict against lib/judge-schema.json. A
    driver that cannot hold its CLI to that schema would produce unparseable
    output or, worse, a partial verdict scored as if it were complete.
    Shipped drivers reporting structured_output=yes here:${SUPPORTING:- none}
    Of the shipped drivers, claude-code enforces it with --json-schema; codex
    does so only on a build with --output-schema, and gemini-cli cannot.
    Either judge with --driver <one of the above>, or drop --judge — the
    mechanical pass is free and always runs."
    fi

    DRIVER_VERSION="$("$DRIVER" version 2>/dev/null | head -1 || true)"
    if [ -z "$DRIVER_VERSION" ]; then
        [ "$DRY_RUN" -eq 1 ] || die "driver '$DRIVER_NAME' could not report a version — is its CLI installed? (or use --dry-run)"
        DRIVER_VERSION="unknown"
    fi
fi

# The question set must be the one the run used, or the ground truth does not
# line up with the answers.
RUN_QSHA="$(sed -n 's/^questions_sha256=//p' "$RUN_DIR/run.env")"
NOW_QSHA="$(file_sha256 "$QUESTIONS")"
if [ -n "$RUN_QSHA" ] && [ "$RUN_QSHA" != "$NOW_QSHA" ] && [ "$NOW_QSHA" != "unavailable" ]; then
    die "question set has changed since this run. Scoring it would compare answers against different ground truth.
    run used: $RUN_QSHA
    on disk:  $NOW_QSHA
    Score this run with the question set it was run against, or re-run."
fi

QTSV="$(mktemp -t almagest-score-q.XXXXXX)"
trap 'rm -f "$QTSV"' EXIT
parse_questions "$QUESTIONS" > "$QTSV" || die "question set failed to parse"

RUN_ARMS=""
for a in $ALL_ARMS; do
    [ -d "$RUN_DIR/$a" ] && RUN_ARMS="$RUN_ARMS $a"
done
[ -n "$RUN_ARMS" ] || die "no arm directories in $RUN_DIR — expected one of: $ALL_ARMS"

IDS="$(sed -n 's/^question_ids=//p' "$RUN_DIR/run.env" | tr ',' '\n' | sed '/^$/d')"
[ -n "$IDS" ] || die "run.env records no question ids"

# Both arms must have come from the same driver, or these numbers compare
# harnesses rather than arms. run.sh will not produce a mixed run; a run
# directory can also be assembled by hand, and a mixed one must not be scored.
RUN_DRIVERS="$(awk -F'\t' '$1=="driver" { print $2 }' "$RUN_DIR"/*/*.meta.tsv 2>/dev/null | sort -u | sed '/^$/d')"
if [ "$(printf '%s\n' "$RUN_DRIVERS" | sed '/^$/d' | wc -l | tr -d ' ')" -gt 1 ]; then
    die "the arms of this run were not produced by the same driver:$(printf '%s\n' "$RUN_DRIVERS" | tr '\n' ' ')
    Both arms of a run must use one driver. A difference between the arms would
    be a difference between harnesses, not a measurement of the wiki.
    Re-run both arms with a single --driver."
fi

# ── corpus facts the mechanical pass checks against ──────────────────────────
# Prefer the manifests run.sh wrote, because they describe the corpus the ARMS
# SAW. At --scale 500, or on a drift arm, that is not fixtures/raw — and scoring
# a citation of a document that really was in the arena as "fabricated" would be
# a metric that errs in this project's own favour.
if [ -s "$RUN_DIR/corpus.files" ] && [ -s "$RUN_DIR/corpus.docids" ]; then
    KNOWN_FILES="$(tr '\n' ' ' < "$RUN_DIR/corpus.files")"
    KNOWN_DOCS="$(tr '\n' ' ' < "$RUN_DIR/corpus.docids")"
    CORPUS_SOURCE="run manifest"
else
    KNOWN_FILES="$(corpus_files "$FIXTURES_DIR/raw" | tr '\n' ' ')"
    KNOWN_DOCS="$(corpus_docids "$FIXTURES_DIR/raw" | tr '\n' ' ')"
    CORPUS_SOURCE="fixtures/raw (run predates corpus manifests)"
fi
KNOWN_PAGES="$(cd "$FIXTURES_DIR/wiki" && ls -1 *.md | sed 's/\.md$//' | tr '\n' ' ')"
[ -n "$(printf '%s' "$KNOWN_DOCS" | tr -d ' ')" ] || \
    die "could not extract any document IDs for this run — the mechanical citation check would be vacuous"

# filename → document ID, so expected_sources can be matched by either form
docid_for() {
    awk -v f="$1" '/^\*\*(Document ID|Agreement reference):\*\*/ && FILENAME ~ f {
        sub(/^[^:]*:\*\*[ \t]*/, ""); gsub(/[ \t\r]/, ""); print; exit }' "$FIXTURES_DIR"/raw/*.md
}

rule
info "${C_BLD}Scoring $RUN_DIR${C_OFF}"
info "  arms:      $(printf '%s' "$RUN_ARMS" | sed 's/^ //')"
info "  questions: $(printf '%s\n' "$IDS" | wc -l | tr -d ' ')"
info "  corpus:    $(printf '%s' "$KNOWN_DOCS" | wc -w | tr -d ' ') document ids, $(printf '%s' "$KNOWN_PAGES" | wc -w | tr -d ' ') wiki pages — from $CORPUS_SOURCE"
rule

# ── pass 1: mechanical ───────────────────────────────────────────────────────
MECH="$RUN_DIR/scores-mechanical.tsv"
{
    printf 'arm\tquestion_id\tcategory\tmetric\tvalue\n'
} > "$MECH"

SCORED=0
MISSING=0

for arm in $RUN_ARMS; do
    while IFS= read -r qid; do
        [ -n "$qid" ] || continue
        ANS="$RUN_DIR/$arm/$qid.answer.md"
        META="$RUN_DIR/$arm/$qid.meta.tsv"
        CATEGORY="$(qfield1 "$QTSV" "$qid" category)"

        if [ ! -s "$ANS" ]; then
            warn "missing or empty answer: $arm/$qid — recorded as unscorable"
            printf '%s\t%s\t%s\tstatus\tunscorable\n' "$arm" "$qid" "$CATEGORY" >> "$MECH"
            MISSING=$((MISSING + 1))
            continue
        fi

        EXP_SOURCES="$(qfield "$QTSV" "$qid" expected_sources | tr '\n' ' ')"
        EXP_DOCS=""
        for f in $EXP_SOURCES; do EXP_DOCS="$EXP_DOCS $(docid_for "$f")"; done

        awk -v known_docs="$KNOWN_DOCS" \
            -v known_files="$KNOWN_FILES" \
            -v known_pages="$KNOWN_PAGES" \
            -v exp_sources="$EXP_SOURCES" \
            -v exp_docs="$EXP_DOCS" \
            -v docid_re="$DOCID_RE" \
            -f "$LIB_DIR/mechanical.awk" "$ANS" \
        | awk -F'\t' -v a="$arm" -v q="$qid" -v c="$CATEGORY" \
              '{ printf("%s\t%s\t%s\t%s\t%s\n", a, q, c, $1, $2) }' >> "$MECH"

        # ground-truth literals — a recall floor, not a correctness test
        hit=0; tot=0
        while IFS= read -r s; do
            [ -n "$s" ] || continue
            tot=$((tot + 1))
            grep -qiF -- "$s" "$ANS" && hit=$((hit + 1)) || true
        done <<EOF2
$(qfield "$QTSV" "$qid" must_contain)
EOF2
        printf '%s\t%s\t%s\tmust_contain_total\t%d\n' "$arm" "$qid" "$CATEGORY" "$tot" >> "$MECH"
        printf '%s\t%s\t%s\tmust_contain_hits\t%d\n'  "$arm" "$qid" "$CATEGORY" "$hit" >> "$MECH"

        bad=0
        while IFS= read -r s; do
            [ -n "$s" ] || continue
            grep -qiF -- "$s" "$ANS" && bad=$((bad + 1)) || true
        done <<EOF3
$(qfield "$QTSV" "$qid" must_not_contain)
EOF3
        printf '%s\t%s\t%s\tmust_not_contain_hits\t%d\n' "$arm" "$qid" "$CATEGORY" "$bad" >> "$MECH"

        # ── poisoned-claim literals — ADVISORY PROXY ONLY ────────────────────
        # `poison_false` is the value a compiled page asserts and the source
        # contradicts. Its presence in an answer is NOT propagation: an answer
        # that says "the page claims 4.6 m but the source says 3.9 m" contains
        # both literals and is the best possible answer. These two numbers only
        # narrow down which answers are worth reading. The judge decides, via
        # `compiled_error`. Nothing in the report aggregates them into a rate.
        PT="$(qfield1 "$QTSV" "$qid" poison_true)"
        PF="$(qfield1 "$QTSV" "$qid" poison_false)"
        if [ -n "$PT" ]; then
            grep -qiF -- "$PT" "$ANS" && v=1 || v=0
            printf '%s\t%s\t%s\tpoison_true_present\t%d\n' "$arm" "$qid" "$CATEGORY" "$v" >> "$MECH"
        fi
        if [ -n "$PF" ]; then
            grep -qiF -- "$PF" "$ANS" && v=1 || v=0
            printf '%s\t%s\t%s\tpoison_false_present\t%d\n' "$arm" "$qid" "$CATEGORY" "$v" >> "$MECH"
        fi

        if [ -f "$META" ]; then
            awk -F'\t' -v a="$arm" -v q="$qid" -v c="$CATEGORY" \
                '$1=="latency_ms" || $1=="cost_usd" || $1=="num_turns" || $1=="status" \
                 { printf("%s\t%s\t%s\t%s\t%s\n", a, q, c, $1, $2) }' "$META" >> "$MECH"
        fi
        SCORED=$((SCORED + 1))
    done <<EOF4
$IDS
EOF4
done

ok "mechanical pass: $SCORED answer(s) scored, $MISSING unscorable → ${MECH#$REPO_DIR/}"

# ── pass 2: judge ────────────────────────────────────────────────────────────
JUDGE="$RUN_DIR/scores-judge.tsv"
JUDGE_RAN=0

if [ "$DO_JUDGE" -eq 1 ]; then
    NJ=$((SCORED))
    rule
    info "${C_BLD}The judge pass will make $NJ agent call(s) and cost real money.${C_OFF}"
    info "  judge driver: $DRIVER_NAME ($DRIVER_VERSION)"
    info "  judge model:  $JUDGE_MODEL"
    info "  per-call cap: \$$BUDGET_USD"
    [ "$(cap budget_cap)" = "no" ] && warn "  driver '$DRIVER_NAME' cannot enforce that cap — judge spend is UNCAPPED"
    rule

    if [ "$DRY_RUN" -eq 1 ]; then
        warn "DRY RUN — no judge calls will be made."
    elif [ "$ASSUME_YES" -eq 0 ]; then
        if [ -t 0 ]; then
            printf '%s' "👉 Proceed with the judge pass? [y/N] " >&2
            read -r reply
        else
            die "not a terminal and --yes not given — refusing to spend money unattended"
        fi
        case "$reply" in y|Y|yes|YES) : ;; *) die "aborted by user" ;; esac
    fi

    [ -f "$LIB_DIR/judge-schema.json" ] || die "missing lib/judge-schema.json"
    JUDGE_SYS="$(cat "$PROMPTS_DIR/judge.md")"

    if [ "$DRY_RUN" -eq 0 ]; then
        printf 'arm\tquestion_id\tcategory\tmetric\tvalue\n' > "$JUDGE"
    fi
    JFAIL=0

    for arm in $RUN_ARMS; do
        while IFS= read -r qid; do
            [ -n "$qid" ] || continue
            ANS="$RUN_DIR/$arm/$qid.answer.md"
            [ -s "$ANS" ] || continue
            CATEGORY="$(qfield1 "$QTSV" "$qid" category)"

            # Blind: the judge is never told which arm produced the answer.
            PAYLOAD="$(printf 'QUESTION\n%s\n\nCATEGORY\n%s\n\nGROUND TRUTH\n%s\n\nANSWER TO SCORE\n<<<ANSWER\n%s\nANSWER>>>\n' \
                       "$(qfield1 "$QTSV" "$qid" question)" \
                       "$CATEGORY" \
                       "$(qfield1 "$QTSV" "$qid" ground_truth)" \
                       "$(cat "$ANS")")"

            info "  judging $arm/$qid ($CATEGORY)"
            if [ "$DRY_RUN" -eq 1 ]; then
                dim "        ALM_PROMPT=<payload $(printf '%s' "$PAYLOAD" | wc -c | tr -d ' ') bytes> ALM_MODEL=$JUDGE_MODEL \\"
                dim "          ALM_TOOLS='' ALM_SCHEMA_FILE=lib/judge-schema.json ${DRIVER#$REPO_DIR/} run"
                continue
            fi

            JRAW="$RUN_DIR/$arm/$qid.judge.json"
            set +e
            ALM_PROMPT="$PAYLOAD" \
            ALM_SYSTEM="$JUDGE_SYS" \
            ALM_MODEL="$JUDGE_MODEL" \
            ALM_TOOLS="" \
            ALM_BUDGET_USD="$BUDGET_USD" \
            ALM_SCHEMA_FILE="$LIB_DIR/judge-schema.json" \
                "$DRIVER" run \
                < /dev/null > "$JRAW" 2> "$RUN_DIR/$arm/$qid.judge.stderr.log"
            rc=$?
            set -e
            if [ "$rc" -ne 0 ]; then
                warn "        judge exited $rc — see $RUN_DIR/$arm/$qid.judge.stderr.log"
                JFAIL=$((JFAIL + 1)); continue
            fi

            VERDICT="$RUN_DIR/$arm/$qid.judge.verdict.json"
            if ! awk -v raw=result -f "$LIB_DIR/json_scalar.awk" "$JRAW" > "$VERDICT" 2>/dev/null; then
                warn "        judge returned no result field"; JFAIL=$((JFAIL + 1)); continue
            fi
            if ! awk -f "$LIB_DIR/json_scalar.awk" "$VERDICT" > /dev/null 2>&1; then
                warn "        judge verdict is not a JSON object — see $VERDICT"; JFAIL=$((JFAIL + 1)); continue
            fi
            awk -f "$LIB_DIR/json_scalar.awk" "$VERDICT" \
            | awk -F'\t' -v a="$arm" -v q="$qid" -v c="$CATEGORY" \
                  '{ printf("%s\t%s\t%s\tjudge_%s\t%s\n", a, q, c, $1, $2) }' >> "$JUDGE"
        done <<EOF5
$IDS
EOF5
    done

    if [ "$DRY_RUN" -eq 0 ]; then
        if [ "$JFAIL" -gt 0 ]; then
            warn "judge pass had $JFAIL failure(s) — judge-scored metrics in the report are INCOMPLETE"
        else
            ok "judge pass complete → ${JUDGE#$REPO_DIR/}"
        fi
        JUDGE_RAN=1
    fi
fi

# ── report ───────────────────────────────────────────────────────────────────
REPORT="$RUN_DIR/report.md"
[ "$DRY_RUN" -eq 1 ] && { info "dry run — no report written"; exit 0; }

"$LIB_DIR/../lib/render_report.sh" "$RUN_DIR" "$MECH" "$JUDGE" "$JUDGE_RAN" "$QTSV" > "$REPORT"

rule
ok "report written → ${REPORT#$REPO_DIR/}"
[ "$JUDGE_RAN" -eq 1 ] || warn "judge-scored metrics were NOT run. The report marks them 'not run'. Do not fill them in by hand."
rule
