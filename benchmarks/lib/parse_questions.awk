# parse_questions.awk — strict parser for benchmarks/questions.yaml
#
# Why awk: Almagest is "markdown + Claude Code, Node only for the site". A YAML
# library would mean a package manager. awk is POSIX and already installed.
#
# Accepts only the restricted subset documented at the top of questions.yaml.
# Anything else is a hard error on stderr with exit status 1 — the harness must
# fail loudly rather than silently benchmark half a question set.
#
# Output: one TSV record per value.
#     <id> \t <key> \t <value>
# List fields emit one record per element, in order. Empty lists emit nothing.
#
# Run with LC_ALL=C so \uXXXX decoding produces UTF-8 bytes rather than
# locale-dependent characters.

function fail(msg) {
    printf("parse_questions.awk: line %d: %s\n", NR, msg) > "/dev/stderr"
    errors++
    exit 1
}

# Parse a double-quoted scalar starting at position p of s.
# Sets G_val to the unescaped string and G_next to the position just past the
# closing quote. Returns 1 on success, 0 on failure.
function qstring(s, p,    out, c, n, cp, i, hex) {
    if (substr(s, p, 1) != "\"") return 0
    p++
    out = ""
    n = length(s)
    while (p <= n) {
        c = substr(s, p, 1)
        if (c == "\"") { G_val = out; G_next = p + 1; return 1 }
        if (c == "\\") {
            p++
            c = substr(s, p, 1)
            if (c == "n")      out = out "\n"
            else if (c == "t") out = out "\t"
            else if (c == "r") out = out "\r"
            else if (c == "\\") out = out "\\"
            else if (c == "\"") out = out "\""
            else if (c == "/") out = out "/"
            else if (c == "u") {
                hex = substr(s, p + 1, 4)
                cp = 0
                for (i = 1; i <= 4; i++) cp = cp * 16 + hexval(substr(hex, i, 1))
                out = out utf8(cp)
                p += 4
            }
            else out = out c
            p++
            continue
        }
        out = out c
        p++
    }
    return 0
}

function hexval(c) {
    if (c >= "0" && c <= "9") return c + 0
    c = tolower(c)
    if (c == "a") return 10; if (c == "b") return 11; if (c == "c") return 12
    if (c == "d") return 13; if (c == "e") return 14; if (c == "f") return 15
    return 0
}

function utf8(cp) {
    if (cp < 0x80)   return sprintf("%c", cp)
    if (cp < 0x800)  return sprintf("%c%c", 0xC0 + int(cp / 64), 0x80 + (cp % 64))
    return sprintf("%c%c%c", 0xE0 + int(cp / 4096), \
                             0x80 + (int(cp / 64) % 64), 0x80 + (cp % 64))
}

function emit(key, raw,    p, n, c) {
    if (substr(raw, 1, 1) == "\"") {
        if (!qstring(raw, 1)) fail("unterminated quoted scalar for key '" key "'")
        if (trim(substr(raw, G_next)) != "") fail("trailing text after scalar for key '" key "'")
        printf("%s\t%s\t%s\n", cur_id, key, G_val)
        return
    }
    if (substr(raw, 1, 1) == "[") {
        p = 2
        n = length(raw)
        for (;;) {
            while (p <= n && substr(raw, p, 1) ~ /[ \t]/) p++
            c = substr(raw, p, 1)
            if (c == "]") {
                if (trim(substr(raw, p + 1)) != "") fail("trailing text after list for key '" key "'")
                return
            }
            if (c != "\"") fail("list elements must be double-quoted, key '" key "'")
            if (!qstring(raw, p)) fail("unterminated list element for key '" key "'")
            printf("%s\t%s\t%s\n", cur_id, key, G_val)
            p = G_next
            while (p <= n && substr(raw, p, 1) ~ /[ \t]/) p++
            c = substr(raw, p, 1)
            if (c == ",") { p++; continue }
            if (c == "]") {
                if (trim(substr(raw, p + 1)) != "") fail("trailing text after list for key '" key "'")
                return
            }
            fail("expected ',' or ']' in list for key '" key "'")
        }
    }
    fail("value for key '" key "' must be a double-quoted scalar or an inline [\"list\"]")
}

function trim(s) { sub(/^[ \t\r]+/, "", s); sub(/[ \t\r]+$/, "", s); return s }

BEGIN {
    FS = "\n"
    known = "|id|category|question|expected_sources|expected_pages|" \
            "must_contain|must_not_contain|ground_truth|"
    cur_id = ""
    in_questions = 0
    nrec = 0
}

# blank lines and whole-line comments
/^[ \t]*$/            { next }
/^[ \t]*#/            { next }

/^questions:[ \t]*$/  {
    if (in_questions) fail("duplicate 'questions:' key")
    in_questions = 1
    next
}

{
    if (!in_questions) fail("content before 'questions:'")
    line = $0
    sub(/[\r]+$/, "", line)

    # record start:  "  - id: \"...\""
    if (line ~ /^  - id:[ \t]/) {
        raw = trim(substr(line, index(line, ":") + 1))
        if (substr(raw, 1, 1) != "\"") fail("id must be a double-quoted scalar")
        if (!qstring(raw, 1)) fail("unterminated id")
        cur_id = G_val
        if (cur_id == "") fail("empty id")
        if (cur_id in seen) fail("duplicate id '" cur_id "'")
        seen[cur_id] = 1
        nrec++
        printf("%s\tid\t%s\n", cur_id, cur_id)
        next
    }

    if (line ~ /^  - /) fail("a record must start with '  - id: \"...\"'")

    # field:  "    key: value"
    if (line ~ /^    [a-z_]+:[ \t]/) {
        if (cur_id == "") fail("field before any '- id:' record")
        key = line
        sub(/^    /, "", key)
        sub(/:.*$/, "", key)
        if (index(known, "|" key "|") == 0) fail("unknown key '" key "'")
        if (key == "id") fail("'id' may only appear as the record header")
        if ((cur_id SUBSEP key) in fieldseen && \
            key != "expected_sources" && key != "expected_pages" && \
            key != "must_contain" && key != "must_not_contain")
            fail("duplicate key '" key "' in record '" cur_id "'")
        fieldseen[cur_id, key] = 1
        raw = trim(substr(line, index(line, ":") + 1))
        emit(key, raw)
        next
    }

    fail("unparseable line (check indentation: 2 spaces for '- id:', 4 for fields)")
}

END {
    if (errors) exit 1
    if (!in_questions) { print "parse_questions.awk: no 'questions:' key found" > "/dev/stderr"; exit 1 }
    if (nrec == 0)     { print "parse_questions.awk: question set is empty" > "/dev/stderr"; exit 1 }
    # every record must carry the required fields
    req = "category question ground_truth"
    n = split(req, r, " ")
    bad = 0
    for (q in seen)
        for (i = 1; i <= n; i++)
            if (!((q SUBSEP r[i]) in fieldseen)) {
                printf("parse_questions.awk: record '%s' is missing required key '%s'\n", q, r[i]) > "/dev/stderr"
                bad = 1
            }
    if (bad) exit 1
    printf("parse_questions.awk: parsed %d questions\n", nrec) > "/dev/stderr"
}
