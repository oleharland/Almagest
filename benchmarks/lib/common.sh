#!/usr/bin/env bash
# benchmarks/lib/common.sh — shared helpers for run.sh and score.sh.
# Sourced, not executed.

# Byte semantics for every awk/grep call in the harness. The awk parsers decode
# \uXXXX into UTF-8 bytes by hand and need this to be deterministic.
export LC_ALL=C

BM_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$BM_DIR/.." && pwd)"
FIXTURES_DIR="$BM_DIR/fixtures"
PROMPTS_DIR="$BM_DIR/prompts"
LIB_DIR="$BM_DIR/lib"
DRIVERS_DIR="$BM_DIR/drivers"
DEFAULT_RESULTS_DIR="$BM_DIR/results"
DEFAULT_QUESTIONS="$BM_DIR/questions.yaml"

# The protocol prompt restates the contract in agent/rules/read.md. If that file
# changes, the benchmark may no longer be measuring the shipped protocol.
PROTOCOL_SOURCE="$REPO_DIR/agent/rules/read.md"
PROTOCOL_NAME="agent/rules/read.md"

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'
    C_DIM=$'\033[2m';  C_BLD=$'\033[1m';  C_OFF=$'\033[0m'
else
    C_RED=; C_YEL=; C_GRN=; C_DIM=; C_BLD=; C_OFF=
fi

die()  { printf '%s\n' "${C_RED}✗ $*${C_OFF}" >&2; exit 1; }
warn() { printf '%s\n' "${C_YEL}⚠ $*${C_OFF}" >&2; }
ok()   { printf '%s\n' "${C_GRN}✓ $*${C_OFF}" >&2; }
info() { printf '%s\n' "$*" >&2; }
dim()  { printf '%s\n' "${C_DIM}$*${C_OFF}" >&2; }

rule() { printf '%s\n' "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" >&2; }

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || die "required command not found on PATH: $1${2:+ — $2}"
}

# sha256 of a file, on macOS or Linux, without installing anything.
file_sha256() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    elif command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
    else echo "unavailable"; fi
}

# Warn if agent/rules/read.md has drifted from the version the shared prompt
# mirrors. A warning, not an error: the harness still runs, but the operator
# needs to know the prompt may no longer reflect the shipped query protocol.
check_protocol_drift() {
    local recorded actual
    recorded="$(sed -n 's/.*almagest-protocol-sha256: \([0-9a-f]*\).*/\1/p' \
                "$PROMPTS_DIR/_shared.md" | head -1)"
    [ -n "$recorded" ] || { warn "no protocol sha recorded in prompts/_shared.md"; return 0; }
    [ -f "$PROTOCOL_SOURCE" ] || { warn "$PROTOCOL_NAME not found — cannot check protocol drift"; return 0; }
    actual="$(file_sha256 "$PROTOCOL_SOURCE")"
    [ "$actual" = "unavailable" ] && return 0
    if [ "$recorded" != "$actual" ]; then
        warn "$PROTOCOL_NAME has changed since benchmarks/prompts/_shared.md was written."
        warn "  recorded: $recorded"
        warn "  actual:   $actual"
        warn "  The benchmark may no longer be measuring the shipped query protocol."
        warn "  Re-read $PROTOCOL_NAME, update prompts/_shared.md, and record the new sha."
        DRIFT_DETECTED=1
    fi
}

# Fail loudly if the fixture corpus is missing or empty. A benchmark that runs
# against nothing and reports nothing is worse than one that refuses to start.
check_fixtures() {
    [ -d "$FIXTURES_DIR/raw" ]  || die "fixture corpus missing: $FIXTURES_DIR/raw"
    [ -d "$FIXTURES_DIR/wiki" ] || die "fixture wiki missing: $FIXTURES_DIR/wiki"
    local n
    n="$(find "$FIXTURES_DIR/raw" -name '*.md' -type f | wc -l | tr -d ' ')"
    [ "$n" -gt 0 ] || die "no source documents in $FIXTURES_DIR/raw"
    n="$(find "$FIXTURES_DIR/wiki" -name '*.md' -type f | wc -l | tr -d ' ')"
    [ "$n" -gt 0 ] || die "no wiki pages in $FIXTURES_DIR/wiki"
    [ -f "$FIXTURES_DIR/wiki/index.md" ] || die "fixture wiki has no index.md"
}

# Guard rail: every path the harness writes to must be inside benchmarks/.
# The benchmark must never touch a user's real knowledge base.
assert_inside_benchmarks() {
    case "$1" in
        "$BM_DIR"/*) : ;;
        *) die "refusing to write outside benchmarks/: $1" ;;
    esac
}

# Resolve to an absolute path so --out works from any cwd. Deliberately does not
# collapse ".." — a path containing it will fail assert_inside_benchmarks, which
# is the safe outcome.
abspath() {
    case "$1" in
        /*) printf '%s\n' "$1" ;;
        *)  printf '%s\n' "$PWD/${1#./}" ;;
    esac
}

parse_questions() {
    awk -f "$LIB_DIR/parse_questions.awk" "$1"
}

# field <tsv> <id> <key>  → all values for that key, one per line
qfield() {
    awk -F'\t' -v id="$2" -v k="$3" '$1==id && $2==k { print $3 }' "$1"
}

qfield1() { qfield "$@" | head -1; }

# ── driver layer ─────────────────────────────────────────────────────────────
# Every agent CLI is reached through benchmarks/drivers/<name>.sh. The interface
# — capabilities / version / run — is documented in benchmarks/drivers/README.md.

# The capability keys a driver must report, in report order. A driver that omits
# one, or answers anything but yes/no, is rejected at preflight.
CAP_KEYS="tool_restriction budget_cap structured_output cost_reporting session_isolation sandbox"

# A bare name is a shipped driver; anything with a slash is a path to one of
# your own. Absolute, because the arms run with the arena as cwd.
resolve_driver() {
    local spec="$1" path
    case "$spec" in
        */*) path="$(abspath "$spec")" ;;
        *)   path="$DRIVERS_DIR/$spec.sh" ;;
    esac
    [ -f "$path" ] || die "driver not found: $spec (looked for $path)
    Shipped drivers: $(ls "$DRIVERS_DIR"/*.sh 2>/dev/null | sed 's|.*/||; s|\.sh$||' | tr '\n' ' ')"
    [ -x "$path" ] || die "driver is not executable: $path"
    printf '%s\n' "$path"
}

driver_name_of() { printf '%s\n' "$(basename "$1" .sh)"; }

# Ask the driver what its CLI can genuinely enforce, and validate the answer
# before anything downstream trusts it. Sets CAPS.
load_capabilities() {
    local path="$1" name="$2" out v k
    out="$("$path" capabilities 2>/dev/null)" || die "driver '$name': 'capabilities' exited non-zero"
    for k in $CAP_KEYS; do
        v="$(printf '%s\n' "$out" | awk -F'\t' -v k="$k" '$1==k { print $2; exit }')"
        case "$v" in
            yes|no) : ;;
            "")     die "driver '$name': 'capabilities' reported no value for '$k' — see benchmarks/drivers/README.md" ;;
            *)      die "driver '$name': 'capabilities' reported '$k' as '$v' — must be yes or no" ;;
        esac
    done
    CAPS="$out"
}

# cap <key> → yes|no, from the CAPS loaded above.
cap() { printf '%s\n' "${CAPS:-}" | awk -F'\t' -v k="$1" '$1==k { print $2; exit }'; }
