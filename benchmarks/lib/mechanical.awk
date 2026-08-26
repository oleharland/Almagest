# mechanical.awk — the checks that need no judge.
#
# Reads one answer file. Emits `key<TAB>value` lines.
#
# Variables (-v):
#   known_docs   space-separated list of document IDs that exist in the corpus
#   known_files  space-separated list of source filenames that exist
#   known_pages  space-separated list of wiki slugs that exist
#   exp_sources  space-separated expected source filenames for this question
#   exp_docs     space-separated expected document IDs for this question
#   must         newline-separated must_contain strings (via -v is awkward, so
#                these are passed as files instead — see score.sh)
#   docid_re     regex matching a document-ID-shaped token
#
# Everything here is a syntactic check on the answer text. None of it can tell
# you whether the answer is TRUE — that is the judge's job, and the split is
# deliberate: these numbers are reproducible and free, the judge's are neither.

function has(list, item) { return index(" " list " ", " " item " ") > 0 }

BEGIN { body = "" }
{ body = body $0 "\n" }

END {
    lower = tolower(body)

    # ── wikilink citations — unambiguous syntax, exact resolution ────────────
    npage = 0; nbadpage = 0
    tmp = body
    while (match(tmp, /\[\[[A-Za-z0-9_.-]+\]\]/)) {
        slug = substr(tmp, RSTART + 2, RLENGTH - 4)
        tmp = substr(tmp, RSTART + RLENGTH)
        if (!(slug in seenpage)) {
            seenpage[slug] = 1
            npage++
            if (!has(known_pages, slug)) { nbadpage++; badpages = badpages " " slug }
        }
    }

    # ── document-ID citations ───────────────────────────────────────────────
    # A tight pattern. Anything matching it that is NOT in the corpus is a
    # fabricated document reference — the cheapest hallucination signal there is.
    ndoc = 0; nbaddoc = 0
    tmp = body
    while (match(tmp, docid_re)) {
        d = substr(tmp, RSTART, RLENGTH)
        tmp = substr(tmp, RSTART + RLENGTH)
        if (!(d in seendoc)) {
            seendoc[d] = 1
            ndoc++
            if (!has(known_docs, d)) { nbaddoc++; baddocs = baddocs " " d }
        }
    }

    # ── filename citations ──────────────────────────────────────────────────
    nfile = 0
    n = split(known_files, kf, " ")
    for (i = 1; i <= n; i++)
        if (kf[i] != "" && index(body, kf[i]) > 0) { nfile++; seenfile[kf[i]] = 1 }

    # ── expected-source coverage ────────────────────────────────────────────
    # A source counts as cited if its filename OR its document ID appears.
    ncov = 0; nexp = 0
    n = split(exp_sources, es, " ")
    m = split(exp_docs, ed, " ")
    for (i = 1; i <= n; i++) {
        if (es[i] == "") continue
        nexp++
        if ((es[i] in seenfile) || (i <= m && ed[i] != "" && (ed[i] in seendoc))) ncov++
    }

    # ── section-level precision ─────────────────────────────────────────────
    # Proxy only. It sees that a section was named, not that it is the right one.
    prec = (body ~ /§/ || lower ~ /section [0-9]/ || lower ~ /sec\. ?[0-9]/) ? 1 : 0

    # ── synthesis marker ────────────────────────────────────────────────────
    syn = (lower ~ /synthesi[sz]ed from/) ? 1 : 0

    # ── any citation at all ─────────────────────────────────────────────────
    anycite = (npage > 0 || ndoc > 0 || nfile > 0) ? 1 : 0

    printf("cited_pages\t%d\n",            npage)
    printf("cited_pages_broken\t%d\n",     nbadpage)
    printf("broken_page_slugs\t%s\n",      trim(badpages))
    printf("cited_doc_ids\t%d\n",          ndoc)
    printf("fabricated_doc_ids\t%d\n",     nbaddoc)
    printf("fabricated_doc_id_list\t%s\n", trim(baddocs))
    printf("cited_filenames\t%d\n",        nfile)
    printf("expected_sources_total\t%d\n", nexp)
    printf("expected_sources_cited\t%d\n", ncov)
    printf("section_precision\t%d\n",      prec)
    printf("synthesis_marker\t%d\n",       syn)
    printf("has_citation\t%d\n",           anycite)
    printf("answer_chars\t%d\n",           length(body))
}

function trim(s) { sub(/^ +/, "", s); sub(/ +$/, "", s); return s }
