# json_escape.awk — escape stdin into the body of a JSON string.
#
# The inverse of json_scalar.awk, and for the same reason: a driver that has to
# wrap a CLI's plain-text output in JSON needs an encoder, and jq is exactly the
# package dependency this harness is not allowed to add.
#
# Reads arbitrary text on stdin. Emits one line: the input with every character
# JSON has an opinion about escaped, and newlines turned into \n. The caller
# supplies the surrounding quotes:
#
#     printf '{"result":"%s"}\n' "$(awk -f json_escape.awk < out.txt)"
#
# Run with LC_ALL=C. Bytes in, bytes out — UTF-8 passes through untouched,
# because JSON strings may carry raw UTF-8 and re-encoding it would be a way to
# corrupt an answer silently.

BEGIN {
    ORS = ""
    # Control characters have no shorthand and must go out as \u00XX.
    for (i = 0; i < 32; i++) ctl[sprintf("%c", i)] = sprintf("\\u%04x", i)
    ctl[sprintf("%c", 8)]  = "\\b"
    ctl[sprintf("%c", 9)]  = "\\t"
    ctl[sprintf("%c", 12)] = "\\f"
    ctl[sprintf("%c", 13)] = "\\r"
    ctl[sprintf("%c", 127)] = "\\u007f"
}

{
    if (NR > 1) printf("\\n")
    printf("%s", esc($0))
}

END { printf("\n") }

function esc(s,   out, i, n, c) {
    n = length(s)
    out = ""
    for (i = 1; i <= n; i++) {
        c = substr(s, i, 1)
        if      (c == "\\") out = out "\\\\"
        else if (c == "\"") out = out "\\\""
        else if (c in ctl)  out = out ctl[c]
        else                out = out c
    }
    return out
}
