#!/usr/bin/env python3
"""Check the built station table before it is published.

Usage:
  python3 verify.py            # check docs/data/, exit non-zero on any error
  python3 verify.py --quiet    # print only failures

Findings come at two levels. An ERROR means the data is wrong and must not be
published -- the nightly workflow stops on it and leaves the previous build
serving. A WARN means something worth a look that is not in itself a reason to
withhold a build, usually a handful of odd records among tens of thousands.

The checks fall into four groups:

  Structural   the table is well formed -- unique ids, no missing fields,
               numbers that parse, coordinates in range.
  Physical     the values are possible for a broadcast station -- a frequency
               on the channel grid, a power the service is allowed.
  Geographic   the coordinates agree with the country the record claims.
  External     the totals agree with the FCC's own published station counts,
               which are compiled separately from the queries this reads and
               so are a genuinely independent check.
  Continuity   this build resembles the last one. A collapse in the count is
               far more likely to be a bad fetch than a real event.
"""
import argparse
import csv
import json
import os
import sys
from datetime import date, datetime

import fcc

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "docs", "data")

# The FCC's own Broadcast Station Totals, published quarterly by the Media
# Bureau and compiled independently of the AM and FM queries. Updated by hand
# when a new release comes out -- the release is prose, not a data feed.
#
#   https://www.fcc.gov/document/broadcast-station-totals-march-31-2026
FCC_TOTALS = {
    "as_of": "2026-03-31",
    "AM": 4310,
    "FM": 11357,          # 6,574 commercial + 4,783 educational
    "FX+FB": 8854,        # the FCC counts translators and boosters together
    "FL": 2007,
}
# How far from the published totals a service may drift before it is a finding.
# The counts genuinely move between the FCC's quarterly release and any given
# night -- AM has been shedding stations for years and translators growing --
# so this is wide enough to allow real drift and narrow enough to catch a
# service that failed to download.
TOTALS_TOLERANCE = 0.05

# A build that loses this fraction of its stations is assumed to be a failed
# fetch rather than an event in the world.
CONTINUITY_TOLERANCE = 0.05

# Rough bounding boxes, deliberately generous. These catch a sign error or a
# transposed pair, not a station a few km over a line.
BOXES = {
    "US": [(24.0, 49.5, -125.0, -66.5),     # contiguous
           (51.0, 72.0, -180.0, -129.0),    # Alaska
           (18.5, 22.5, -161.0, -154.5),    # Hawaii
           (17.5, 18.6, -68.0, -64.5),      # Puerto Rico, USVI
           (13.2, 20.6, 144.5, 146.2),      # Guam, Northern Marianas
           (-14.6, -11.0, -171.5, -168.0)], # American Samoa
    "CA": [(41.5, 84.0, -142.0, -52.0)],
    "MX": [(14.0, 33.0, -119.0, -86.0)],
}

# US territories in ITU Region 3, where the AM band is spaced every 9 kHz.
REGION_3 = {"GU", "MP"}

# Class letters are national, not universal. Canada uses A1 alongside the
# shared letters and Mexico uses AA; neither exists in the US system.
FM_CLASSES = {"A", "B", "B1", "C", "C0", "C1", "C2", "C3", "D", "LP1", "LP2", ""}
FM_CLASSES_BY_COUNTRY = {
    "CA": FM_CLASSES | {"A1"},
    "MX": FM_CLASSES | {"AA"},
}
AM_CLASSES = {"A", "B", "C", "D", ""}

findings = []


def error(check, message, sample=None):
    findings.append(("ERROR", check, message, sample or []))


def warn(check, message, sample=None):
    findings.append(("WARN", check, message, sample or []))


# ------------------------------------------------------------------ loading

def load():
    path = os.path.join(DATA, "stations.csv")
    if not os.path.exists(path):
        print("No built table at %s -- run build_site.py first." % path)
        sys.exit(2)
    with open(path, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    meta = {}
    meta_path = os.path.join(DATA, "meta.json")
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
    return rows, meta


def as_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------- structural

def check_structure(rows):
    expected = ["id", "band", "service", "call", "freq", "status", "live",
                "class", "city", "state", "country", "lat", "lon", "erp",
                "erp_night", "haat", "hours", "directional", "licensee"]
    if not rows:
        error("structure", "the table is empty")
        return
    missing = [c for c in expected if c not in rows[0]]
    if missing:
        error("structure", "columns missing from the export: %s" % ", ".join(missing))

    seen, dupes = set(), []
    for r in rows:
        if r["id"] in seen:
            dupes.append(r["id"])
        seen.add(r["id"])
    if dupes:
        error("unique-id", "%d ids appear more than once" % len(dupes), dupes[:5])

    for field in ("call", "band", "service", "lat", "lon", "freq"):
        blank = [r["id"] for r in rows if not (r.get(field) or "").strip()]
        if blank:
            error("required", "%d rows have no %s" % (len(blank), field), blank[:5])

    bad = [r["id"] for r in rows if r["band"] not in ("AM", "FM")]
    if bad:
        error("band", "%d rows have a band that is neither AM nor FM" % len(bad), bad[:5])

    # A station's identity is its call sign; a placeholder means a proposal got
    # through the filter and would render as a phantom on a real frequency.
    placeholder = [r["id"] for r in rows if r["call"].upper() in ("NEW", "-", "")]
    if placeholder:
        error("placeholder", "%d rows carry a placeholder call sign" % len(placeholder),
              placeholder[:5])


def check_numbers(rows):
    for field in ("lat", "lon", "freq"):
        bad = [r["id"] for r in rows if as_float(r[field]) is None]
        if bad:
            error("numeric", "%d rows have a %s that will not parse" % (len(bad), field),
                  bad[:5])
    for field in ("erp", "erp_night", "haat"):
        bad = [r["id"] for r in rows
               if (r[field] or "").strip() and as_float(r[field]) is None]
        if bad:
            error("numeric", "%d rows have a %s that will not parse" % (len(bad), field),
                  bad[:5])

    out = [r["id"] for r in rows
           if not (-90 <= (as_float(r["lat"]) or 999) <= 90)
           or not (-180 <= (as_float(r["lon"]) or 999) <= 180)]
    if out:
        error("coords", "%d rows are outside the possible range" % len(out), out[:5])

    # 0,0 is in the Atlantic. It is what a failed conversion looks like.
    null_island = [r["id"] for r in rows
                   if abs(as_float(r["lat"]) or 9) < 0.01
                   and abs(as_float(r["lon"]) or 9) < 0.01]
    if null_island:
        error("coords", "%d rows sit at 0,0" % len(null_island), null_island[:5])


def check_live_flag(rows):
    """The live column must follow the rule fcc.py documents, not drift from it."""
    wrong = []
    for r in rows:
        live = r["live"] == "1"
        if r["band"] == "AM" and r["country"] != "US":
            expect = r["status"] in ("CP", "LIC")
        else:
            expect = r["status"] in ("LIC", "STA")
        if live != expect:
            wrong.append("%s (%s/%s/%s)" % (r["id"], r["band"], r["country"], r["status"]))
    if wrong:
        error("live-flag", "%d rows disagree with the documented rule" % len(wrong),
              wrong[:5])


# ----------------------------------------------------------------- physical

def check_frequencies(rows):
    """FM sits on a 200 kHz channel grid and AM on a 10 kHz one."""
    fm_bad, am_bad = [], []
    for r in rows:
        f = as_float(r["freq"])
        if f is None:
            continue
        if r["band"] == "FM":
            # Channels 200-300: 87.9 through 107.9, every 0.2 MHz. Done in
            # tenths as integers -- 88.1 and 87.9 are both inexact in binary,
            # and testing their difference against 0.2 fails for every station
            # on the band.
            tenths = round(f * 10)
            if not (879 <= tenths <= 1079) or (tenths - 879) % 2:
                fm_bad.append("%s %s" % (r["id"], r["freq"]))
        elif r["state"] in REGION_3:
            # Guam and the Marianas sit in ITU Region 3, which spaces the AM
            # band every 9 kHz rather than every 10. KGUM on 567 and KTWG on
            # 801 are correct and would fail the Region 2 test.
            if not (525 <= f <= 1710) or f % 9 and f % 10:
                am_bad.append("%s %s" % (r["id"], r["freq"]))
        else:
            if not (530 <= f <= 1700) or f % 10 != 0:
                am_bad.append("%s %s" % (r["id"], r["freq"]))
    if fm_bad:
        error("fm-grid", "%d FM rows are off the channel grid" % len(fm_bad), fm_bad[:5])
    if am_bad:
        error("am-grid", "%d AM rows are off the channel grid" % len(am_bad), am_bad[:5])


def check_power(rows):
    """Power has to be possible for the service the record claims."""
    # Class C FM tops out at 100 kW, but stations licensed before the class
    # limits took effect kept what they had -- WBCT Grand Rapids on 320 kW and
    # WLFP Memphis on 300 kW are both correct. Canada licenses higher than the
    # US outright. So this flags only the genuinely improbable.
    limits = {"FM": 400.0, "FL": 0.25, "FX": 25.0, "FB": 400.0}
    over = []
    for r in rows:
        erp = as_float(r["erp"])
        if erp is None:
            continue
        cap = limits.get(r["service"])
        if cap and erp > cap * 1.2:      # 20% over allows rounding and odd grants
            over.append("%s %s %s kW" % (r["id"], r["service"], r["erp"]))
    if over:
        warn("power", "%d rows exceed the usual limit for their service" % len(over),
             over[:5])

    # US AM runs to 50 kW. Foreign records are not held to it -- Mexico and
    # Cuba both licence higher.
    am_over = [("%s %s kW" % (r["id"], r["erp"])) for r in rows
               if r["band"] == "AM" and r["country"] == "US"
               and (as_float(r["erp"]) or 0) > 50.0]
    if am_over:
        warn("power", "%d US AM rows exceed 50 kW" % len(am_over), am_over[:5])

    negative = [r["id"] for r in rows if (as_float(r["erp"]) or 0) < 0]
    if negative:
        error("power", "%d rows have negative power" % len(negative), negative[:5])


def check_classes(rows):
    bad = []
    for r in rows:
        valid = (AM_CLASSES if r["band"] == "AM"
                 else FM_CLASSES_BY_COUNTRY.get(r["country"], FM_CLASSES))
        if r["class"] not in valid:
            bad.append("%s %s '%s'" % (r["id"], r["band"], r["class"]))
    if bad:
        warn("class", "%d rows carry an unrecognised class" % len(bad), bad[:5])


def check_am_night(rows):
    """A night power above the day power is possible but rare enough to flag."""
    odd = []
    for r in rows:
        if r["band"] != "AM":
            continue
        day, night = as_float(r["erp"]), as_float(r["erp_night"])
        if day and night and night > day * 1.001:
            odd.append("%s day %s night %s" % (r["id"], r["erp"], r["erp_night"]))
    if len(odd) > len([r for r in rows if r["band"] == "AM"]) * 0.02:
        warn("am-night", "%d AM rows have night power above day power" % len(odd),
             odd[:5])


# --------------------------------------------------------------- geographic

def check_geography(rows):
    misplaced = []
    for r in rows:
        boxes = fcc.COUNTRY_BOUNDS.get(r["country"])
        if not boxes:
            continue
        lat, lon = as_float(r["lat"]), as_float(r["lon"])
        if lat is None or lon is None:
            continue
        if not any(la0 <= lat <= la1 and lo0 <= lon <= lo1
                   for la0, la1, lo0, lo1 in boxes):
            misplaced.append("%s %s %s %.3f,%.3f" % (r["id"], r["call"], r["country"],
                                                     lat, lon))
    if misplaced:
        warn("geography", "%d rows sit outside their country's bounds" % len(misplaced),
             misplaced[:8])


# ----------------------------------------------------------------- external

def check_against_fcc(rows):
    """Compare with the FCC's separately published station totals."""
    live = [r for r in rows if r["live"] == "1" and r["country"] == "US"]
    counted = {}
    for r in live:
        counted[r["service"]] = counted.get(r["service"], 0) + 1
    counted["FX+FB"] = counted.get("FX", 0) + counted.get("FB", 0)

    for key, published in FCC_TOTALS.items():
        if key == "as_of":
            continue
        got = counted.get(key, 0)
        drift = abs(got - published) / published
        line = "%s: %d here vs %d published %s (%+.1f%%)" % (
            key, got, published, FCC_TOTALS["as_of"], (got - published) / published * 100)
        if drift > TOTALS_TOLERANCE:
            error("fcc-totals", line)
        else:
            print("    ok  %s" % line)


# --------------------------------------------------------------- continuity

def check_continuity(rows, meta):
    """Compare this build with the last, via the change log."""
    path = os.path.join(DATA, "changes.csv")
    if not os.path.exists(path):
        return
    with open(path, newline="", encoding="utf-8") as f:
        changes = list(csv.DictReader(f))
    if not changes:
        return
    latest = max(c["date"] for c in changes)
    today_rows = [c for c in changes if c["date"] == latest]
    removed = sum(1 for c in today_rows if c["change"] == "removed")
    total = len(rows)
    if total and removed / total > CONTINUITY_TOLERANCE:
        error("continuity",
              "%d stations disappeared in the %s build, %.1f%% of the table -- "
              "this is more likely a failed download than an event"
              % (removed, latest, removed / total * 100))


def check_freshness(meta):
    generated = meta.get("generated")
    if not generated:
        warn("freshness", "meta.json carries no generated date")
        return
    age = (date.today() - datetime.strptime(generated, "%Y-%m-%d").date()).days
    if age > 7:
        error("freshness", "the published data is %d days old (built %s)" % (age, generated))
    elif age > 2:
        warn("freshness", "the published data is %d days old (built %s)" % (age, generated))
    else:
        print("    ok  built %s, %d day(s) old" % (generated, age))


# --------------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--quiet", action="store_true", help="print only failures")
    args = parser.parse_args()

    rows, meta = load()
    if not args.quiet:
        print("Verifying %s stations in docs/data/stations.csv\n" % f"{len(rows):,}")
        print("  external — against the FCC's published totals")
    check_against_fcc(rows)
    if not args.quiet:
        print("  freshness")
    check_freshness(meta)

    check_structure(rows)
    check_numbers(rows)
    check_live_flag(rows)
    check_frequencies(rows)
    check_power(rows)
    check_classes(rows)
    check_am_night(rows)
    check_geography(rows)
    check_continuity(rows, meta)

    errors = [f for f in findings if f[0] == "ERROR"]
    warns = [f for f in findings if f[0] == "WARN"]

    print()
    for level, check, message, sample in findings:
        print("  %-5s [%s] %s" % (level, check, message))
        for s in sample:
            print("           %s" % s)

    print("\n%d error(s), %d warning(s)" % (len(errors), len(warns)))
    if errors:
        print("Not fit to publish.")
        return 1
    print("Fit to publish.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
