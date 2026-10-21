#!/usr/bin/env bash
# Clone (or update) the brain repo, then hand off to the almagest CLI.
set -euo pipefail

repo="${ALMAGEST_REPO:-/data/repo}"
if [ ! -d "$repo/.git" ]; then
  : "${ALMAGEST_GIT_URL:?set ALMAGEST_GIT_URL, or mount a repo at $repo}"
  git clone --quiet "$ALMAGEST_GIT_URL" "$repo"
fi
git -C "$repo" config user.name  "${ALMAGEST_GIT_NAME:-Almagest}"
git -C "$repo" config user.email "${ALMAGEST_GIT_EMAIL:-almagest@localhost}"
# The audit and main-guard hooks: copied from main as committed into
# .git/almagest/hooks/ (where a checkout cannot swap them) and core.hooksPath
# pointed there. A brain whose main predates `hooks install` starts without
# them — `almagest doctor` says so; the service's own merge re-audits anyway.
node /opt/almagest/server/bin/almagest.mjs --repo "$repo" hooks install \
  || echo "almagest: git hooks not installed (see above) — merge the current tools/hooks/ into main" >&2

# The service binds 127.0.0.1 by default; inside a container it must listen on
# all interfaces for the port mapping to reach it.
export ALMAGEST_HTTP_HOST="${ALMAGEST_HTTP_HOST:-0.0.0.0}"

# Tools come from the image, the brain from the volume: the audit that gates a
# commit is never a copy the ingest agent could have edited.
exec node /opt/almagest/server/bin/almagest.mjs --repo "$repo" "$@"
