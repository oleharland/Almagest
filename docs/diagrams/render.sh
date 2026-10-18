#!/usr/bin/env bash
# Render a diagram-design HTML file to a 2x PNG of just its <svg>, on the
# skin's paper colour. Uses headless Chrome (no Playwright needed).
#
#   docs/diagrams/render.sh docs/diagrams/ingest-flow.html          # -> ingest-flow.png
#   docs/diagrams/render.sh docs/diagrams/*.html                    # all of them
#
# A file whose name ends in -dark.html gets the dark paper.
set -euo pipefail
SKILL="${DIAGRAM_SKILL:-$HOME/.claude/skills/diagram-design}"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -r "$TMP"' EXIT

for src in "$@"; do
  base="${src%.html}"
  out="$(cd "$(dirname "$src")" && pwd)/$(basename "$base").png"
  case "$base" in *-dark) paper='#2B2C31' ;; *) paper='#F4F4F5' ;; esac
  python3 "$SKILL/scripts/export_svg.py" "$src" "$TMP/d.svg" >/dev/null
  read -r w h < <(python3 - "$TMP/d.svg" <<'PY'
import re, sys
vb = re.search(r'viewBox="([^"]+)"', open(sys.argv[1]).read()).group(1).split()
print(int(float(vb[2])), int(float(vb[3])))
PY
)
  {
    printf '<!doctype html><meta charset="utf-8">'
    printf '<style>html,body{margin:0;background:%s}svg{display:block;width:%spx;height:%spx}</style>' "$paper" "$w" "$h"
    cat "$TMP/d.svg"
  } > "$TMP/page.html"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size="$w,$h" --virtual-time-budget=8000 \
    --screenshot="$out" "file://$TMP/page.html" >/dev/null 2>&1
  echo "✓ $out  (${w}x${h} @2x)"
done
