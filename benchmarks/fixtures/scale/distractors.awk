# distractors.awk — generate N deterministic distractor documents.
#
# Called by fixtures/scale/generate.sh. Reads nothing; writes one file per
# document into `outdir`.
#
# Variables (-v):
#   outdir   directory to write into (must exist)
#   n        how many documents to write
#   seed     integer seed
#
# DETERMINISM IS THE WHOLE POINT, and it is not free in awk:
#
#   * rand()/srand() are NOT portable — mawk, gawk, and BSD awk disagree on the
#     generator. This file carries its own MINSTD LCG instead.
#   * The multiplier is 16807 because awk numbers are doubles: 16807 x 2^31 is
#     about 3.6e13, comfortably inside the 2^53 where integer arithmetic is
#     exact. A textbook LCG multiplier like 1103515245 is not, and would round.
#   * `for (k in arr)` order is unspecified, so nothing here iterates an array.
#   * Each document is seeded from (seed, index) alone, never from a running
#     stream. That makes tier 500 a strict superset of tier 50 under the same
#     seed — the first 45 documents are byte-identical — so scaling up does not
#     resample the small corpus into a different one.
#
# Nothing generated here answers any benchmark question. The vocabulary is
# disjoint from the fixture corpus by construction, and generate.sh greps the
# output against fixtures/scale/blocklist.txt before it will hand the corpus over.

function rnd() { S = (S * 16807) % 2147483647; return S }
function rint(lo, hi) { return lo + rnd() % (hi - lo + 1) }
function pick(arr, cnt) { return arr[rint(1, cnt)] }

# One decimal place, without printf rounding surprises.
function dec1(lo, hi,   v) { v = rint(lo * 10, hi * 10); return sprintf("%d.%d", int(v / 10), v % 10) }

BEGIN {
    nbody = split("Cawdale Harbour Board|Pellrick Dock Company|Estall Navigation Trust|Brantmoor Port Authority|Quillhaven Marine Works|Ordsley Waterways Board|Ferndyke Pilotage Service|Torvale Coastal Trust", body, "|")
    split("CHB|PDC|ENT|BPA|QMW|OWB|FPS|TCT", bpfx, "|")

    nkind = split("NAV|DRG|BTH|PIL|SED|QAY|MOR|SLP|TAR|CHR", kind, "|")
    split("Navigation Aid Maintenance Return|Dredging Licence Condition Schedule|Berth Occupancy Statement|Pilotage Tariff Notice|Sediment Sampling Log|Quay Inspection Record|Mooring Buoy Certification|Slipway Repair Works Order|Tariff Amendment Notice|Vessel Charter Note", kindname, "|")

    nsite = split("Bellamy Reach|Cotterill Sands|Draymoor Cut|Elverdon Spit|Fallowmere Bank|Girsby Hard|Hollingate Bight|Idlewell Flats|Jarrowby Roads|Kelmscar Ledge|Larkhope Bar|Middlecote Pool", site, "|")
    split("bellamy-reach|cotterill-sands|draymoor-cut|elverdon-spit|fallowmere-bank|girsby-hard|hollingate-bight|idlewell-flats|jarrowby-roads|kelmscar-ledge|larkhope-bar|middlecote-pool", siteslug, "|")

    nstatus = split("Issued|Final|For information|Superseded on reissue|Current", status, "|")
    nunit   = split("Vessel|Craft|Barge|Tender|Launch", unit, "|")
    ncond   = split("Fair|Serviceable|Degraded|Monitored|Under repair", cond, "|")

    for (d = 1; d <= n; d++) {
        # Seed from (seed, index) only. Warm the state so neighbouring indices
        # do not produce visibly neighbouring documents.
        S = ((seed % 100000) * 7919 + d * 104729) % 2147483647
        if (S <= 0) S += 2147483646
        rnd(); rnd(); rnd()

        bi = rint(1, nbody)
        ki = rint(1, nkind)
        si = rint(1, nsite)

        docid = sprintf("%s-%s-%04d", bpfx[bi], kind[ki], rint(1000, 9999))
        yy = 2025 + rint(0, 4)
        mm = rint(1, 12)
        dd = rint(1, 28)
        date = sprintf("%04d-%02d-%02d", yy, mm, dd)

        f = sprintf("%s/dz-%04d-%s-%s.md", outdir, d, siteslug[si], tolower(kind[ki]))

        printf("# %s — %s\n\n", site[si], kindname[ki])                                     > f
        printf("**Document ID:** %s\n", docid)                                              > f
        printf("**Issued by:** %s\n", body[bi])                                             > f
        printf("**Date:** %s\n", date)                                                      > f
        printf("**Status:** %s\n\n", pick(status, nstatus))                                 > f
        printf("---\n\n")                                                                   > f

        printf("## §1 Scope\n\n")                                                           > f
        printf("This %s records the position at %s as at %s. It is issued by %s\n",
               tolower(kindname[ki]), site[si], date, body[bi])                             > f
        printf("under its own standing instructions and applies to that location only.\n")  > f
        printf("It supersedes no other issue.\n\n")                                         > f

        printf("## §2 Recorded values\n\n")                                                 > f
        printf("| Item | Value |\n|------|-------|\n")                                      > f
        printf("| Charted depth at datum | %s m |\n", dec1(2, 19))                          > f
        printf("| Channel width at narrowest | %d m |\n", rint(40, 320))                    > f
        printf("| Maximum draught permitted | %s m |\n", dec1(1, 9))                        > f
        printf("| Survey interval | %d months |\n", rint(6, 60))                            > f
        printf("| Reference mark | %s-%d |\n\n", kind[ki], rint(10, 99))                    > f

        printf("## §3 Movements and condition\n\n")                                         > f
        printf("| Reference | Class | Condition | Last attended |\n")                       > f
        printf("|-----------|-------|-----------|---------------|\n")                       > f
        for (r = 1; r <= 4; r++)
            printf("| %s %02d | %s | %s | %04d-%02d-%02d |\n",
                   pick(unit, nunit), rint(1, 99), kind[ki], pick(cond, ncond),
                   2025 + rint(0, 4), rint(1, 12), rint(1, 28))                             > f
        printf("\n")                                                                        > f

        printf("## §4 Conditions attached\n\n")                                             > f
        printf("- Attendance is required within %d working days of a reported defect.\n",
               rint(2, 30))                                                                 > f
        printf("- Charges are levied per movement at the rate current on the date of\n")    > f
        printf("  movement and are not reproduced here.\n")                                 > f
        printf("- %s retains the right to withdraw the permission on %d days notice.\n\n",
               body[bi], rint(7, 90))                                                       > f

        printf("## §5 Limitations\n\n")                                                     > f
        printf("This document addresses %s only. It makes no statement about generation\n",
               site[si])                                                                    > f
        printf("plant, network arrangements, programme schedule, or any other location.\n") > f

        close(f)
    }
}
