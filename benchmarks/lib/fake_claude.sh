#!/usr/bin/env bash
# fake_claude.sh — a test double for the `claude` CLI.
#
# It makes NO API calls and costs NOTHING. Its only job is to let
# benchmarks/selftest.sh exercise every non-API path in the harness: arena
# construction, answer capture, metadata extraction, mechanical scoring, report
# rendering, and each failure branch.
#
# Point the harness at it with:
#     ALMAGEST_BENCH_CLAUDE_BIN=benchmarks/lib/fake_claude.sh benchmarks/run.sh ...
#
# The canned answer is deliberately WRONG in specific, checkable ways so the
# mechanical checks have something to catch. It is not, and must never be
# mistaken for, a benchmark result.
#
# ALMAGEST_STUB_MODE:
#   answer     (default) emit a canned answer
#   verdict    emit a canned judge verdict
#   empty      emit a result field containing only whitespace
#   malformed  emit JSON with no result field
#   error      exit non-zero
set -euo pipefail

for a in "$@"; do
    [ "$a" = "--version" ] && { echo "fake-claude 0.0.0 (test double — not the real CLI)"; exit 0; }
done

case "${ALMAGEST_STUB_MODE:-answer}" in
  error)     echo "fake_claude: simulated failure" >&2; exit 3 ;;
  malformed) printf '{"type":"result","is_error":false,"duration_ms":1}\n'; exit 0 ;;
  empty)     printf '{"type":"result","subtype":"success","is_error":false,"duration_ms":12,"num_turns":1,"result":"   \\n  ","total_cost_usd":0.0001}\n'; exit 0 ;;
  verdict)
    printf '{"type":"result","subtype":"success","is_error":false,"duration_ms":900,"num_turns":1,"total_cost_usd":0.0021,"result":"{\\"correctness\\":1,\\"citation_support\\":1,\\"unsourced_claims\\":2,\\"abstention\\":\\"n/a\\",\\"contradiction\\":\\"one_sided\\",\\"synthesis_flag\\":\\"n/a\\",\\"notes\\":\\"Canned verdict from the test double. Not a real score.\\"}"}\n'
    exit 0 ;;
esac

# Canned answer. Contains, on purpose:
#   - one resolvable wikilink   [[gannet-narrows-site-conditions]]
#   - one broken wikilink       [[tidal-yield-model]]
#   - one real document id      MCA-SUR-0014
#   - one fabricated document id MCA-XXX-9999
#   - a section marker (§3) and a synthesis marker
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"duration_ms":18420,"duration_api_ms":17330,"num_turns":3,"session_id":"stub-session","total_cost_usd":0.0374,"usage":{"input_tokens":9000,"output_tokens":220},"result":"CANNED TEST-DOUBLE OUTPUT — NOT A BENCHMARK RESULT.\n\nPeak tidal current is 3.4 m/s at Gannet Narrows.\n\n  [[gannet-narrows-site-conditions]], §Tidal regime\n  Original: MCA-SUR-0014 Site Survey Report, §3\n\nSee also [[tidal-yield-model]] and MCA-XXX-9999, neither of which exists.\n\nSynthesized from two documents — no single source makes this claim directly."}'
