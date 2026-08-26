#!/usr/bin/env bash
# gemini-cli.sh — benchmark driver for the Gemini CLI (`gemini`).
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  UNVERIFIED FLAGS. This driver was written without a Gemini CLI to test   │
# │  against. The flags below are a best understanding, not a checked fact:   │
# │      gemini -p "<prompt>"      non-interactive one-shot                   │
# │      -m <name>                 model selection                            │
# │      --allowed-tools <list>    tool allowlist                             │
# │      --output-format json      structured envelope, answer under          │
# │                                the top-level "response" key               │
# │  FAILURE MODE if one is wrong: `gemini` exits non-zero with a usage error,│
# │  the driver exits with that code, and run.sh records the arm as failed    │
# │  and stops. It does NOT silently produce a wrong answer. Everything but   │
# │  `-p` and `-m` is probed for in `gemini --help` before use, so a build    │
# │  that lacks a flag degrades instead of erroring — and any capability that │
# │  depends on it is then reported `no`.                                     │
# │  Fix a wrong flag here, then re-run benchmarks/selftest.sh.               │
# └──────────────────────────────────────────────────────────────────────────┘
#
# Semantic differences from claude-code.sh — read these before comparing runs:
#
#   * No system-prompt flag. The CLI's only system-prompt hook replaces the
#     built-in prompt wholesale, which would change the harness under test, so
#     ALM_SYSTEM is prepended to the prompt text instead. The model sees the
#     same words in a weaker position.
#   * Tool names differ. ALM_TOOLS speaks the harness's vocabulary
#     (Read,Grep,Glob); this driver maps it to the Gemini tool names below.
#     A name with no mapping is passed through untranslated.
#   * No spend cap and no dollar cost: `budget_cap` and `cost_reporting` are
#     `no`. Token counts are reported by the CLI, dollars are not.
#   * `sandbox` is reported `no`. The CLI's sandbox needs Docker or Podman and
#     is off unless containers are available; a driver that reported `yes` and
#     then did not sandbox would be lying about the one thing the capability
#     exists to state. The arena is a throwaway copy either way — but nothing
#     enforces read-only, so the report says so under Comparability.
#
# ALM_CLI overrides the binary. See benchmarks/drivers/README.md.
set -euo pipefail

CLI="${ALM_CLI:-gemini}"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"

if command -v "$CLI" >/dev/null 2>&1; then
    HELP="$("$CLI" --help 2>/dev/null || true)"
else
    HELP=""
fi
has_flag() { printf '%s' "$HELP" | grep -q -- "$1"; }
yesno()    { if has_flag "$1"; then echo yes; else echo no; fi; }

# Harness tool vocabulary → Gemini tool names.
map_tools() {
    printf '%s' "$1" | tr ',' '\n' | while IFS= read -r t; do
        case "$t" in
            Read)  printf 'read_file\n' ;;
            Grep)  printf 'search_file_content\n' ;;
            Glob)  printf 'glob\n' ;;
            "")    : ;;
            *)     printf '%s\n' "$t" ;;
        esac
    done | paste -sd, - 2>/dev/null || printf '%s' "$1"
}

capabilities() {
    printf 'tool_restriction\t%s\n' "$(yesno --allowed-tools)"
    printf 'budget_cap\tno\n'
    # No JSON-schema flag on this CLI. --output-format json shapes the envelope,
    # not the model's answer, so the judge pass cannot be schema-constrained.
    printf 'structured_output\tno\n'
    printf 'cost_reporting\tno\n'
    # `-p` is a one-shot invocation; nothing is resumed unless asked for.
    printf 'session_isolation\tyes\n'
    printf 'sandbox\tno\n'
}

version() {
    command -v "$CLI" >/dev/null 2>&1 || {
        printf 'gemini-cli.sh: %s not found on PATH — install the Gemini CLI\n' "$CLI" >&2
        exit 1
    }
    "$CLI" --version 2>/dev/null | head -1
}

OUT_FILE=""
cleanup() { [ -n "$OUT_FILE" ] && rm -f "$OUT_FILE"; return 0; }

run() {
    local prompt="${ALM_PROMPT:-}"
    [ -n "$prompt" ] || { echo "gemini-cli.sh: ALM_PROMPT is empty" >&2; exit 2; }
    if [ -n "${ALM_SYSTEM:-}" ]; then
        prompt="$ALM_SYSTEM

$prompt"
    fi

    if [ -n "${ALM_SCHEMA_FILE:-}" ]; then
        echo "gemini-cli.sh: ALM_SCHEMA_FILE is set, but this CLI cannot enforce a JSON schema (structured_output=no)" >&2
        exit 2
    fi

    local args=()
    [ -n "${ALM_MODEL:-}" ] && args+=( -m "$ALM_MODEL" )
    if has_flag --allowed-tools; then
        args+=( --allowed-tools "$(map_tools "${ALM_TOOLS:-}")" )
    fi

    local json=0
    if has_flag --output-format; then
        json=1
        args+=( --output-format json )
    fi

    trap cleanup EXIT
    OUT_FILE="$(mktemp -t almagest-gemini-out.XXXXXX)"

    local rc
    set +e
    "$CLI" "${args[@]}" -p "$prompt" < /dev/null > "$OUT_FILE"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || exit "$rc"

    local text
    if [ "$json" -eq 1 ]; then
        # The envelope's "response" is the answer; "stats" is nested and skipped.
        text="$(awk -v raw=response -f "$LIB_DIR/json_scalar.awk" "$OUT_FILE" 2>/dev/null)" || {
            echo "gemini-cli.sh: --output-format json produced no top-level 'response' field" >&2
            exit 2
        }
        printf '{"result":"%s","is_error":false}\n' \
            "$(printf '%s' "$text" | awk -f "$LIB_DIR/json_escape.awk")"
    else
        printf '{"result":"%s","is_error":false}\n' "$(awk -f "$LIB_DIR/json_escape.awk" < "$OUT_FILE")"
    fi
}

case "${1:-}" in
    capabilities) capabilities ;;
    version)      version ;;
    run)          run ;;
    *) printf 'gemini-cli.sh: expected one of: capabilities, version, run (got: %s)\n' "${1:-<nothing>}" >&2; exit 2 ;;
esac
