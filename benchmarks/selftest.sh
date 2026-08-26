#!/usr/bin/env bash
#
# benchmarks/selftest.sh — verify the harness without spending a cent.
#
# Runs the whole pipeline against benchmarks/drivers/fake.sh, a test double
# that makes no API calls. It checks that the scaffolding works: parsers, arena
# isolation, capture, the driver layer and its capability guards, mechanical
# scoring, report rendering, and every failure branch. It proves nothing about
# answer quality — that is what the real run is for.
#
# Run this after changing anything under benchmarks/.
set -euo pipefail

. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

STUB="$BM_DIR/drivers/fake.sh"
LABEL="selftest"
WORK="$BM_DIR/results/_selftest"
# Throwaway drivers and doctored copies live outside the results root, so the
# "dry run writes nothing" check keeps meaning what it says.
SCRATCH="$(mktemp -d -t almagest-selftest.XXXXXX)"
PASS=0; FAIL=0

check() {
    if eval "$2" >/dev/null 2>&1; then printf '  %s %s\n' "${C_GRN}✓${C_OFF}" "$1"; PASS=$((PASS+1))
    else                               printf '  %s %s\n' "${C_RED}✗${C_OFF}" "$1"; FAIL=$((FAIL+1)); fi
}

cleanup() { rm -rf "$WORK" "$SCRATCH"; }
trap cleanup EXIT
assert_inside_benchmarks "$WORK"
rm -rf "$WORK"; mkdir -p "$WORK"

# Blast-radius baseline, taken before anything runs. The trees the benchmark
# must never touch are compared before against after, which is stricter than
# "must be clean" — it catches a change this selftest made, and is not fooled by
# unrelated edits that were already in the working tree.
snapshot() { git -C "$REPO_DIR" status --porcelain -- "$1" 2>/dev/null || true; }
WIKI_BEFORE="$(snapshot brain/wiki/)"
SITE_BEFORE="$(snapshot site/)"

rule
info "${C_BLD}Almagest benchmark harness — selftest${C_OFF} (no API calls, no cost)"
rule

# ── 1. parsers ───────────────────────────────────────────────────────────────
info "Parsers"
check "questions.yaml parses"            "parse_questions '$DEFAULT_QUESTIONS'"
check "every question has a category"    "test \$(parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"category\"' | wc -l) -eq \$(parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"id\"' | wc -l)"
check "unanswerable questions exist"     "parse_questions '$DEFAULT_QUESTIONS' | grep -q 'unanswerable'"
check "contradiction questions exist"    "parse_questions '$DEFAULT_QUESTIONS' | grep -q 'contradiction'"
check "synthesis questions exist"        "parse_questions '$DEFAULT_QUESTIONS' | grep -q 'synthesis'"
check "malformed yaml is rejected"       "! printf 'questions:\n  - id: bad\n' | awk -f '$LIB_DIR/parse_questions.awk'"
check "poisoned-claim questions exist"   "parse_questions '$DEFAULT_QUESTIONS' | grep -q 'poisoned_claim'"
check "drift question set parses"        "parse_questions '$BM_DIR/questions-drift.yaml'"
check "drift set is drift-only"          "test \$(parse_questions '$BM_DIR/questions-drift.yaml' | awk -F'\t' '\$2==\"category\" && \$3 ~ /^drift/' | wc -l) -eq \$(parse_questions '$BM_DIR/questions-drift.yaml' | awk -F'\t' '\$2==\"id\"' | wc -l)"
check "main set carries no drift question" "! parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"category\" && \$3 ~ /^drift/' | grep -q ."
check "json extractor reads a payload"   "ALM_PROMPT=x '$STUB' run | awk -v raw=result -f '$LIB_DIR/json_scalar.awk' | grep -q 'Gannet'"
check "json extractor rejects non-object" "! echo '[]' | awk -f '$LIB_DIR/json_scalar.awk'"

# Quote, backslash, tab and newline are the four that turn a driver's plain-text
# answer into invalid JSON. Escape them, parse them back, compare bytes.
json_roundtrip() {
    printf 'a"b\\c\td\ne' > "$SCRATCH/esc.in"
    printf '{"r":"%s"}\n' "$(awk -f "$LIB_DIR/json_escape.awk" < "$SCRATCH/esc.in")" > "$SCRATCH/esc.json"
    awk -v raw=r -f "$LIB_DIR/json_scalar.awk" "$SCRATCH/esc.json" > "$SCRATCH/esc.out"
    cmp -s "$SCRATCH/esc.in" "$SCRATCH/esc.out"
}
check "json escaper survives a round trip" "json_roundtrip"

# ── 2. drivers ───────────────────────────────────────────────────────────────
info "Driver layer"
check "fake driver reports capabilities" "test \$('$STUB' capabilities | wc -l) -eq 6"
check "every capability key is present"  "for k in $CAP_KEYS; do '$STUB' capabilities | awk -F'\t' -v k=\$k '\$1==k{f=1} END{exit !f}' || exit 1; done"
check "every capability is yes or no"    "! '$STUB' capabilities | awk -F'\t' '\$2!=\"yes\" && \$2!=\"no\"' | grep -q ."
check "capability overrides work"        "ALMAGEST_STUB_CAPS=structured_output=no '$STUB' capabilities | awk -F'\t' '\$1==\"structured_output\" && \$2==\"no\" {f=1} END{exit !f}'"
check "driver reports a version"         "test -n \"\$('$STUB' version)\""
check "unknown subcommand -> nonzero"    "! '$STUB' banana"
check "shipped drivers all answer capabilities" \
      "for d in '$BM_DIR'/drivers/*.sh; do \$d capabilities | awk -F'\t' 'END{exit (NR<6)}' || exit 1; done"
check "shipped drivers are all executable" \
      "for d in '$BM_DIR'/drivers/*.sh; do test -x \$d || exit 1; done"
check "capability parser rejects a bad driver" \
      "printf '#!/bin/sh\nexit 0\n' > '$SCRATCH/bad.sh' && chmod +x '$SCRATCH/bad.sh' \
       && ! '$BM_DIR/run.sh' --dry-run --driver '$SCRATCH/bad.sh' --out '$WORK'"
check "unknown driver name -> nonzero exit" \
      "! '$BM_DIR/run.sh' --dry-run --driver nosuchdriver --out '$WORK'"

# ── 3. fixtures ──────────────────────────────────────────────────────────────
info "Fixtures"
check "fixture corpus is present"        "check_fixtures"
check "no fixture leaks into brain/raw"  "! ls '$REPO_DIR'/brain/raw/kb-*.md 2>/dev/null | grep -q ."
check "no fixture leaks into brain/wiki" "! ls '$REPO_DIR'/brain/wiki/kestrel*.md 2>/dev/null | grep -q ."
check "planted contradiction present"    "grep -q '2.9 MW' '$FIXTURES_DIR/raw/kb-04-independent-verification-memo.md' && grep -q '3.2 MW' '$FIXTURES_DIR/raw/kb-03-vendor-technical-note.md'"
check "absent topic really is absent"    "! grep -rlqi 'decommissioning cost' '$FIXTURES_DIR/raw/'"
check "every expected_source exists"     "for f in \$(parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"expected_sources\"{print \$3}' | sort -u); do test -f '$FIXTURES_DIR/raw/'\$f || exit 1; done"
check "every expected_page exists"       "for p in \$(parse_questions '$DEFAULT_QUESTIONS' | awk -F'\t' '\$2==\"expected_pages\"{print \$3}' | sort -u); do test -f '$FIXTURES_DIR/wiki/'\$p.md || exit 1; done"
check "drift set expected_sources exist" "for f in \$(parse_questions '$BM_DIR/questions-drift.yaml' | awk -F'\t' '\$2==\"expected_sources\"{print \$3}' | sort -u); do test -f '$FIXTURES_DIR/raw/'\$f || exit 1; done"

# ── schema v2 and the audit ──────────────────────────────────────────────────
# Both fixture wikis are real Almagest wikis, so `tools/audit.mjs` must pass on
# both. A gold wiki that fails the project's own correctness tool is not a gold
# wiki, and a treatment arm reading one is not demonstrating what it claims to.
#
# The fixture is a self-contained brain: `--repo` points at fixtures/, so
# `sources[].path` of `raw/...` resolves, `--brain .` finds fixtures/index.md,
# and `--manifest manifest.yaml` gives PROV-003 and CITE-005 something to check.
# Skipped, not failed, when Node is absent — the harness itself needs no runtime
# and must stay runnable without one.
info "Schema v2 (tools/audit.mjs)"
AUDIT="$REPO_DIR/tools/audit.mjs"
audit_wiki() {
    node "$AUDIT" --repo "$FIXTURES_DIR" --config "$REPO_DIR/brain.config.yaml" \
        --wiki "$1" --brain . --manifest manifest.yaml --no-color
}
if command -v node >/dev/null 2>&1 && [ -f "$AUDIT" ]; then
    check "the gold wiki audits clean"       "audit_wiki wiki"
    check "the poisoned wiki audits clean"   "audit_wiki wiki-poisoned"
    check "no page uses the retired v1 sources form" \
          "! grep -rqE '^  - \"?raw/' '$FIXTURES_DIR/wiki' '$FIXTURES_DIR/wiki-poisoned'"
    check "no page uses the retired prose citation" \
          "! grep -rqE '\\[source: [A-Z]' '$FIXTURES_DIR/wiki' '$FIXTURES_DIR/wiki-poisoned'"
    check "every page declares origin"       "test \$(grep -rl '^origin: ' '$FIXTURES_DIR/wiki'/*.md | wc -l) -eq \$(ls '$FIXTURES_DIR/wiki'/*.md | wc -l)"
else
    printf '  %s %s\n' "${C_YEL}~${C_OFF}" "audit checks skipped — node not on PATH"
fi

# The manifest digests must be the digests of the files on disk, or CITE-005
# is comparing a page against a record that is itself wrong.
manifest_digests_current() {
    local f b want got
    for f in "$FIXTURES_DIR"/raw/*.md; do
        b="$(basename "$f")"
        want="$(awk -v p="raw/$b" '$1=="path:" && $2==p { found=1; next }
                                   found && $1=="sha256:" { print $2; exit }' \
                "$FIXTURES_DIR/manifest.yaml")"
        [ -n "$want" ] || return 1
        got="$(file_sha256 "$f")"
        [ "$got" = "unavailable" ] && return 0
        [ "$want" = "$got" ] || return 1
    done
    return 0
}
# And every page must repeat the manifest digest, which is what CITE-005 asserts.
page_digests_match_manifest() {
    local sha
    for sha in $(grep -ho 'sha256: "[0-9a-f]\{64\}"' "$FIXTURES_DIR"/wiki/*.md "$FIXTURES_DIR"/wiki-poisoned/*.md \
                 | sed 's/.*"\(.*\)"/\1/' | sort -u); do
        grep -q "$sha" "$FIXTURES_DIR/manifest.yaml" || return 1
    done
    return 0
}
check "manifest digests match raw/"      "manifest_digests_current"
check "page digests match the manifest"  "page_digests_match_manifest"
check "the catalog is beside the wiki"   "test -f '$FIXTURES_DIR/index.md' -a ! -e '$FIXTURES_DIR/wiki/index.md'"
check "the catalog lists every page"     "for p in \$(cd '$FIXTURES_DIR/wiki' && ls -1 *.md | sed 's/\.md\$//'); do grep -q \"\\[\\[\$p\\]\\]\" '$FIXTURES_DIR/index.md' || exit 1; done"

# ── the poisoned wiki ────────────────────────────────────────────────────────
# It is only a control if it differs from the gold wiki in EXACTLY the places
# the manifest names and nowhere else. An accidental extra edit would show up as
# a treatment-versus-poisoned difference with no planted error behind it.
info "Poisoned wiki"

# Skip comments, the header row, and blanks. Every remaining row is a planted
# error and must hold in both directions.
poison_rows() {
    awk -F'\t' '$1 ~ /^P[0-9]+$/ { print }' "$FIXTURES_DIR/poison-manifest.tsv"
}
poison_literals_hold() {
    local n=0 id pp op gl pl
    # Re-delimit with US (0x1f) before reading. A TAB in IFS is IFS-whitespace,
    # so `read` collapses a run of them and silently swallows the empty
    # other_pages column — shifting every field after it by one.
    while IFS=$'\037' read -r id pp op gl pl; do
        [ -n "$id" ] || continue
        n=$((n + 1))
        [ -f "$FIXTURES_DIR/wiki/$pp.md" ]          || return 1
        [ -f "$FIXTURES_DIR/wiki-poisoned/$pp.md" ] || return 1
        [ -n "$gl" ] && [ -n "$pl" ]                || return 1
        grep -qF -- "$gl" "$FIXTURES_DIR/wiki/$pp.md"          || return 1   # gold has the truth
        grep -qF -- "$gl" "$FIXTURES_DIR/wiki-poisoned/$pp.md" && return 1   # poisoned does not
        grep -qF -- "$pl" "$FIXTURES_DIR/wiki-poisoned/$pp.md" || return 1   # poisoned has the lie
        grep -qF -- "$pl" "$FIXTURES_DIR/wiki/$pp.md"          && return 1   # gold does not
    done <<POISON
$(poison_rows | awk -F'\t' 'BEGIN { OFS = "\037" } { print $1, $2, $3, $4, $5 }')
POISON
    [ "$n" -gt 0 ]
}
unpoisoned_pages_identical() {
    local named f b
    named="$(poison_rows | awk -F'\t' '{ print $2; if ($3 != "") { n = split($3, a, "|"); for (i = 1; i <= n; i++) print a[i] } }')"
    for f in "$FIXTURES_DIR"/wiki/*.md; do
        b="$(basename "$f" .md)"
        printf '%s\n' "$named" | grep -qx "$b" && continue
        cmp -s "$f" "$FIXTURES_DIR/wiki-poisoned/$b.md" || return 1
    done
    return 0
}
poison_questions_resolve() {
    local pid
    for pid in $(parse_questions "$DEFAULT_QUESTIONS" | awk -F'\t' '$2=="poison_id" { print $3 }' | sort -u); do
        poison_rows | awk -F'\t' -v p="$pid" '$1==p { f=1 } END { exit !f }' || return 1
    done
    return 0
}
check "poisoned wiki is present"         "check_fixture_wiki wiki-poisoned"
check "poisoned wiki has the same pages" \
      "test \"\$(cd '$FIXTURES_DIR/wiki' && ls -1 *.md | sort)\" = \"\$(cd '$FIXTURES_DIR/wiki-poisoned' && ls -1 *.md | sort)\""
check "the manifest has rows"            "test \$(poison_rows | wc -l) -gt 0"
check "every planted error holds, both ways" "poison_literals_hold"
check "unnamed pages are byte-identical" "unpoisoned_pages_identical"
check "every poison_id resolves"         "poison_questions_resolve"
check "the manifest is not in the wiki"  "! test -e '$FIXTURES_DIR/wiki-poisoned/poison-manifest.tsv'"

# ── the drift pair ───────────────────────────────────────────────────────────
info "Drift fixture"
check "drift fixture is present"         "check_fixture_drift"
check "drift file shadows a real source" "test -f '$FIXTURES_DIR/raw/kb-05-grid-connection-agreement.md' -a -f '$FIXTURES_DIR/drift/kb-05-grid-connection-agreement.md'"
check "drift file actually differs"      "! cmp -s '$FIXTURES_DIR/raw/kb-05-grid-connection-agreement.md' '$FIXTURES_DIR/drift/kb-05-grid-connection-agreement.md'"
check "drift file keeps the doc reference" "grep -q 'WGN-CA-4471' '$FIXTURES_DIR/drift/kb-05-grid-connection-agreement.md'"
check "drift file records what it supersedes" "grep -q 'Supersedes' '$FIXTURES_DIR/drift/kb-05-grid-connection-agreement.md'"
check "the wiki is stale against it"     "grep -q '50 MW' '$FIXTURES_DIR/wiki/harrowgate-grid-connection.md' && grep -q '45 MW' '$FIXTURES_DIR/drift/kb-05-grid-connection-agreement.md'"

# ── corpus scale ─────────────────────────────────────────────────────────────
info "Scale generator"
GEN="$FIXTURES_DIR/scale/generate.sh"
gen() { "$GEN" --tier "$1" --seed "$2" --out "$3" --force >/dev/null 2>&1; }
scale_deterministic() {
    gen 20 3 "$SCRATCH/s1" && gen 20 3 "$SCRATCH/s2" && diff -r "$SCRATCH/s1" "$SCRATCH/s2" >/dev/null
}
scale_superset() {
    local f b
    gen 30 3 "$SCRATCH/s3" || return 1
    for f in "$SCRATCH"/s1/dz-*.md; do
        b="$(basename "$f")"
        cmp -s "$f" "$SCRATCH/s3/$b" || return 1
    done
    return 0
}
scale_seed_matters() {
    gen 20 4 "$SCRATCH/s4" || return 1
    ! diff -r "$SCRATCH/s1" "$SCRATCH/s4" >/dev/null 2>&1
}
scale_reals_intact() {
    local f b
    for f in "$FIXTURES_DIR"/raw/*.md; do
        b="$(basename "$f")"
        cmp -s "$f" "$SCRATCH/s3/$b" || return 1
    done
    return 0
}
scale_blocklist_clean() {
    sed 's/#.*//' "$FIXTURES_DIR/scale/blocklist.txt" | sed '/^[[:space:]]*$/d' > "$SCRATCH/terms.txt"
    [ -s "$SCRATCH/terms.txt" ] || return 1
    ! grep -q -i -F -f "$SCRATCH/terms.txt" "$SCRATCH"/s3/dz-*.md
}
check "generator is deterministic"       "scale_deterministic"
check "a larger tier is a superset"      "scale_superset"
check "a different seed is a different corpus" "scale_seed_matters"
check "tier count is exact"              "test \$(ls '$SCRATCH/s3'/*.md | wc -l) -eq 30"
check "the real sources are untouched"   "scale_reals_intact"
check "no distractor trips the blocklist" "scale_blocklist_clean"
check "distractors carry document ids"   "grep -lq 'Document ID' '$SCRATCH/s3'/dz-0001-*.md"
check "a tier below the real corpus is refused" "! '$GEN' --tier 4 --out '$SCRATCH/s5' --force"
check "a non-numeric tier is refused"    "! '$GEN' --tier fifty --out '$SCRATCH/s5' --force"

# ── arm expansion ────────────────────────────────────────────────────────────
# expand_arms calls die(), which exits. Run every failing case in a subshell so
# a rejection does not take the selftest down with it.
info "Arms"
check "both still means the original pair" "test \"\$(expand_arms both)\" = 'baseline treatment'"
check "all means the four main arms"     "test \"\$(expand_arms all)\" = '$MAIN_ARMS'"
check "a comma list expands in order"    "test \"\$(expand_arms treatment,baseline)\" = 'treatment baseline'"
check "an unknown arm is refused"        "! ( expand_arms nosucharm )"
check "a repeated arm is refused"        "! ( expand_arms baseline,baseline )"
check "drift arms are not in any group"  "! expand_arms all | grep -q drift"
check "every arm maps to a prompt file"  "for a in $ALL_ARMS; do test -f '$PROMPTS_DIR/'\$(arm_prompt \$a)'.md' || exit 1; done"
check "poisoned reuses the treatment prompt" "test \"\$(arm_prompt poisoned)\" = treatment"
check "poisoned gets the poisoned wiki"  "test \"\$(arm_wiki poisoned)\" = wiki-poisoned"
check "drift gets the gold wiki"         "test \"\$(arm_wiki drift)\" = wiki"
check "the retrieval arm gets no wiki"   "test -z \"\$(arm_wiki baseline-retrieval)\""
check "the retrieval prompt shows a search" "grep -q 'grep -rn' '$PROMPTS_DIR/baseline-retrieval.md'"

# ── 4. dry run ───────────────────────────────────────────────────────────────
info "Dry run"
check "dry run succeeds and writes nothing" \
      "'$BM_DIR/run.sh' --dry-run --driver '$STUB' --out '$WORK' && test -z \"\$(ls -A '$WORK')\""

# ── 5. end-to-end against the test double ────────────────────────────────────
info "End to end (test double)"
set +e
"$BM_DIR/run.sh" --driver "$STUB" \
    --only q01,q05,q10 --label "$LABEL" --out "$WORK" --yes >/dev/null 2>&1
rc=$?
set -e
check "run.sh completes"                 "test $rc -eq 0"
RUN_DIR="$(ls -d "$WORK"/$LABEL-* 2>/dev/null | head -1)"
check "run directory created"            "test -n '$RUN_DIR' -a -d '$RUN_DIR'"
check "run.env written"                  "test -s '$RUN_DIR/run.env'"
check "run.env records the stub driver"  "grep -q '^driver=fake$' '$RUN_DIR/run.env'"
check "run.env records the driver version" "grep -q '^driver_version=fake-claude' '$RUN_DIR/run.env'"
check "run.env records every capability" "test \$(grep -c '^cap_' '$RUN_DIR/run.env') -eq 6"
check "run.env capability values are yes/no" \
      "! grep '^cap_' '$RUN_DIR/run.env' | grep -vqE '=(yes|no)\$'"
check "run.env bumped harness_version"   "grep -q '^harness_version=3$' '$RUN_DIR/run.env'"
check "run.env records the corpus size"  "grep -q '^corpus_documents=5$' '$RUN_DIR/run.env'"
check "run.env records the scale"        "grep -q '^scale=5$' '$RUN_DIR/run.env'"
check "corpus manifests written"         "test -s '$RUN_DIR/corpus.docids' -a -s '$RUN_DIR/corpus.files'"
check "6 answers captured (3 x 2 arms)"  "test \$(ls '$RUN_DIR'/baseline/*.answer.md '$RUN_DIR'/treatment/*.answer.md | wc -l) -eq 6"
check "latency captured from the payload" "grep -q 'latency_ms	18420' '$RUN_DIR/baseline/q01.meta.tsv'"
check "cost captured from the payload"   "grep -q 'cost_usd	0.0374' '$RUN_DIR/baseline/q01.meta.tsv'"

info "Arena isolation"
check "baseline arena has sources"       "test -d '$RUN_DIR/arena/baseline/sources'"
check "baseline arena has NO wiki"       "! test -e '$RUN_DIR/arena/baseline/wiki'"
check "treatment arena has wiki"         "test -d '$RUN_DIR/arena/treatment/wiki'"
check "treatment arena has the catalog"  "test -f '$RUN_DIR/arena/treatment/index.md'"
check "the catalog is NOT inside wiki/"  "! test -e '$RUN_DIR/arena/treatment/wiki/index.md'"
check "arena is a copy, not a symlink"   "! test -L '$RUN_DIR/arena/treatment/wiki'"
check "arena holds no brain/ content"    "! grep -rlq 'Almagest' '$RUN_DIR/arena/' "

info "Driver guards"
check "every answer records the driver that produced it" \
      "test \$(awk -F'\t' '\$1==\"driver\"' '$RUN_DIR'/baseline/*.meta.tsv '$RUN_DIR'/treatment/*.meta.tsv | grep -c 'fake') -eq 6"
# Both arms of a run must come from the same driver. run.sh cannot produce a
# mixed run on its own; a hand-assembled one must still never be scored.
mixed_run() {
    local d="$WORK/mixed/$(basename "$RUN_DIR")" m
    rm -rf "$WORK/mixed"; mkdir -p "$WORK/mixed"
    cp -R "$RUN_DIR" "$d"
    m="$d/treatment/q01.meta.tsv"
    awk -F'\t' -v OFS='\t' '$1=="driver" { $2="someone-else" } 1' "$m" > "$m.new"
    mv "$m.new" "$m"
    grep -q 'someone-else' "$m" || return 1        # the doctoring itself must work
    if "$BM_DIR/score.sh" --run "$d" > "$WORK/mixed/score.log" 2>&1; then return 1; fi
    grep -q 'same driver' "$WORK/mixed/score.log"
}
check "a mixed-driver run is refused"    "mixed_run"
check "uncapped spend warns and needs --yes" \
      "! ALMAGEST_STUB_CAPS=budget_cap=no '$BM_DIR/run.sh' --driver '$STUB' --only q01 \
          --arm baseline --label 'cap-$LABEL' --out '$WORK' </dev/null"
check "uncapped spend proceeds with --yes" \
      "ALMAGEST_STUB_CAPS=budget_cap=no '$BM_DIR/run.sh' --driver '$STUB' --only q01 \
          --arm baseline --label 'cap-$LABEL' --out '$WORK' --yes </dev/null"

# run.sh narrates to stderr. Capture it to a file rather than piping into
# `grep -q`, which exits on the first match and would SIGPIPE the very run it is
# inspecting — killing it mid-preflight and proving nothing.
unrestricted_tools_warn() {
    ALMAGEST_STUB_CAPS=tool_restriction=no "$BM_DIR/run.sh" --driver "$STUB" --only q01 \
        --arm baseline --label "tools-$LABEL" --out "$WORK" --yes > "$SCRATCH/tools.log" 2>&1 </dev/null || return 1
    grep -q 'NOT comparable' "$SCRATCH/tools.log"
}
deprecated_env_warns() {
    ALMAGEST_BENCH_CLAUDE_BIN="$STUB" "$BM_DIR/run.sh" --only q01 --arm baseline \
        --label "dep-$LABEL" --out "$WORK" --yes > "$SCRATCH/dep.log" 2>&1 </dev/null || return 1
    grep -q 'deprecated' "$SCRATCH/dep.log" && grep -q '^driver=fake$' "$(ls -d "$WORK"/dep-$LABEL-*/run.env | head -1)"
}
check "unrestricted tools warn, loudly"  "unrestricted_tools_warn"
check "a no capability is recorded in run.env" \
      "grep -q '^cap_tool_restriction=no\$' \$(ls -d '$WORK'/tools-$LABEL-*/run.env | head -1)"
check "deprecated ALMAGEST_BENCH_CLAUDE_BIN still runs, with a warning" "deprecated_env_warns"

# ── 6. scoring ───────────────────────────────────────────────────────────────
info "Scoring"
set +e
"$BM_DIR/score.sh" --run "$RUN_DIR" >/dev/null 2>&1
rc=$?
set -e
check "score.sh completes"               "test $rc -eq 0"
MECH="$RUN_DIR/scores-mechanical.tsv"
check "mechanical scores written"        "test -s '$MECH'"
check "broken wikilink detected"         "awk -F'\t' '\$4==\"cited_pages_broken\" && \$5>0' '$MECH' | grep -q ."
check "fabricated doc id detected"       "awk -F'\t' '\$4==\"fabricated_doc_ids\" && \$5>0' '$MECH' | grep -q ."
check "real doc id NOT flagged"          "! grep -q 'MCA-SUR-0014' \$(awk -F'\t' '\$4==\"fabricated_doc_id_list\"{print}' '$MECH' >/dev/null; echo '$MECH')"
check "section precision detected"       "awk -F'\t' '\$4==\"section_precision\" && \$5==1' '$MECH' | grep -q ."
check "synthesis marker detected"        "awk -F'\t' '\$4==\"synthesis_marker\" && \$5==1' '$MECH' | grep -q ."
check "must_contain recall computed"     "awk -F'\t' '\$4==\"must_contain_hits\"' '$MECH' | grep -q ."
check "report written"                   "test -s '$RUN_DIR/report.md'"
check "report marks judge as NOT run"    "grep -q 'Not run' '$RUN_DIR/report.md'"
check "report flags the stub binary"     "grep -q 'stub, not the real CLI' '$RUN_DIR/report.md'"
check "report names the driver"          "grep -q '^| Driver | \`fake\`' '$RUN_DIR/report.md'"
check "report has a comparability block" "grep -q '^## Comparability' '$RUN_DIR/report.md'"
# The not-run judge table must show the SHAPE of the result table and never a
# figure. Arm-count agnostic: every cell is an em-dash, however many arms ran.
check "not-run judge table is all placeholders" \
      "test \$(grep -cE '^\| (Correctness|Fully correct|Citation support|Unsourced claims|Confabulation|Correct declines|Contradictions|Synthesis correctly|Synthesis over-flagged|Compiled-error|Compiled errors)[^|]*(\\| — )+\\|\$' '$RUN_DIR/report.md') -eq 11"
check "report has no numeral in the not-run table" \
      "! grep -E '^\| (Confabulation rate|Correct declines|Contradictions fully|Unsourced claims|Compiled-error propagation|Compiled errors caught)' '$RUN_DIR/report.md' | grep -qE '\\| *[0-9]'"
check "report names the compiled-error metric" \
      "grep -q 'Compiled-error propagation rate' '$RUN_DIR/report.md'"
check "report says no defective wiki ran" \
      "grep -q 'No arm was given a defective wiki' '$RUN_DIR/report.md'"
check "report flags the five-document corpus" \
      "grep -q 'retrieval is not yet a constraint' '$RUN_DIR/report.md'"

# A capability reported `no` must reach the report, not stop at run.env.
set +e
TOOLS_RUN="$(ls -d "$WORK"/tools-$LABEL-* 2>/dev/null | head -1)"
"$BM_DIR/score.sh" --run "$TOOLS_RUN" >/dev/null 2>&1
set -e
check "comparability block names the missing capability" \
      "grep -q '\`tool_restriction\` = no' '$TOOLS_RUN/report.md'"

info "Judge (test double)"
set +e
ALMAGEST_STUB_MODE=verdict \
    "$BM_DIR/score.sh" --run "$RUN_DIR" --driver "$STUB" --judge --yes >/dev/null 2>&1
rc=$?
set -e
check "judge pass completes"             "test $rc -eq 0"
check "judge scores written"             "test -s '$RUN_DIR/scores-judge.tsv'"
check "judge verdict parsed"             "grep -q 'judge_correctness' '$RUN_DIR/scores-judge.tsv'"
check "report now shows judge metrics"   "grep -q 'Correctness (mean' '$RUN_DIR/report.md'"
set +e
ALMAGEST_STUB_CAPS=structured_output=no "$BM_DIR/score.sh" --run "$RUN_DIR" \
    --driver "$STUB" --judge --yes > "$SCRATCH/refuse.log" 2>&1
rc=$?
set -e
check "judge refuses a driver without structured output" "test $rc -ne 0"
check "the refusal says which capability is missing" \
      "grep -q 'structured_output=no' '$SCRATCH/refuse.log'"
check "the refusal names a driver that can judge" \
      "grep -q 'claude-code' '$SCRATCH/refuse.log'"
check "the refusal spends nothing"       "! grep -q 'judging ' '$SCRATCH/refuse.log'"

# ── 6b. the added arms, end to end ───────────────────────────────────────────
info "Added arms (test double)"
set +e
"$BM_DIR/run.sh" --driver "$STUB" --only q01,q16 \
    --arm baseline-retrieval,treatment,poisoned \
    --label "multi-$LABEL" --out "$WORK" --yes >/dev/null 2>&1
rc=$?
set -e
check "a three-arm run completes"        "test $rc -eq 0"
MULTI="$(ls -d "$WORK"/multi-$LABEL-* 2>/dev/null | head -1)"
check "6 answers captured (2 x 3 arms)" \
      "test \$(ls '$MULTI'/baseline-retrieval/*.answer.md '$MULTI'/treatment/*.answer.md '$MULTI'/poisoned/*.answer.md | wc -l) -eq 6"
check "run.env lists all three arms"     "grep -q '^arms=baseline-retrieval treatment poisoned\$' '$MULTI/run.env'"
check "the retrieval arm has no wiki"    "! test -e '$MULTI/arena/baseline-retrieval/wiki'"
check "the poisoned arm has a wiki"      "test -f '$MULTI/arena/poisoned/wiki/kestrel-basin-tidal-array.md'"
check "the poisoned arm has the catalog" "test -f '$MULTI/arena/poisoned/index.md'"
check "no manifest reached an arena"     "! find '$MULTI/arena' -name 'manifest.yaml' | grep -q ."
check "the poisoned arena carries the planted error" \
      "grep -q 'maximum recorded 4.6 m on 2027-02-19' '$MULTI/arena/poisoned/wiki/gannet-narrows-site-conditions.md'"
check "the treatment arena carries the truth" \
      "grep -q 'maximum recorded 3.9 m on 2027-02-19' '$MULTI/arena/treatment/wiki/gannet-narrows-site-conditions.md'"
check "no poison manifest reached an arena" \
      "! find '$MULTI/arena' -name 'poison-manifest.tsv' | grep -q ."
set +e
"$BM_DIR/score.sh" --run "$MULTI" >/dev/null 2>&1
rc=$?
set -e
check "a three-arm run scores"           "test $rc -eq 0"
check "the report has three arm columns" "grep -q '^| Metric | baseline-retrieval | treatment | poisoned |\$' '$MULTI/report.md'"
check "the advisory poison rows are computed" \
      "awk -F'\t' '\$4==\"poison_false_present\"' '$MULTI/scores-mechanical.tsv' | grep -q ."
check "the advisory rows are labelled advisory" \
      "grep -q 'Neither is a propagation rate' '$MULTI/report.md'"

# ── 6c. corpus scale, end to end ─────────────────────────────────────────────
info "Scaled corpus (test double)"
set +e
"$BM_DIR/run.sh" --driver "$STUB" --only q01 --arm baseline --scale 12 --scale-seed 3 \
    --label "scale-$LABEL" --out "$WORK" --yes >/dev/null 2>&1
rc=$?
set -e
check "a scaled run completes"           "test $rc -eq 0"
SCALED="$(ls -d "$WORK"/scale-$LABEL-* 2>/dev/null | head -1)"
check "the arena holds the padded corpus" "test \$(ls '$SCALED'/arena/baseline/sources/*.md | wc -l) -eq 12"
check "run.env records scale and seed"   "grep -q '^scale=12\$' '$SCALED/run.env' && grep -q '^scale_seed=3\$' '$SCALED/run.env'"
check "the corpus manifest covers the padding" "test \$(wc -l < '$SCALED/corpus.files') -eq 12"
set +e
"$BM_DIR/score.sh" --run "$SCALED" >/dev/null 2>&1
rc=$?
set -e
check "a scaled run scores"              "test $rc -eq 0"
check "a distractor id is NOT fabricated" \
      "test \$(awk -F'\t' '\$4==\"fabricated_doc_ids\"' '$SCALED/scores-mechanical.tsv' | wc -l) -gt 0"
check "the report warns about the padding" \
      "grep -q 'generated distractors' '$SCALED/report.md'"
check "the report says retrieval pressure, not breadth" \
      "grep -q 'retrieval pressure' '$SCALED/report.md'"

# ── 6d. drift, end to end ────────────────────────────────────────────────────
info "Drift arms (test double)"
check "a drift arm needs the drift question set" \
      "! '$BM_DIR/run.sh' --dry-run --driver '$STUB' --arm drift --out '$WORK'"
check "the drift question set needs a drift arm" \
      "! '$BM_DIR/run.sh' --dry-run --driver '$STUB' --questions '$BM_DIR/questions-drift.yaml' --arm baseline --out '$WORK'"
set +e
"$BM_DIR/run.sh" --driver "$STUB" --questions "$BM_DIR/questions-drift.yaml" \
    --only d01 --arm drift,drift-baseline \
    --label "drift-$LABEL" --out "$WORK" --yes >/dev/null 2>&1
rc=$?
set -e
check "the matched pair runs"            "test $rc -eq 0"
DRIFTRUN="$(ls -d "$WORK"/drift-$LABEL-* 2>/dev/null | head -1)"
check "the drift arena has the amended source" \
      "cmp -s '$FIXTURES_DIR/drift/kb-05-grid-connection-agreement.md' '$DRIFTRUN/arena/drift/sources/kb-05-grid-connection-agreement.md'"
check "the amended source replaced the original, same filename" \
      "! cmp -s '$FIXTURES_DIR/raw/kb-05-grid-connection-agreement.md' '$DRIFTRUN/arena/drift/sources/kb-05-grid-connection-agreement.md'"
check "the drift arm has the stale wiki"  "grep -q '50 MW' '$DRIFTRUN/arena/drift/wiki/harrowgate-grid-connection.md'"
check "the drift control has no wiki"     "! test -e '$DRIFTRUN/arena/drift-baseline/wiki'"
check "the drift control has no catalog"  "! test -e '$DRIFTRUN/arena/drift-baseline/index.md'"
check "the drift corpus is still 5 documents" \
      "test \$(ls '$DRIFTRUN'/arena/drift/sources/*.md | wc -l) -eq 5"
set +e
"$BM_DIR/score.sh" --run "$DRIFTRUN" --questions "$BM_DIR/questions-drift.yaml" >/dev/null 2>&1
rc=$?
set -e
check "a drift run scores"               "test $rc -eq 0"
check "the drift report names both arms" "grep -q '^| Metric | drift-baseline | drift |\$' '$DRIFTRUN/report.md'"

# ── 7. failure branches ──────────────────────────────────────────────────────
info "Failure branches (each must fail loudly, not silently)"
run_stub() {
    set +e
    ALMAGEST_STUB_MODE="$1" "$BM_DIR/run.sh" --driver "$STUB" \
        --only q01 --arm baseline --label "fail-$1" --out "$WORK" --yes >/dev/null 2>&1
    local r=$?; set -e; return $r
}
check "empty answer -> nonzero exit"     "! run_stub empty"
check "malformed json -> nonzero exit"   "! run_stub malformed"
check "cli failure -> nonzero exit"      "! run_stub error"
check "bad --only id -> nonzero exit"    "! '$BM_DIR/run.sh' --dry-run --only nosuch --out '$WORK'"
check "bad --arm -> nonzero exit"        "! '$BM_DIR/run.sh' --dry-run --arm sideways --out '$WORK'"
check "missing --run -> nonzero exit"    "! '$BM_DIR/score.sh'"
check "unknown run dir -> nonzero exit"  "! '$BM_DIR/score.sh' --run nope --out '$WORK'"
check "score.sh accepts a relative path" "( cd '$REPO_DIR' && '$BM_DIR/score.sh' --run \"\${RUN_DIR#$REPO_DIR/}\" >/dev/null )"
check "unattended run without --yes fails" \
      "! '$BM_DIR/run.sh' --driver '$STUB' --only q01 --arm baseline --out '$WORK' </dev/null"

# ── 8. nothing outside benchmarks/ was touched ───────────────────────────────
info "Blast radius"
# Scoped to files the benchmark could plausibly have created. A blanket
# "git status is clean" check would break in a repo with unrelated edits.
check "no fixture source escaped benchmarks/" \
      "test -z \"\$(find '$REPO_DIR' -name 'kb-0*-*.md' -not -path '*/benchmarks/*' 2>/dev/null)\""
check "no fixture wiki page escaped benchmarks/" \
      "test -z \"\$(find '$REPO_DIR' -name 'kestrel-basin-tidal-array.md' -o -name 'vm-320-turbine.md' | grep -v '/benchmarks/' 2>/dev/null)\""
check "no results directory outside benchmarks/" \
      "test -z \"\$(find '$REPO_DIR' -type d -name 'arena' -not -path '*/benchmarks/*' 2>/dev/null)\""
check "brain/wiki gained no pages"       "test \"\$(snapshot brain/wiki/)\" = \"\$WIKI_BEFORE\""
check "site/ untouched"                  "test \"\$(snapshot site/)\" = \"\$SITE_BEFORE\""

rule
if [ "$FAIL" -eq 0 ]; then
    ok "selftest passed — $PASS check(s), no API calls, no cost"
    rule
    exit 0
fi
printf '%s\n' "${C_RED}✗ selftest FAILED — $FAIL of $((PASS+FAIL)) check(s)${C_OFF}" >&2
rule
exit 1
