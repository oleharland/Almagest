#!/usr/bin/env bash
#
# benchmarks/run.sh — run the Almagest benchmark: baseline vs treatment.
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  THIS SCRIPT SPENDS REAL MONEY.                                          │
# │  Every question is sent to the Claude API twice (once per arm). Scoring   │
# │  with --judge in score.sh sends each answer once more. Cost scales with   │
# │  question count x arms x model. Use --dry-run first — it costs nothing.   │
# └──────────────────────────────────────────────────────────────────────────┘
#
# It reads and writes ONLY inside benchmarks/. It never touches brain/, and the
# arena directories it builds are copies of benchmarks/fixtures/, so a real
# knowledge base is never in scope for either arm.
#
# Dependencies: bash, awk, sed, find, cp — and the `claude` CLI. Nothing to
# install. No language runtime, no package manager.

set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

# ── defaults ─────────────────────────────────────────────────────────────────
ARM="both"
MODEL="sonnet"
QUESTIONS="$DEFAULT_QUESTIONS"
RESULTS_DIR="$DEFAULT_RESULTS_DIR"
LABEL=""
ONLY=""
BUDGET_USD="1.00"
DRY_RUN=0
ASSUME_YES=0
FORCE=0
DRIFT_DETECTED=0

# Testing hook. Point this at a stub that emits a `claude -p --output-format json`
# shaped payload to exercise the whole harness — arena build, capture, metadata,
# failure paths — without making a single API call. Used by benchmarks/selftest.sh.
CLAUDE_BIN="${ALMAGEST_BENCH_CLAUDE_BIN:-claude}"
# The arms run with the arena as cwd, so a path-qualified binary must be absolute.
case "$CLAUDE_BIN" in */*) CLAUDE_BIN="$(abspath "$CLAUDE_BIN")" ;; esac

usage() {
    cat <<'USAGE'
Usage: benchmarks/run.sh [options]

  --arm baseline|treatment|both   Which arm(s) to run          (default: both)
  --model NAME                    Model for the answering agent (default: sonnet)
  --questions FILE                Question set                 (default: benchmarks/questions.yaml)
  --only q01,q05                  Run just these question ids
  --label NAME                    Prefix for the run directory
  --out DIR                       Results root                 (default: benchmarks/results)
  --budget-usd N                  Per-call spend cap           (default: 1.00)
  --dry-run                       Print what would run. Calls nothing. Costs nothing.
  --yes                           Skip the cost confirmation prompt
  --force                         Overwrite an existing run directory
  -h, --help                      This

Cost: two API calls per question with --arm both. Start with
  benchmarks/run.sh --dry-run
then
  benchmarks/run.sh --only q01 --arm both
before committing to a full run.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --arm)        ARM="${2:?--arm needs a value}"; shift 2 ;;
        --model)      MODEL="${2:?--model needs a value}"; shift 2 ;;
        --questions)  QUESTIONS="${2:?--questions needs a value}"; shift 2 ;;
        --only)       ONLY="${2:?--only needs a value}"; shift 2 ;;
        --label)      LABEL="${2:?--label needs a value}"; shift 2 ;;
        --out)        RESULTS_DIR="${2:?--out needs a value}"; shift 2 ;;
        --budget-usd) BUDGET_USD="${2:?--budget-usd needs a value}"; shift 2 ;;
        --dry-run)    DRY_RUN=1; shift ;;
        --yes|-y)     ASSUME_YES=1; shift ;;
        --force)      FORCE=1; shift ;;
        -h|--help)    usage; exit 0 ;;
        *)            usage >&2; die "unknown argument: $1" ;;
    esac
done

RESULTS_DIR="$(abspath "$RESULTS_DIR")"

case "$ARM" in
    baseline|treatment|both) : ;;
    *) die "--arm must be baseline, treatment, or both (got: $ARM)" ;;
esac

# ── preflight — fail loudly, before spending anything ────────────────────────
rule
info "${C_BLD}Almagest benchmark — preflight${C_OFF}"
rule

need_cmd awk
need_cmd sed
need_cmd find
[ "$DRY_RUN" -eq 1 ] || need_cmd "$CLAUDE_BIN" "install Claude Code, or use --dry-run"
[ "$CLAUDE_BIN" = "claude" ] || warn "using stub binary $CLAUDE_BIN — results are NOT real model output"

[ -f "$QUESTIONS" ] || die "question set not found: $QUESTIONS"
[ -f "$PROMPTS_DIR/_shared.md" ]    || die "missing prompts/_shared.md"
[ -f "$PROMPTS_DIR/baseline.md" ]   || die "missing prompts/baseline.md"
[ -f "$PROMPTS_DIR/treatment.md" ]  || die "missing prompts/treatment.md"

check_fixtures
ok "fixtures present ($(find "$FIXTURES_DIR/raw" -name '*.md' | wc -l | tr -d ' ') sources, $(find "$FIXTURES_DIR/wiki" -name '*.md' | wc -l | tr -d ' ') wiki pages)"

check_protocol_drift
[ "$DRIFT_DETECTED" -eq 0 ] && ok "query protocol in sync with brain/CLAUDE.md"

QTSV="$(mktemp -t almagest-bench-q.XXXXXX)"
trap 'rm -f "$QTSV"' EXIT
parse_questions "$QUESTIONS" > "$QTSV" || die "question set failed to parse — fix $QUESTIONS and retry"

# Ordered id list, filtered by --only
ALL_IDS="$(awk -F'\t' '$2=="id" { print $3 }' "$QTSV")"
if [ -n "$ONLY" ]; then
    SEL=""
    IFS=','
    for want in $ONLY; do
        want="$(printf '%s' "$want" | tr -d ' ')"
        printf '%s\n' "$ALL_IDS" | grep -qx "$want" || { unset IFS; die "--only names a question id that is not in $QUESTIONS: $want"; }
        SEL="$SEL$want
"
    done
    unset IFS
    IDS="$(printf '%s' "$SEL" | sed '/^$/d')"
else
    IDS="$ALL_IDS"
fi
NQ="$(printf '%s\n' "$IDS" | sed '/^$/d' | wc -l | tr -d ' ')"
[ "$NQ" -gt 0 ] || die "no questions selected"
ok "$NQ question(s) selected"

case "$ARM" in
    both) ARMS="baseline treatment"; NCALLS=$((NQ * 2)) ;;
    *)    ARMS="$ARM";               NCALLS="$NQ" ;;
esac

# ── run directory ────────────────────────────────────────────────────────────
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_ID="${LABEL:+$LABEL-}$STAMP"
RUN_DIR="$RESULTS_DIR/$RUN_ID"
assert_inside_benchmarks "$RUN_DIR"
if [ -e "$RUN_DIR" ] && [ "$FORCE" -eq 0 ]; then
    die "run directory already exists: $RUN_DIR (use --force to overwrite)"
fi

# ── cost gate ────────────────────────────────────────────────────────────────
rule
info "${C_BLD}This run will make ${NCALLS} Claude API call(s) and cost real money.${C_OFF}"
info "  model:        $MODEL"
info "  arms:         $ARM"
info "  questions:    $NQ"
info "  per-call cap: \$$BUDGET_USD"
info "  output:       $RUN_DIR"
rule

if [ "$DRY_RUN" -eq 1 ]; then
    warn "DRY RUN — no API calls will be made, nothing will be written."
elif [ "$ASSUME_YES" -eq 0 ]; then
    if [ -t 0 ]; then
        printf '%s' "👉 Proceed? [y/N] " >&2
        read -r reply
    else
        die "not a terminal and --yes not given — refusing to spend money unattended"
    fi
    case "$reply" in y|Y|yes|YES) : ;; *) die "aborted by user" ;; esac
fi

# ── build the arena ──────────────────────────────────────────────────────────
# Each arm runs with its arena directory as cwd, holding only what that arm is
# allowed to see. Copies, never symlinks into fixtures/, so a run can never
# mutate the corpus.
build_arena() {
    local arm="$1" dir="$RUN_DIR/arena/$arm"
    assert_inside_benchmarks "$dir"
    [ "$DRY_RUN" -eq 1 ] && { echo "$dir"; return; }
    rm -rf "$dir"
    mkdir -p "$dir/sources"
    cp "$FIXTURES_DIR"/raw/*.md "$dir/sources/"
    if [ "$arm" = "treatment" ]; then
        mkdir -p "$dir/wiki"
        cp "$FIXTURES_DIR"/wiki/*.md "$dir/wiki/"
    fi
    echo "$dir"
}

system_prompt_for() {
    cat "$PROMPTS_DIR/_shared.md"
    printf '\n\n'
    cat "$PROMPTS_DIR/$1.md"
}

# ── run ──────────────────────────────────────────────────────────────────────
if [ "$DRY_RUN" -eq 0 ]; then
    mkdir -p "$RUN_DIR"
    {
        echo "run_id=$RUN_ID"
        echo "date_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "model=$MODEL"
        echo "arms=$ARM"
        echo "questions_file=$QUESTIONS"
        echo "questions_sha256=$(file_sha256 "$QUESTIONS")"
        echo "questions_count=$NQ"
        echo "question_ids=$(printf '%s' "$IDS" | tr '\n' ',' | sed 's/,$//')"
        echo "shared_prompt_sha256=$(file_sha256 "$PROMPTS_DIR/_shared.md")"
        echo "protocol_drift=$DRIFT_DETECTED"
        echo "budget_usd_per_call=$BUDGET_USD"
        echo "claude_bin=$CLAUDE_BIN"
        echo "claude_version=$("$CLAUDE_BIN" --version 2>/dev/null | head -1 || echo unknown)"
        echo "git_sha=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
        echo "git_dirty=$(test -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" && echo yes || echo no)"
        echo "harness_version=1"
    } > "$RUN_DIR/run.env"
fi

FAILURES=0
COMPLETED=0

for arm in $ARMS; do
    ARENA="$(build_arena "$arm")"
    SYS="$(system_prompt_for "$arm")"
    OUT="$RUN_DIR/$arm"
    [ "$DRY_RUN" -eq 1 ] || mkdir -p "$OUT"

    rule
    info "${C_BLD}Arm: $arm${C_OFF}   arena: ${ARENA#$REPO_DIR/}"
    rule

    i=0
    while IFS= read -r qid; do
        [ -n "$qid" ] || continue
        i=$((i + 1))
        QUESTION="$(qfield1 "$QTSV" "$qid" question)"
        CATEGORY="$(qfield1 "$QTSV" "$qid" category)"
        [ -n "$QUESTION" ] || die "question '$qid' has no question text"

        info "  [$i/$NQ] $qid ($CATEGORY)"

        if [ "$DRY_RUN" -eq 1 ]; then
            dim "        cd $ARENA && $CLAUDE_BIN -p <question> --safe-mode --model $MODEL \\"
            dim "          --output-format json --tools Read,Grep,Glob --no-session-persistence \\"
            dim "          --append-system-prompt <${arm} protocol, $(printf '%s' "$SYS" | wc -c | tr -d ' ') bytes> \\"
            dim "          --max-budget-usd $BUDGET_USD"
            dim "        → $OUT/$qid.answer.md"
            continue
        fi

        RAW="$OUT/$qid.raw.json"
        ANS="$OUT/$qid.answer.md"
        META="$OUT/$qid.meta.tsv"

        t0="$(date +%s)"
        set +e
        ( cd "$ARENA" && "$CLAUDE_BIN" -p "$QUESTION" \
              --safe-mode \
              --model "$MODEL" \
              --output-format json \
              --tools "Read,Grep,Glob" \
              --allowedTools "Read,Grep,Glob" \
              --no-session-persistence \
              --append-system-prompt "$SYS" \
              --max-budget-usd "$BUDGET_USD" \
        # stdin is /dev/null so the CLI cannot swallow the question-id list this
        # loop is reading from. Classic shell bug; it silently truncates a run.
        ) < /dev/null > "$RAW" 2> "$OUT/$qid.stderr.log"
        rc=$?
        set -e
        t1="$(date +%s)"
        wall_ms=$(( (t1 - t0) * 1000 ))

        if [ "$rc" -ne 0 ]; then
            warn "        claude exited $rc — see $OUT/$qid.stderr.log"
            FAILURES=$((FAILURES + 1))
            printf 'status\tfailed\nexit_code\t%s\nwall_ms\t%s\n' "$rc" "$wall_ms" > "$META"
            : > "$ANS"
            continue
        fi

        if ! awk -v raw=result -f "$LIB_DIR/json_scalar.awk" "$RAW" > "$ANS" 2>/dev/null; then
            warn "        no 'result' field in the response — see $RAW"
            FAILURES=$((FAILURES + 1))
            printf 'status\tmalformed\nwall_ms\t%s\n' "$wall_ms" > "$META"
            : > "$ANS"
            continue
        fi

        if [ ! -s "$ANS" ] || ! grep -q '[^[:space:]]' "$ANS"; then
            warn "        empty answer — scoring an empty answer would be meaningless"
            FAILURES=$((FAILURES + 1))
            printf 'status\tempty\nwall_ms\t%s\n' "$wall_ms" > "$META"
            continue
        fi

        FIELDS="$(awk -f "$LIB_DIR/json_scalar.awk" "$RAW")"
        get() { printf '%s\n' "$FIELDS" | awk -F'\t' -v k="$1" '$1==k { print $2; exit }'; }

        dur="$(get duration_ms)"
        if [ -n "$dur" ]; then lat="$dur"; latsrc="claude_duration_ms"
        else                   lat="$wall_ms"; latsrc="wall_clock_s"; fi

        {
            printf 'status\tok\n'
            printf 'arm\t%s\n'            "$arm"
            printf 'question_id\t%s\n'    "$qid"
            printf 'category\t%s\n'       "$CATEGORY"
            printf 'model\t%s\n'          "$MODEL"
            printf 'latency_ms\t%s\n'     "$lat"
            printf 'latency_source\t%s\n' "$latsrc"
            printf 'wall_ms\t%s\n'        "$wall_ms"
            printf 'cost_usd\t%s\n'       "$(get total_cost_usd)"
            printf 'num_turns\t%s\n'      "$(get num_turns)"
            printf 'is_error\t%s\n'       "$(get is_error)"
            printf 'subtype\t%s\n'        "$(get subtype)"
            printf 'session_id\t%s\n'     "$(get session_id)"
            printf 'answer_bytes\t%s\n'   "$(wc -c < "$ANS" | tr -d ' ')"
        } > "$META"

        if [ "$(get is_error)" = "true" ]; then
            warn "        model reported is_error=true"
            FAILURES=$((FAILURES + 1))
        else
            COMPLETED=$((COMPLETED + 1))
            dim "        ${lat} ms · \$$(get total_cost_usd) · $(wc -c < "$ANS" | tr -d ' ') bytes"
        fi
    done <<EOF
$IDS
EOF
done

# ── summary ──────────────────────────────────────────────────────────────────
rule
if [ "$DRY_RUN" -eq 1 ]; then
    info "${C_BLD}Dry run complete.${C_OFF} $NCALLS call(s) would have been made. Nothing was spent."
    exit 0
fi

info "${C_BLD}Run complete${C_OFF} — $RUN_DIR"
info "  answers captured: $COMPLETED / $NCALLS"
info "  failures:         $FAILURES"
rule

if [ "$FAILURES" -gt 0 ]; then
    warn "This run is incomplete. Do not report numbers from it."
    warn "Fix the failures above and re-run before scoring."
    exit 1
fi

info "Next: benchmarks/score.sh --run $RUN_ID"
info "      (add --judge for the LLM-scored metrics — that costs more tokens)"
