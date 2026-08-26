#!/usr/bin/env bash
#
# fixtures/scale/generate.sh — build a corpus of a given size, deterministically.
#
# ┌──────────────────────────────────────────────────────────────────────────┐
# │  READ THIS BEFORE QUOTING ANYTHING MEASURED AT SCALE.                    │
# │  Padding a five-document corpus with generated distractors measures      │
# │  RETRIEVAL PRESSURE — how hard it is to find the right document when the │
# │  right document is one of many. It does NOT measure domain breadth: the  │
# │  answers still live in the same five documents, the distractors are      │
# │  shallower and more uniform than real material, and they were written by │
# │  one template rather than by fifty different offices over three years.   │
# │  This is a weaker instrument than 500 genuinely distinct documents, and  │
# │  it is here because 500 genuinely distinct documents do not exist.       │
# └──────────────────────────────────────────────────────────────────────────┘
#
# Output is a function of (--tier, --seed) and nothing else: no clock, no
# network, no package manager, no $RANDOM. Two runs with the same arguments
# produce byte-identical corpora, and a larger tier is a strict superset of a
# smaller one under the same seed.
#
# Usage:
#   fixtures/scale/generate.sh --tier 50 --out DIR [--seed N] [--force]
#
# The result is a flat directory of .md documents, ready to be copied into an
# arm's sources/. run.sh calls this for you when you pass --scale.

set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$(cd "$HERE/.." && pwd)"

TIER=""
OUT=""
SEED=1
FORCE=0

usage() {
    cat <<'USAGE'
Usage: fixtures/scale/generate.sh --tier N --out DIR [--seed N] [--force]

  --tier N     total documents in the corpus. Shipped tiers: 5, 50, 500.
               Must be at least 5 — the five real sources are always included,
               because they are the only documents that answer anything.
  --out DIR    where to write. Must not exist unless --force.
  --seed N     integer seed (default: 1). Same seed + same tier = same bytes.
  --force      overwrite DIR
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --tier)  TIER="${2:?--tier needs a value}"; shift 2 ;;
        --out)   OUT="${2:?--out needs a value}"; shift 2 ;;
        --seed)  SEED="${2:?--seed needs a value}"; shift 2 ;;
        --force) FORCE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; printf 'generate.sh: unknown argument: %s\n' "$1" >&2; exit 1 ;;
    esac
done

die() { printf 'generate.sh: %s\n' "$*" >&2; exit 1; }

[ -n "$TIER" ] || { usage >&2; die "--tier is required"; }
[ -n "$OUT" ]  || { usage >&2; die "--out is required"; }
case "$TIER" in ''|*[!0-9]*) die "--tier must be a positive integer (got: $TIER)" ;; esac
case "$SEED" in ''|*[!0-9]*) die "--seed must be a non-negative integer (got: $SEED)" ;; esac

REAL="$(find "$FIXTURES/raw" -name '*.md' -type f | wc -l | tr -d ' ')"
[ "$REAL" -gt 0 ] || die "no source documents in $FIXTURES/raw"
[ "$TIER" -ge "$REAL" ] || die "--tier $TIER is smaller than the $REAL real sources. The real sources are the only documents that answer anything and are never dropped."

if [ -e "$OUT" ]; then
    [ "$FORCE" -eq 1 ] || die "output directory already exists: $OUT (use --force)"
    rm -rf "$OUT"
fi
mkdir -p "$OUT"

cp "$FIXTURES"/raw/*.md "$OUT/"

NDIST=$((TIER - REAL))
if [ "$NDIST" -gt 0 ]; then
    awk -v outdir="$OUT" -v n="$NDIST" -v seed="$SEED" \
        -f "$HERE/distractors.awk" < /dev/null
fi

# ── fail closed on the blocklist ─────────────────────────────────────────────
# A generated document that mentions a fixture proper noun, or a topic the
# unanswerable questions depend on being absent, silently rewrites the benchmark.
# Refuse to hand over a corpus that does, rather than warn about it.
if [ "$NDIST" -gt 0 ]; then
    TERMS="$(mktemp -t almagest-blocklist.XXXXXX)"
    trap 'rm -f "$TERMS"' EXIT
    sed 's/#.*//' "$HERE/blocklist.txt" | sed '/^[[:space:]]*$/d' > "$TERMS"
    [ -s "$TERMS" ] || die "blocklist.txt has no terms — the safety check would be vacuous"
    if HITS="$(grep -l -i -F -f "$TERMS" "$OUT"/dz-*.md 2>/dev/null)" && [ -n "$HITS" ]; then
        printf 'generate.sh: generated documents matched the blocklist:\n%s\n' "$HITS" >&2
        die "refusing to emit this corpus — a distractor is not distracting if it answers the question"
    fi
fi

TOTAL="$(find "$OUT" -name '*.md' -type f | wc -l | tr -d ' ')"
printf 'generate.sh: %s documents in %s (%s real, %s generated, seed %s)\n' \
       "$TOTAL" "$OUT" "$REAL" "$NDIST" "$SEED" >&2
