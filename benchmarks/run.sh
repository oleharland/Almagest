#!/usr/bin/env bash
#
# benchmarks/run.sh — run the Almagest benchmark: baseline vs treatment.
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  THIS SCRIPT SPENDS REAL MONEY.                                          │
# │  Every question is put to the agent CLI once PER ARM. Scoring with       │
# │  --judge in score.sh sends each answer once more. Cost scales with        │
# │  question count x arms x model, and --scale raises the tokens per call.   │
# │  Use --dry-run first — it costs nothing.                                  │
# └──────────────────────────────────────────────────────────────────────────┘
#
# It reads and writes ONLY inside benchmarks/. It never touches brain/, and the
# arena directories it builds are copies of benchmarks/fixtures/, so a real
# knowledge base is never in scope for any arm.
#
# It does not know how to talk to an agent: a driver does. One script per
# harness in benchmarks/drivers/, picked with --driver. Interface and rules for
# writing your own: benchmarks/drivers/README.md.
#
# Dependencies: bash, awk, sed, find, cp — and the CLI of whichever driver you
# run. Nothing to install. No language runtime, no package manager.

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
SCALE=""
SCALE_SEED=1

# Which harness answers the questions. --driver wins over the environment; both
# win over the default. `fake` is the test double used by benchmarks/selftest.sh:
# it exercises every non-API path — arena build, capture, metadata, failure
# branches — without making a single API call.
DRIVER_SPEC="${ALMAGEST_BENCH_DRIVER:-}"
DRIVER_SPEC_FROM_FLAG=""

usage() {
    cat <<'USAGE'
Usage: benchmarks/run.sh [options]

  --arm LIST                      Which arm(s) to run          (default: both)
                                  A comma list of arm names, or a group:
                                    both  baseline,treatment      (the original pair)
                                    all   baseline,baseline-retrieval,treatment,poisoned
                                  Arms:
                                    baseline            raw sources only
                                    baseline-retrieval  raw sources, told to search
                                    treatment           raw sources + gold wiki
                                    poisoned            raw sources + wiki with planted errors
                                    drift-baseline      amended sources only
                                    drift               amended sources + wiki compiled from
                                                        the pre-amendment ones
                                  The drift arms need --questions questions-drift.yaml.
  --driver NAME|PATH              Harness driver               (default: claude-code)
                                  NAME resolves in benchmarks/drivers/.
                                  Env: ALMAGEST_BENCH_DRIVER
  --model NAME                    Model for the answering agent (default: sonnet)
  --questions FILE                Question set                 (default: benchmarks/questions.yaml)
  --scale N                       Corpus size in documents     (default: 5, the real sources)
                                  Shipped tiers 5 / 50 / 500. Above 5 the corpus is
                                  padded with generated distractors that answer nothing.
                                  That measures RETRIEVAL PRESSURE, not domain breadth —
                                  see fixtures/scale/generate.sh before quoting it.
  --scale-seed N                  Seed for the padding         (default: 1)
                                  Same seed + same --scale = byte-identical corpus.
  --only q01,q05                  Run just these question ids
  --label NAME                    Prefix for the run directory
  --out DIR                       Results root                 (default: benchmarks/results)
  --budget-usd N                  Per-call spend cap           (default: 1.00)
  --dry-run                       Print what would run. Calls nothing. Costs nothing.
  --yes                           Skip the cost confirmation prompt
  --force                         Overwrite an existing run directory
  -h, --help                      This

Cost: one API call per question PER ARM. --arm all is four times --arm one.
Start with
  benchmarks/run.sh --dry-run
then
  benchmarks/run.sh --only q01 --arm both
before committing to a full run.
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --arm)        ARM="${2:?--arm needs a value}"; shift 2 ;;
        --driver)     DRIVER_SPEC_FROM_FLAG="${2:?--driver needs a value}"; shift 2 ;;
        --model)      MODEL="${2:?--model needs a value}"; shift 2 ;;
        --questions)  QUESTIONS="${2:?--questions needs a value}"; shift 2 ;;
        --scale)      SCALE="${2:?--scale needs a value}"; shift 2 ;;
        --scale-seed) SCALE_SEED="${2:?--scale-seed needs a value}"; shift 2 ;;
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

ARMS="$(expand_arms "$ARM")"

case "${SCALE:-5}" in
    ''|*[!0-9]*) die "--scale must be a positive integer (got: $SCALE)" ;;
esac
case "$SCALE_SEED" in
    ''|*[!0-9]*) die "--scale-seed must be a non-negative integer (got: $SCALE_SEED)" ;;
esac

# ── preflight — fail loudly, before spending anything ────────────────────────
rule
info "${C_BLD}Almagest benchmark — preflight${C_OFF}"
rule

need_cmd awk
need_cmd sed
need_cmd find

# Deprecated hook, kept working because it was the documented way to point the
# harness at a stub. It names a binary; drivers name a harness, so map it.
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
load_capabilities "$DRIVER" "$DRIVER_NAME"
DRIVER_VERSION="$("$DRIVER" version 2>/dev/null | head -1 || true)"
if [ -z "$DRIVER_VERSION" ]; then
    [ "$DRY_RUN" -eq 1 ] || die "driver '$DRIVER_NAME' could not report a version — is its CLI installed? (or use --dry-run)"
    DRIVER_VERSION="unknown"
fi
ok "driver $DRIVER_NAME — $DRIVER_VERSION"
dim "        $(printf '%s\n' "$CAPS" | awk -F'\t' '{ printf "%s=%s ", $1, $2 }')"
[ "$DRIVER_NAME" = "fake" ] && warn "using the fake driver — results are NOT real model output"

[ -f "$QUESTIONS" ] || die "question set not found: $QUESTIONS"
[ -f "$PROMPTS_DIR/_shared.md" ]    || die "missing prompts/_shared.md"
[ -f "$PROMPTS_DIR/baseline.md" ]   || die "missing prompts/baseline.md"
[ -f "$PROMPTS_DIR/treatment.md" ]  || die "missing prompts/treatment.md"

check_fixtures

# Only the trees the selected arms actually need. An arm asking for a fixture
# that is not there must stop the run, not fall back to a different one.
NEED_DRIFT=0
for arm in $ARMS; do
    [ -f "$PROMPTS_DIR/$(arm_prompt "$arm").md" ] || die "missing prompts/$(arm_prompt "$arm").md, needed by arm '$arm'"
    w="$(arm_wiki "$arm")"
    [ -n "$w" ] && check_fixture_wiki "$w"
    arm_is_drift "$arm" && NEED_DRIFT=1
done
[ "$NEED_DRIFT" -eq 1 ] && check_fixture_drift
ok "fixtures present ($(find "$FIXTURES_DIR/raw" -name '*.md' | wc -l | tr -d ' ') sources, $(find "$FIXTURES_DIR/wiki" -name '*.md' | wc -l | tr -d ' ') wiki pages)"
ok "arms: $ARMS"

check_protocol_drift
[ "$DRIFT_DETECTED" -eq 0 ] && ok "query protocol in sync with $PROTOCOL_NAME"

QTSV="$(mktemp -t almagest-bench-q.XXXXXX)"
trap 'rm -f "$QTSV"' EXIT
parse_questions "$QUESTIONS" > "$QTSV" || die "question set failed to parse — fix $QUESTIONS and retry"

# ── drift arms and the drift question set are a matched pair ─────────────────
# The drift arms see an AMENDED source, so the same question has a different
# correct answer than it does in the main set. Scoring a drift arm against the
# main ground truth, or a main arm against the drift ground truth, produces
# numbers that look fine and mean nothing. Refuse both.
NDRIFT_Q="$(awk -F'\t' '$2=="category" && $3 ~ /^drift/' "$QTSV" | wc -l | tr -d ' ')"
NALL_Q="$(awk -F'\t' '$2=="category"' "$QTSV" | wc -l | tr -d ' ')"
if [ "$NEED_DRIFT" -eq 1 ] && [ "$NDRIFT_Q" -ne "$NALL_Q" ]; then
    die "a drift arm was selected but $QUESTIONS is not a drift-only question set
    ($NDRIFT_Q of $NALL_Q questions carry a drift* category).
    The drift arms answer from an amended source; the main question set's ground
    truth describes the corpus before the amendment. Run:
      benchmarks/run.sh --questions benchmarks/questions-drift.yaml --arm drift,drift-baseline"
fi
if [ "$NEED_DRIFT" -eq 0 ] && [ "$NDRIFT_Q" -gt 0 ]; then
    die "$QUESTIONS contains drift* questions but no drift arm was selected.
    Their ground truth describes the amended corpus, which the arms '$ARMS' will
    not be given. Use --arm drift,drift-baseline."
fi

# Ordered id list, filtered by --only
ALL_IDS="$(awk -F'\t' '$2=="id" { print $3 }' "$QTSV")"
if [ -n "$ONLY" ]; then
    SEL=""
    IFS=','
    for want in $ONLY; do
        want="$(printf '%s' "$want" | tr -d ' ')"
        printf '%s\n' "$ALL_IDS" | grep -x "$want" >/dev/null || { unset IFS; die "--only names a question id that is not in $QUESTIONS: $want"; }
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

NARMS="$(printf '%s\n' $ARMS | wc -l | tr -d ' ')"
NCALLS=$((NQ * NARMS))

# ── run directory ────────────────────────────────────────────────────────────
STAMP="$(date +%Y%m%d-%H%M%S)"
RUN_ID="${LABEL:+$LABEL-}$STAMP"
RUN_DIR="$RESULTS_DIR/$RUN_ID"
assert_inside_benchmarks "$RUN_DIR"
if [ -e "$RUN_DIR" ] && [ "$FORCE" -eq 0 ]; then
    die "run directory already exists: $RUN_DIR (use --force to overwrite)"
fi

# Both arms of a run must come from the same driver. Baseline on one harness and
# treatment on another measures the harness, not the wiki — and --force makes
# that mistake reachable by re-running one arm into an existing run directory.
if [ -f "$RUN_DIR/run.env" ]; then
    PREV_DRIVER="$(sed -n 's/^driver=//p' "$RUN_DIR/run.env" | head -1)"
    if [ -n "$PREV_DRIVER" ] && [ "$PREV_DRIVER" != "$DRIVER_NAME" ]; then
        die "this run directory was produced by driver '$PREV_DRIVER', not '$DRIVER_NAME'.
    Both arms of a run must use the same driver, or the comparison is between
    harnesses rather than between arms.
    Use a new --label, or re-run both arms with --driver $PREV_DRIVER."
    fi
fi

# ── comparability guard ──────────────────────────────────────────────────────
# A capability the driver cannot enforce is a fact about the run, recorded in
# run.env and repeated in the report. Two of them change what the numbers mean
# badly enough to say so here, before anything is spent.
if [ "$(cap tool_restriction)" = "no" ]; then
    rule
    warn "${C_BLD}Driver '$DRIVER_NAME' cannot enforce the read-only tool allowlist.${C_OFF}"
    warn "  The arms will not be confined to Read/Grep/Glob. Nothing stops one from"
    warn "  reaching material the other cannot see, and the single variable this"
    warn "  design rests on stops being single."
    warn "  This run is NOT comparable to a run whose driver enforced it."
    rule
fi
if [ "$(cap budget_cap)" = "no" ] && [ "$DRY_RUN" -eq 0 ]; then
    rule
    warn "${C_BLD}Driver '$DRIVER_NAME' cannot cap per-call spend.${C_OFF}"
    warn "  --budget-usd \$$BUDGET_USD is advisory only. This run has NO spend ceiling:"
    warn "  a single call can cost whatever the model decides to spend on it."
    rule
    if [ "$ASSUME_YES" -eq 1 ]; then
        warn "--yes given — proceeding with uncapped spend."
    elif [ -t 0 ]; then
        printf '%s' "👉 Run with UNCAPPED spend? [y/N] " >&2
        read -r reply
        case "$reply" in y|Y|yes|YES) : ;; *) die "aborted by user" ;; esac
    else
        die "uncapped spend, not a terminal, and --yes not given — refusing to spend money unattended"
    fi
fi

# ── cost gate ────────────────────────────────────────────────────────────────
rule
info "${C_BLD}This run will make ${NCALLS} agent call(s) and cost real money.${C_OFF}"
info "  driver:       $DRIVER_NAME ($DRIVER_VERSION)"
info "  model:        $MODEL"
info "  arms:         $ARMS ($NARMS)"
info "  questions:    $NQ"
info "  corpus:       ${SCALE:-5} document(s)$([ -n "$SCALE" ] && [ "$SCALE" -gt 5 ] && printf ' — %s generated distractors, seed %s' "$((SCALE - 5))" "$SCALE_SEED")"
info "  per-call cap: \$$BUDGET_USD"
info "  output:       $RUN_DIR"
rule

if [ -n "$SCALE" ] && [ "$SCALE" -gt 5 ]; then
    warn "Scaled corpus: the extra $((SCALE - 5)) documents are generated padding."
    warn "  They answer nothing. This measures retrieval pressure, not domain"
    warn "  breadth, and is a weaker instrument than $SCALE genuinely distinct"
    warn "  documents would be. Results are comparable only to runs at the same"
    warn "  --scale and --scale-seed."
    rule
fi

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

# ── build the corpus ─────────────────────────────────────────────────────────
# At the default scale every arm reads fixtures/raw directly. At a larger scale
# the corpus is generated once, into the run directory, and every arm copies
# from that one tree — so the arms cannot be reading different padding.
build_corpus() {
    if [ -z "$SCALE" ] || [ "$SCALE" -le 5 ]; then
        printf '%s\n' "$FIXTURES_DIR/raw"
        return
    fi
    local dir="$RUN_DIR/corpus"
    assert_inside_benchmarks "$dir"
    [ "$DRY_RUN" -eq 1 ] && { printf '%s\n' "$dir"; return; }
    "$FIXTURES_DIR/scale/generate.sh" --tier "$SCALE" --seed "$SCALE_SEED" \
        --out "$dir" --force >/dev/null 2>&1 \
        || die "corpus generation failed — run fixtures/scale/generate.sh --tier $SCALE --out $dir --force to see why"
    printf '%s\n' "$dir"
}

# ── build the arena ──────────────────────────────────────────────────────────
# Each arm runs with its arena directory as cwd, holding only what that arm is
# allowed to see. Copies, never symlinks into fixtures/, so a run can never
# mutate the corpus.
build_arena() {
    local arm="$1" dir="$RUN_DIR/arena/$arm" wiki
    assert_inside_benchmarks "$dir"
    [ "$DRY_RUN" -eq 1 ] && { echo "$dir"; return; }
    rm -rf "$dir"
    mkdir -p "$dir/sources"
    cp "$CORPUS_DIR"/*.md "$dir/sources/"
    # A drift arm overlays the amended documents ON TOP of the originals, under
    # the same filenames. Same path, same document reference, different bytes —
    # which is precisely the case incremental re-ingest exists to detect.
    if arm_is_drift "$arm"; then
        cp "$FIXTURES_DIR"/drift/*.md "$dir/sources/"
    fi
    wiki="$(arm_wiki "$arm")"
    if [ -n "$wiki" ]; then
        mkdir -p "$dir/wiki"
        cp "$FIXTURES_DIR/$wiki"/*.md "$dir/wiki/"
        # The catalog sits BESIDE wiki/, the same shape as a real brain. Both
        # fixture wikis share it: they cover the same sources, and nothing
        # planted in wiki-poisoned/ touches the catalog.
        # manifest.yaml is deliberately NOT copied — it is an ingest artifact,
        # and handing it over would turn the drift arm's question from "did you
        # notice the page disagrees with the document" into "did you compare two
        # hex strings". See fixtures/README.md.
        cp "$FIXTURES_DIR/index.md" "$dir/index.md"
    fi
    echo "$dir"
}

system_prompt_for() {
    cat "$PROMPTS_DIR/_shared.md"
    printf '\n\n'
    cat "$PROMPTS_DIR/$(arm_prompt "$1").md"
}

# ── run ──────────────────────────────────────────────────────────────────────
[ "$DRY_RUN" -eq 0 ] && mkdir -p "$RUN_DIR"

CORPUS_DIR="$(build_corpus)"

if [ "$DRY_RUN" -eq 0 ]; then
    # The corpus the arms actually saw, recorded so score.sh checks cited
    # document ids against that and not against fixtures/raw. At --scale 500
    # they are not the same set, and treating a real distractor id as
    # fabricated would be a metric that lies in the project's own favour.
    corpus_docids "$CORPUS_DIR" > "$RUN_DIR/corpus.docids"
    corpus_files  "$CORPUS_DIR" > "$RUN_DIR/corpus.files"
    {
        echo "run_id=$RUN_ID"
        echo "date_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        echo "model=$MODEL"
        echo "arms=$ARMS"
        echo "arms_count=$NARMS"
        echo "scale=${SCALE:-5}"
        echo "scale_seed=$SCALE_SEED"
        echo "scale_generated=$([ -n "$SCALE" ] && [ "$SCALE" -gt 5 ] && echo $((SCALE - 5)) || echo 0)"
        echo "corpus_documents=$(wc -l < "$RUN_DIR/corpus.files" | tr -d ' ')"
        echo "questions_file=$QUESTIONS"
        echo "questions_sha256=$(file_sha256 "$QUESTIONS")"
        echo "questions_count=$NQ"
        echo "question_ids=$(printf '%s' "$IDS" | tr '\n' ',' | sed 's/,$//')"
        echo "shared_prompt_sha256=$(file_sha256 "$PROMPTS_DIR/_shared.md")"
        echo "protocol_drift=$DRIFT_DETECTED"
        echo "budget_usd_per_call=$BUDGET_USD"
        echo "driver=$DRIVER_NAME"
        echo "driver_path=${DRIVER#$REPO_DIR/}"
        echo "driver_version=$DRIVER_VERSION"
        printf '%s\n' "$CAPS" | awk -F'\t' '{ printf "cap_%s=%s\n", $1, $2 }'
        echo "git_sha=$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
        echo "git_dirty=$(test -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" && echo yes || echo no)"
        echo "harness_version=3"
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
            dim "        cd $ARENA && \\"
            dim "          ALM_PROMPT=<question, $(printf '%s' "$QUESTION" | wc -c | tr -d ' ') bytes> \\"
            dim "          ALM_SYSTEM=<${arm} protocol, $(printf '%s' "$SYS" | wc -c | tr -d ' ') bytes> \\"
            dim "          ALM_MODEL=$MODEL ALM_TOOLS=Read,Grep,Glob ALM_BUDGET_USD=$BUDGET_USD \\"
            dim "          ${DRIVER#$REPO_DIR/} run"
            dim "        → $OUT/$qid.answer.md"
            continue
        fi

        RAW="$OUT/$qid.raw.json"
        ANS="$OUT/$qid.answer.md"
        META="$OUT/$qid.meta.tsv"

        t0="$(date +%s)"
        set +e
        ( cd "$ARENA" && \
          ALM_PROMPT="$QUESTION" \
          ALM_SYSTEM="$SYS" \
          ALM_MODEL="$MODEL" \
          ALM_TOOLS="Read,Grep,Glob" \
          ALM_BUDGET_USD="$BUDGET_USD" \
          ALM_SCHEMA_FILE="" \
          "$DRIVER" run \
        # stdin is /dev/null so the CLI cannot swallow the question-id list this
        # loop is reading from. Classic shell bug; it silently truncates a run.
        ) < /dev/null > "$RAW" 2> "$OUT/$qid.stderr.log"
        rc=$?
        set -e
        t1="$(date +%s)"
        wall_ms=$(( (t1 - t0) * 1000 ))

        if [ "$rc" -ne 0 ]; then
            warn "        driver exited $rc — see $OUT/$qid.stderr.log"
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
        if [ -n "$dur" ]; then lat="$dur"; latsrc="driver_duration_ms"
        else                   lat="$wall_ms"; latsrc="wall_clock_s"; fi

        {
            printf 'status\tok\n'
            printf 'arm\t%s\n'            "$arm"
            printf 'question_id\t%s\n'    "$qid"
            printf 'category\t%s\n'       "$CATEGORY"
            printf 'driver\t%s\n'         "$DRIVER_NAME"
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
