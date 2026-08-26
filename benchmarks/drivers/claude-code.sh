#!/usr/bin/env bash
# claude-code.sh — benchmark driver for the Claude Code CLI (`claude`).
#
# This is the reference driver. Every flag below is one the harness already used
# before the driver layer existed, in the same order, with the same semantics —
# a run through this driver is byte-for-byte the run the harness made before.
#
# Flag notes:
#   --safe-mode                read-only mode
#   --tools / --allowedTools   the allowlist. Both are passed when the list is
#                              non-empty; an empty list passes `--tools ""`
#                              alone, which is what the judge pass has always
#                              done and is the only way to say "no tools".
#   --output-format json       the CLI already emits the flat shape the harness
#                              parses (result, is_error, duration_ms, num_turns,
#                              total_cost_usd, session_id, subtype), so `run`
#                              passes it through untouched. `usage` is nested
#                              and json_scalar.awk skips it.
#   --json-schema              structured output, used only by the judge pass
#   --max-budget-usd           per-call spend cap
#   --no-session-persistence   no state carried between calls
#
# ALM_CLI overrides the binary (the deprecated ALMAGEST_BENCH_CLAUDE_BIN maps
# onto it). See benchmarks/drivers/README.md for the interface.
set -euo pipefail

CLI="${ALM_CLI:-claude}"

capabilities() {
    cat <<'CAPS'
tool_restriction	yes
budget_cap	yes
structured_output	yes
cost_reporting	yes
session_isolation	yes
sandbox	yes
CAPS
}

version() {
    command -v "$CLI" >/dev/null 2>&1 || {
        printf 'claude-code.sh: %s not found on PATH — install Claude Code\n' "$CLI" >&2
        exit 1
    }
    "$CLI" --version 2>/dev/null | head -1
}

run() {
    local prompt="${ALM_PROMPT:-}"
    [ -n "$prompt" ] || { echo "claude-code.sh: ALM_PROMPT is empty" >&2; exit 2; }

    local args=( -p "$prompt" --safe-mode )
    [ -n "${ALM_MODEL:-}" ] && args+=( --model "$ALM_MODEL" )
    args+=( --output-format json )

    if [ -n "${ALM_TOOLS:-}" ]; then
        args+=( --tools "$ALM_TOOLS" --allowedTools "$ALM_TOOLS" )
    else
        args+=( --tools "" )
    fi

    args+=( --no-session-persistence )
    [ -n "${ALM_SYSTEM:-}" ] && args+=( --append-system-prompt "$ALM_SYSTEM" )

    if [ -n "${ALM_SCHEMA_FILE:-}" ]; then
        [ -f "$ALM_SCHEMA_FILE" ] || { echo "claude-code.sh: schema file not found: $ALM_SCHEMA_FILE" >&2; exit 2; }
        args+=( --json-schema "$(cat "$ALM_SCHEMA_FILE")" )
    fi

    [ -n "${ALM_BUDGET_USD:-}" ] && args+=( --max-budget-usd "$ALM_BUDGET_USD" )

    # stdin is /dev/null so the CLI cannot swallow whatever the caller is
    # reading from. Classic shell bug; it silently truncates a run.
    exec "$CLI" "${args[@]}" < /dev/null
}

case "${1:-}" in
    capabilities) capabilities ;;
    version)      version ;;
    run)          run ;;
    *) printf 'claude-code.sh: expected one of: capabilities, version, run (got: %s)\n' "${1:-<nothing>}" >&2; exit 2 ;;
esac
