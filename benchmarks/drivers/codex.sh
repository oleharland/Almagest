#!/usr/bin/env bash
# codex.sh — benchmark driver for the OpenAI Codex CLI (`codex`).
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  UNVERIFIED FLAGS. This driver was written without a Codex CLI to test    │
# │  against. The flags below are a best understanding of `codex exec`, not   │
# │  a checked fact:                                                         │
# │      codex exec "<prompt>"     non-interactive one-shot                   │
# │      --model <name>            model selection                            │
# │      --sandbox read-only       read-only filesystem sandbox               │
# │      --output-last-message F   write the final assistant message to F     │
# │      --output-schema F         constrain output to a JSON schema          │
# │  FAILURE MODE if one is wrong: `codex` exits non-zero with a usage error, │
# │  the driver exits with that code, and run.sh records the arm as failed    │
# │  and stops. It does NOT silently produce a wrong answer. The last three   │
# │  flags are probed for in `codex exec --help` before use, so a build that  │
# │  lacks them degrades instead of erroring — and any capability that        │
# │  depends on one is then reported `no`.                                    │
# │  Fix a wrong flag here, then re-run benchmarks/selftest.sh.               │
# └──────────────────────────────────────────────────────────────────────────┘
#
# Semantic differences from claude-code.sh — read these before comparing runs:
#
#   * No system-prompt flag. Codex takes its project instructions from AGENTS.md
#     and has no `--append-system-prompt` equivalent, so ALM_SYSTEM is prepended
#     to the prompt text. The model sees the same words in a weaker position.
#   * No per-tool allowlist. Codex has sandbox modes, not a tool allowlist, so
#     `tool_restriction` is reported `no` and ALM_TOOLS is ignored. A read-only
#     sandbox still prevents writes; it does not enforce the allowlist this
#     benchmark asks for, and the report says so under Comparability.
#   * No per-call spend cap and no dollar cost in the output: `budget_cap` and
#     `cost_reporting` are both `no`. A run through this driver spends whatever
#     it spends.
#
# ALM_CLI overrides the binary. See benchmarks/drivers/README.md.
set -euo pipefail

CLI="${ALM_CLI:-codex}"
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)"

# `codex exec --help`, read once. Empty when the CLI is absent, which makes
# every probed capability report `no` — the honest answer for a CLI that is not
# there to enforce anything.
if command -v "$CLI" >/dev/null 2>&1; then
    HELP="$("$CLI" exec --help 2>/dev/null || true)"
else
    HELP=""
fi
has_flag() { printf '%s' "$HELP" | grep -q -- "$1"; }
yesno()    { if has_flag "$1"; then echo yes; else echo no; fi; }

capabilities() {
    printf 'tool_restriction\tno\n'
    printf 'budget_cap\tno\n'
    printf 'structured_output\t%s\n' "$(yesno --output-schema)"
    printf 'cost_reporting\tno\n'
    # `codex exec` starts a fresh session on every invocation; resuming is an
    # explicit opt-in this driver never passes.
    printf 'session_isolation\tyes\n'
    printf 'sandbox\t%s\n' "$(yesno --sandbox)"
}

version() {
    command -v "$CLI" >/dev/null 2>&1 || {
        printf 'codex.sh: %s not found on PATH — install the Codex CLI\n' "$CLI" >&2
        exit 1
    }
    "$CLI" --version 2>/dev/null | head -1
}

OUT_FILE=""
LAST_FILE=""
cleanup() { [ -n "$OUT_FILE" ] && rm -f "$OUT_FILE"; [ -n "$LAST_FILE" ] && rm -f "$LAST_FILE"; return 0; }

run() {
    local prompt="${ALM_PROMPT:-}"
    [ -n "$prompt" ] || { echo "codex.sh: ALM_PROMPT is empty" >&2; exit 2; }
    if [ -n "${ALM_SYSTEM:-}" ]; then
        prompt="$ALM_SYSTEM

$prompt"
    fi

    local args=( exec )
    [ -n "${ALM_MODEL:-}" ] && args+=( --model "$ALM_MODEL" )
    has_flag --sandbox && args+=( --sandbox read-only )

    trap cleanup EXIT
    OUT_FILE="$(mktemp -t almagest-codex-out.XXXXXX)"
    if has_flag --output-last-message; then
        LAST_FILE="$(mktemp -t almagest-codex-msg.XXXXXX)"
        args+=( --output-last-message "$LAST_FILE" )
    fi

    if [ -n "${ALM_SCHEMA_FILE:-}" ]; then
        has_flag --output-schema || {
            echo "codex.sh: ALM_SCHEMA_FILE is set but this codex build has no --output-schema" >&2
            exit 2
        }
        [ -f "$ALM_SCHEMA_FILE" ] || { echo "codex.sh: schema file not found: $ALM_SCHEMA_FILE" >&2; exit 2; }
        args+=( --output-schema "$ALM_SCHEMA_FILE" )
    fi

    local rc
    set +e
    "$CLI" "${args[@]}" "$prompt" < /dev/null > "$OUT_FILE"
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || exit "$rc"

    # Prefer the file holding only the final message. Without it, everything the
    # CLI printed is treated as the answer, transcript noise included — said out
    # loud on stderr rather than quietly scored.
    local text="$OUT_FILE"
    if [ -n "$LAST_FILE" ] && [ -s "$LAST_FILE" ]; then
        text="$LAST_FILE"
    elif [ -z "$LAST_FILE" ]; then
        echo "codex.sh: no --output-last-message on this build — the captured answer includes any transcript the CLI printed" >&2
    fi

    printf '{"result":"%s","is_error":false}\n' "$(awk -f "$LIB_DIR/json_escape.awk" < "$text")"
}

case "${1:-}" in
    capabilities) capabilities ;;
    version)      version ;;
    run)          run ;;
    *) printf 'codex.sh: expected one of: capabilities, version, run (got: %s)\n' "${1:-<nothing>}" >&2; exit 2 ;;
esac
