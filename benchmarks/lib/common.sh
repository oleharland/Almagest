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
DEFAULT_RESULTS_DIR="$BM_DIR/results"
DEFAULT_QUESTIONS="$BM_DIR/questions.yaml"

# The protocol prompt restates the contract in brain/CLAUDE.md. If that file
# changes, the benchmark may no longer be measuring the shipped protocol.
PROTOCOL_SOURCE="$REPO_DIR/brain/CLAUDE.md"

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

# Warn if brain/CLAUDE.md has drifted from the version the shared prompt mirrors.
# A warning, not an error: the harness still runs, but the operator needs to know
# the prompt may no longer reflect the shipped query protocol.
check_protocol_drift() {
    local recorded actual
    recorded="$(sed -n 's/.*almagest-protocol-sha256: \([0-9a-f]*\).*/\1/p' \
                "$PROMPTS_DIR/_shared.md" | head -1)"
    [ -n "$recorded" ] || { warn "no protocol sha recorded in prompts/_shared.md"; return 0; }
    [ -f "$PROTOCOL_SOURCE" ] || { warn "brain/CLAUDE.md not found — cannot check protocol drift"; return 0; }
    actual="$(file_sha256 "$PROTOCOL_SOURCE")"
    [ "$actual" = "unavailable" ] && return 0
    if [ "$recorded" != "$actual" ]; then
        warn "brain/CLAUDE.md has changed since benchmarks/prompts/_shared.md was written."
        warn "  recorded: $recorded"
        warn "  actual:   $actual"
        warn "  The benchmark may no longer be measuring the shipped query protocol."
        warn "  Re-read brain/CLAUDE.md, update prompts/_shared.md, and record the new sha."
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
