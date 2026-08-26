# json_scalar.awk — extract top-level scalar fields from a single JSON object.
#
# Why not jq: jq is not guaranteed present, and installing it would be exactly
# the package dependency this harness is not allowed to add. awk is POSIX.
#
# Reads one JSON object on stdin. Emits, for each top-level key whose value is a
# string, number, boolean, or null:
#     <key> \t <value>
# Strings are unescaped and newlines inside them are replaced with \n literals
# so each record stays on one line — callers that need the real text (the model
# answer) use -v raw=<key> instead, which prints that key's value verbatim and
# nothing else.
#
# Nested objects and arrays are skipped, not descended into. That is deliberate:
# the fields the harness needs (result, is_error, duration_ms, total_cost_usd,
# num_turns, session_id, subtype) are all top level.
#
# Exit 1 if the input is not a JSON object, or if -v raw=<key> names a key that
# is absent. Callers depend on that: a silent empty answer must not be scorable.
#
# Run with LC_ALL=C.

function fail(msg) {
    printf("json_scalar.awk: %s\n", msg) > "/dev/stderr"
    bad = 1
    exit 1
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
    if (cp < 0x10000) return sprintf("%c%c%c", 0xE0 + int(cp / 4096), \
                                     0x80 + (int(cp / 64) % 64), 0x80 + (cp % 64))
    return sprintf("%c%c%c%c", 0xF0 + int(cp / 262144), \
                   0x80 + (int(cp / 4096) % 64), \
                   0x80 + (int(cp / 64) % 64), 0x80 + (cp % 64))
}

function skipws() { while (p <= n && substr(s, p, 1) ~ /[ \t\r\n]/) p++ }

# parse a string starting at p (which must point at the opening quote)
function pstring(    out, c, cp, i, hex, lo) {
    if (substr(s, p, 1) != "\"") fail("expected string at offset " p)
    p++
    out = ""
    while (p <= n) {
        c = substr(s, p, 1)
        if (c == "\"") { p++; return out }
        if (c == "\\") {
            p++
            c = substr(s, p, 1)
            if (c == "n")       out = out "\n"
            else if (c == "t")  out = out "\t"
            else if (c == "r")  out = out "\r"
            else if (c == "b")  out = out sprintf("%c", 8)
            else if (c == "f")  out = out sprintf("%c", 12)
            else if (c == "\\") out = out "\\"
            else if (c == "\"") out = out "\""
            else if (c == "/")  out = out "/"
            else if (c == "u") {
                hex = substr(s, p + 1, 4)
                cp = 0
                for (i = 1; i <= 4; i++) cp = cp * 16 + hexval(substr(hex, i, 1))
                p += 4
                # surrogate pair
                if (cp >= 0xD800 && cp <= 0xDBFF && substr(s, p + 1, 2) == "\\u") {
                    hex = substr(s, p + 3, 4)
                    lo = 0
                    for (i = 1; i <= 4; i++) lo = lo * 16 + hexval(substr(hex, i, 1))
                    if (lo >= 0xDC00 && lo <= 0xDFFF) {
                        cp = 0x10000 + (cp - 0xD800) * 1024 + (lo - 0xDC00)
                        p += 6
                    }
                }
                out = out utf8(cp)
            }
            else out = out c
            p++
            continue
        }
        out = out c
        p++
    }
    fail("unterminated string")
}

# skip a balanced {...} or [...] starting at p
function pskip(    depth, c, instr) {
    depth = 0
    instr = 0
    while (p <= n) {
        c = substr(s, p, 1)
        if (instr) {
            if (c == "\\") p++
            else if (c == "\"") instr = 0
        } else {
            if (c == "\"") instr = 1
            else if (c == "{" || c == "[") depth++
            else if (c == "}" || c == "]") { depth--; if (depth == 0) { p++; return } }
        }
        p++
    }
    fail("unbalanced container")
}

# read a bare literal (number, true, false, null) at p
function pliteral(    start, c) {
    start = p
    while (p <= n) {
        c = substr(s, p, 1)
        if (c == "," || c == "}" || c ~ /[ \t\r\n]/) break
        p++
    }
    return substr(s, start, p - start)
}

{ s = s $0 "\n" }

END {
    if (bad) exit 1
    n = length(s)
    p = 1
    skipws()
    if (substr(s, p, 1) != "{") fail("input is not a JSON object")
    p++
    for (;;) {
        skipws()
        if (p > n) fail("unexpected end of input")
        if (substr(s, p, 1) == "}") break
        key = pstring()
        skipws()
        if (substr(s, p, 1) != ":") fail("expected ':' after key '" key "'")
        p++
        skipws()
        c = substr(s, p, 1)
        if (c == "\"") {
            val = pstring()
            store(key, val)
        } else if (c == "{" || c == "[") {
            pskip()
        } else {
            store(key, pliteral())
        }
        skipws()
        if (substr(s, p, 1) == ",") { p++; continue }
        if (substr(s, p, 1) == "}") break
        fail("expected ',' or '}' after value for key '" key "'")
    }

    if (raw != "") {
        if (!(raw in vals)) fail("key '" raw "' not present in JSON object")
        printf("%s", vals[raw])
        exit 0
    }
    for (i = 1; i <= nkeys; i++) {
        k = order[i]
        v = vals[k]
        gsub(/\\/, "\\\\", v)
        gsub(/\n/, "\\n", v)
        gsub(/\t/, "\\t", v)
        gsub(/\r/, "", v)
        printf("%s\t%s\n", k, v)
    }
}

function store(k, v) {
    if (!(k in vals)) { nkeys++; order[nkeys] = k }
    vals[k] = v
}
