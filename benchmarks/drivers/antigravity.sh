#!/usr/bin/env bash
# antigravity.sh — benchmark driver for Google's Antigravity CLI (`agy`).
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  THIS DRIVER RUNS THE AGENT WITH `--dangerously-skip-permissions`.        │
# │                                                                          │
# │  It is not optional. `agy --print` cannot complete a single turn without  │
# │  it: the first permission check fails closed and the run dies with        │
# │      Error: permission check failed for read_file "/Users/you":           │
# │      user denied permission                                              │
# │  — it reaches for the home directory before it ever touches the project,  │
# │  and print mode has nobody to ask. The flag auto-approves EVERY tool      │
# │  request for the whole call: reads, writes, and shell commands, anywhere  │
# │  on the filesystem the process can reach.                                 │
# │                                                                          │
# │  That is tolerable HERE and nowhere else. The benchmark arena is a        │
# │  disposable copy of the fixture corpus under                              │
# │  `benchmarks/results/<run>/arena/`, thrown away after the run, and both   │
# │  arms get the same treatment. It is NOT tolerable against a real          │
# │  knowledge base: never point this driver at a working `brain/`, and       │
# │  never reuse its flag set for anything but a throwaway tree. The one      │
# │  guarantee Almagest exists to provide — no write without your approval —  │
# │  is exactly the guarantee this flag removes.                             │
# └──────────────────────────────────────────────────────────────────────────┘
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  Antigravity is NOT the Gemini CLI. `benchmarks/drivers/gemini-cli.sh`    │
# │  drives `gemini` and shares none of these flags — pointing it at `agy`    │
# │  fails on the first argument. Use `--driver antigravity`.                 │
# └──────────────────────────────────────────────────────────────────────────┘
#
# What is verified, and what is not
# ---------------------------------
# Verified by running `agy` 1.1.18 on macOS:
#   --version                    prints a bare version number, e.g. `1.1.18`
#   -p / --print                 one-shot non-interactive prompt
#   --mode plan                  accepted; the mode the driver runs in
#   --output-format json         envelope described below
#   --json-schema <path>         accepts a FILE PATH (or a schema string),
#                                enforces it, and returns the conforming object
#                                under the NESTED key `structured_output`
#   the JSON envelope's keys:    conversation_id, status ("SUCCESS"),
#                                response, duration_seconds, num_turns,
#                                structured_output{}, json_schema{},
#                                usage{input_tokens, output_tokens,
#                                thinking_tokens, cache_read_tokens,
#                                total_tokens}
#   there is NO dollar figure anywhere in that envelope — tokens only.
#
# UNVERIFIED, listed in `agy --help` but never exercised here:
#   --sandbox                    "Run in a sandbox with terminal restrictions
#                                enabled". Not passed — see `sandbox` below.
#   --model <name>               only passed when ALM_MODEL is set
#   --disable-slash-commands     stops a leading `/` in a prompt being expanded
#                                into a slash command
#   --print-timeout <dur>        Go duration string; default 5m
#   --effort low|medium|high     not used
# FAILURE MODE if one of these is wrong: `agy` exits non-zero with a usage
# error, the driver exits with that code, and run.sh records the arm as failed
# and stops. It does NOT silently produce a wrong answer. Every flag past
# `-p`/`--output-format`/`--mode`/`--dangerously-skip-permissions` is probed for
# in `agy --help` before use, so a build that lacks one degrades instead of
# erroring. Fix a wrong flag here, then re-run benchmarks/selftest.sh.
#
# Semantic differences from claude-code.sh — read these before comparing runs:
#
#   * No system-prompt flag. `agy` has no `--append-system-prompt` equivalent,
#     so ALM_SYSTEM is prepended to the prompt text, the way codex.sh does it.
#     The model sees the same words in a weaker position.
#   * No per-tool allowlist. There is no allowlist flag at all, so
#     `tool_restriction` is `no` and ALM_TOOLS is ignored — and this driver
#     auto-approves every tool instead of restricting any. That is the single
#     biggest reason a run through this driver is not comparable to one through
#     claude-code.sh; the report says so under Comparability.
#   * No spend cap and no dollar cost. `budget_cap` and `cost_reporting` are
#     both `no`. The envelope carries token counts, but they are nested under
#     `usage` and this harness reads top-level scalars only, so they are
#     dropped rather than half-reported.
#   * Structured output arrives nested. `--json-schema` puts the conforming
#     object under `structured_output`, not in the answer text, so `run`
#     lifts that object out and emits it as the `result` string — which is
#     exactly the shape `score.sh --judge` parses.
#   * Latency is reported in seconds (`duration_seconds`) and converted to
#     `duration_ms` here. `session_id` is `conversation_id`.
#
# ALM_CLI overrides the binary (`agy`, typically ~/.local/bin/agy; the
# `agentapi` wrapper under ~/.gemini/antigravity-cli/bin just execs it).
# ALM_PRINT_TIMEOUT overrides the print-mode timeout, default 15m — Antigravity
# can be slow, and the CLI's own 5m default has been seen to be tight.
# See benchmarks/drivers/README.md for the interface.
set -euo pipefail

CLI="${ALM_CLI:-agy}"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"

# `agy --help`, read once. Local, free, and works logged out — which matters,
# because `capabilities` is called at preflight and must answer on a machine
# where agy is missing, rate-limited, or unauthenticated. Empty when the CLI is
# absent, which makes every probed capability report `no`: the honest answer for
# a CLI that is not there to enforce anything.
if command -v "$CLI" >/dev/null 2>&1; then
    HELP="$("$CLI" --help 2>&1 || true)"
else
    HELP=""
fi
has_flag() { printf '%s' "$HELP" | grep -q -- "$1"; }
yesno()    { if has_flag "$1"; then echo yes; else echo no; fi; }

capabilities() {
    # No tool-allowlist flag exists, and this driver auto-approves every tool
    # request. Nothing is restricted.
    printf 'tool_restriction\tno\n'
    # No spend-cap flag exists. ALM_BUDGET_USD is ignored.
    printf 'budget_cap\tno\n'
    # `--json-schema` is enforced and the conforming object comes back under
    # `structured_output`. Verified against agy 1.1.18.
    printf 'structured_output\t%s\n' "$(yesno --json-schema)"
    # The envelope reports tokens, never dollars. A token count is not a cost.
    printf 'cost_reporting\tno\n'
    # `--print` mints a new conversation_id per call; `--continue` and
    # `--conversation` are opt-ins this driver never passes. Nothing is carried
    # from one call to the next. (The conversation is still recorded under your
    # Antigravity account and resumable by id — that is a privacy question, not
    # a leak between benchmark calls.)
    printf 'session_isolation\tyes\n'
    # `no`, deliberately. `--sandbox` restricts terminal commands; it is not a
    # read-only filesystem mode, it has not been exercised here, and this driver
    # passes `--dangerously-skip-permissions`, which auto-approves every tool
    # request there is. `--mode plan` steers the agent away from editing but
    # nothing enforces it. Reporting `yes` would claim the one thing this
    # capability exists to state, and it would not be true.
    printf 'sandbox\tno\n'
}

version() {
    command -v "$CLI" >/dev/null 2>&1 || {
        printf 'antigravity.sh: %s not found on PATH — install the Antigravity CLI\n' "$CLI" >&2
        exit 1
    }
    # `agy --version` prints a bare number with no product name, which is
    # useless on its own in run.env, so it gets one here.
    printf 'agy %s\n' "$("$CLI" --version 2>/dev/null | head -1)"
}

# Lift the raw text of a top-level object or array out of a JSON object.
# lib/json_scalar.awk deliberately skips containers, and the schema-constrained
# answer is one, so this driver carries its own extractor. Same parser shape,
# same no-jq constraint.
EXTRACT_AWK='
function fail(m) { printf("antigravity.sh: %s\n", m) > "/dev/stderr"; bad = 1; exit 1 }
function skipws() { while (p <= n && substr(s, p, 1) ~ /[ \t\r\n]/) p++ }
function pstring(   out, c) {
    if (substr(s, p, 1) != "\"") fail("expected a string")
    p++; out = ""
    while (p <= n) {
        c = substr(s, p, 1)
        if (c == "\"") { p++; return out }
        if (c == "\\") { out = out c substr(s, p + 1, 1); p += 2; continue }
        out = out c; p++
    }
    fail("unterminated string")
}
function pskip(   depth, c, instr) {
    depth = 0; instr = 0
    while (p <= n) {
        c = substr(s, p, 1)
        if (instr) { if (c == "\\") p++; else if (c == "\"") instr = 0 }
        else if (c == "\"") instr = 1
        else if (c == "{" || c == "[") depth++
        else if (c == "}" || c == "]") { depth--; if (depth == 0) { p++; return } }
        p++
    }
    fail("unbalanced container")
}
function pliteral(   start, c) {
    start = p
    while (p <= n) { c = substr(s, p, 1); if (c == "," || c == "}" || c ~ /[ \t\r\n]/) break; p++ }
    return substr(s, start, p - start)
}
{ s = s $0 "\n" }
END {
    if (bad) exit 1
    n = length(s); p = 1
    skipws()
    if (substr(s, p, 1) != "{") fail("input is not a JSON object")
    p++
    for (;;) {
        skipws()
        if (p > n) fail("unexpected end of input")
        if (substr(s, p, 1) == "}") break
        key = pstring()
        skipws()
        if (substr(s, p, 1) != ":") fail("expected \":\" after key \"" key "\"")
        p++
        skipws()
        c = substr(s, p, 1)
        if (c == "\"") pstring()
        else if (c == "{" || c == "[") {
            start = p
            pskip()
            if (key == want) { printf("%s", substr(s, start, p - start)); exit 0 }
        } else pliteral()
        skipws()
        if (substr(s, p, 1) == ",") { p++; continue }
        if (substr(s, p, 1) == "}") break
        fail("expected \",\" or \"}\" after value for key \"" key "\"")
    }
    fail("key \"" want "\" is not a top-level object or array")
}
'

OUT_FILE=""
cleanup() { [ -n "$OUT_FILE" ] && rm -f "$OUT_FILE"; return 0; }

run() {
    local prompt="${ALM_PROMPT:-}"
    [ -n "$prompt" ] || { echo "antigravity.sh: ALM_PROMPT is empty" >&2; exit 2; }
    if [ -n "${ALM_SYSTEM:-}" ]; then
        prompt="$ALM_SYSTEM

$prompt"
    fi

    # Fail before spending anything rather than after.
    command -v "$CLI" >/dev/null 2>&1 || {
        printf 'antigravity.sh: %s not found on PATH — install the Antigravity CLI\n' "$CLI" >&2
        exit 1
    }

    local args=( --print "$prompt" --output-format json --mode plan --dangerously-skip-permissions )
    [ -n "${ALM_MODEL:-}" ] && args+=( --model "$ALM_MODEL" )
    has_flag --print-timeout       && args+=( --print-timeout "${ALM_PRINT_TIMEOUT:-15m}" )
    has_flag --disable-slash-commands && args+=( --disable-slash-commands )

    if [ -n "${ALM_SCHEMA_FILE:-}" ]; then
        has_flag --json-schema || {
            echo "antigravity.sh: ALM_SCHEMA_FILE is set but this agy build has no --json-schema" >&2
            exit 2
        }
        [ -f "$ALM_SCHEMA_FILE" ] || { echo "antigravity.sh: schema file not found: $ALM_SCHEMA_FILE" >&2; exit 2; }
        args+=( --json-schema "$ALM_SCHEMA_FILE" )
    fi

    trap cleanup EXIT
    OUT_FILE="$(mktemp -t almagest-antigravity-out.XXXXXX)"

    local rc
    set +e
    # stdin is /dev/null so the CLI cannot swallow whatever the caller is
    # reading from. Classic shell bug; it silently truncates a run.
    "$CLI" "${args[@]}" < /dev/null > "$OUT_FILE"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || exit "$rc"

    local text
    if [ -n "${ALM_SCHEMA_FILE:-}" ]; then
        # Schema-constrained: the conforming object is nested under
        # `structured_output`, and the answer text alongside it is the model's
        # unvalidated draft. Take the validated one.
        text="$(awk -v want=structured_output "$EXTRACT_AWK" "$OUT_FILE")" || {
            echo "antigravity.sh: --json-schema was passed but the envelope carries no structured_output object — see the raw payload" >&2
            exit 2
        }
    else
        text="$(awk -v raw=response -f "$LIB_DIR/json_scalar.awk" "$OUT_FILE" 2>/dev/null)" || {
            echo "antigravity.sh: --output-format json produced no top-level 'response' field" >&2
            exit 2
        }
    fi

    # status is "SUCCESS" on a clean turn. Anything else is reported as an
    # error rather than scored as an answer.
    local fields status is_error dur num_turns sid
    fields="$(awk -f "$LIB_DIR/json_scalar.awk" "$OUT_FILE" 2>/dev/null || true)"
    get() { printf '%s\n' "$fields" | awk -F'\t' -v k="$1" '$1==k { print $2; exit }'; }
    status="$(get status)"
    if [ "$status" = "SUCCESS" ] || [ -z "$status" ]; then is_error=false; else is_error=true; fi

    # duration_seconds is a float; the harness wants integer milliseconds.
    dur="$(get duration_seconds)"
    if [ -n "$dur" ]; then
        dur="$(awk -v d="$dur" 'BEGIN { printf("%d", d * 1000 + 0.5) }')"
    fi
    num_turns="$(get num_turns)"
    sid="$(get conversation_id)"

    # No total_cost_usd: the envelope has no dollar figure, and a blank is
    # honest where a zero would read as free.
    printf '{"result":"%s","is_error":%s,"duration_ms":"%s","num_turns":"%s","session_id":"%s"}\n' \
        "$(printf '%s' "$text" | awk -f "$LIB_DIR/json_escape.awk")" \
        "$is_error" "$dur" "$num_turns" "$sid"
}

case "${1:-}" in
    capabilities) capabilities ;;
    version)      version ;;
    run)          run ;;
    *) printf 'antigravity.sh: expected one of: capabilities, version, run (got: %s)\n' "${1:-<nothing>}" >&2; exit 2 ;;
esac
