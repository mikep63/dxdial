#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Mike Parker <mike@rsbl.org>
# SPDX-License-Identifier: LicenseRef-AllRightsReserved
"""Download the current FCC AM and FM station records into data/raw/.

Usage:
  python3 update_data.py            # fetch every service
  python3 update_data.py FM AM      # fetch only the ones named

Five files come down, one per service, because the FCC exposes them as separate
queries rather than one table: full power FM, low power FM, FM translators, FM
boosters, and AM.

Two service codes the query accepts are deliberately not fetched.

  FS returns 2,128 records that are already in the full power FM result -- 2,112
  of the call-and-frequency pairs and 2,116 of the facility IDs are shared, and
  the classes are the full power ones (B, C, C1). Fetching it would double count
  two thousand stations.

  FB was missed at first and is fetched now. Boosters are counted with
  translators in the FCC's own published totals, and leaving them out put this
  416 stations under that figure.

Two things about the source are worth knowing before changing this.

The host matters. These CGIs live on transition.fcc.gov, which serves
automated clients without complaint. The same data reached through www.fcc.gov
returns 403, then 429, and then stops answering for several minutes -- so the
documentation pages are readable in a browser but not from a script, and
pointing this at www.fcc.gov will look like an outage.

The User-Agent matters too, and fails in a way that looks like something else.
The FCC rejects any agent string with no product/version token in it, so a
plain name like "dxdial-updater" gets a flat 403 while
"dxdial/1.0" is served. The 403 is not rate limiting and does not clear
on its own, which is why it is not retried below -- retrying it once cost four
minutes of backoff against an error that was never going to resolve.

The timing matters. LMS, which these queries read, is unavailable for
maintenance from Wednesday 18:00 to Thursday 08:00 US Eastern. A refresh
scheduled inside that window will fetch nothing or fetch a partial table.
"""
import argparse
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta

BASE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(BASE, "data", "raw")

# Names the project and points at it, and carries the version token the FCC
# insists on. See the note above before simplifying this string.
USER_AGENT = "dxdial/1.0 (+https://github.com/mikep63/dxdial)"

FM_QUERY = ("https://transition.fcc.gov/fcc-bin/fmq"
            "?serv=%s&list=4&size=9")
AM_QUERY = ("https://transition.fcc.gov/fcc-bin/amq"
            "?freq=530&fre2=1700&type=0&list=4&size=9")

# The TV query takes no service parameter. Passing serv= a value it does not
# recognise returns the whole table rather than an error, so asking per service
# would fetch the same 5.5 MB six times over to get what one request already
# holds: DTV, DTS, DCA, LPD, LPT and DRT together.
TV_QUERY = "https://transition.fcc.gov/fcc-bin/tvq?list=4&size=9"

# The Licensing and Management System publishes its tables as daily dumps, and
# the facility table is the only place the FCC states a station's network. The
# query CGIs above do not carry it -- ABC, CBS, NBC and Fox appear in those
# files only inside licensee company names, where they are wrong as often as
# right. This one says NBC against WWBT, and carries the ATSC 3.0 flag too.
#
# The path is dated and only the current day is linked, but earlier days keep
# answering, so lms_url walks back rather than failing on a morning when the
# daily build has not landed yet.
LMS_TABLE = ("https://enterpriseefiling.fcc.gov/dataentry/api/download"
             "/dbfile/%s/facility.zip")


def lms_url(days_back=4):
    """The newest LMS facility dump that actually answers."""
    for back in range(days_back):
        url = LMS_TABLE % (date.today() - timedelta(days=back)).strftime("%m-%d-%Y")
        request = urllib.request.Request(
            url, method="HEAD", headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=60):
                return url
        except (urllib.error.URLError, OSError):
            continue
    # Nothing answered. Return today's so the failure is reported against a real
    # URL rather than swallowed here.
    return LMS_TABLE % date.today().strftime("%m-%d-%Y")

# Service code to (url, filename). The FM query takes the service as a
# parameter; the AM query is its own CGI and takes none.
SERVICES = {
    "FM": (FM_QUERY % "FM", "fm.txt"),
    "FL": (FM_QUERY % "FL", "fl.txt"),
    "FX": (FM_QUERY % "FX", "fx.txt"),
    "FB": (FM_QUERY % "FB", "fb.txt"),
    "AM": (AM_QUERY, "am.txt"),
    "TV": (TV_QUERY, "tv.txt"),
    # A zip rather than a pipe table, and dated, so its URL is worked out when
    # the fetch runs instead of sitting in this dict.
    "LMS": (None, "facility.zip"),
}

# Anything smaller than these is an error page or a truncated response rather
# than a national list. Boosters are a genuinely small service -- a few hundred
# records -- so they get their own floor instead of the general one.
MIN_BYTES = {"FB": 50_000, "LMS": 5_000_000}
MIN_BYTES_DEFAULT = 500_000


def fetch(url, attempts=3):
    """Fetch one query, backing off when the FCC rate-limits us."""
    delay = 5
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                return response.read()
        except urllib.error.HTTPError as err:
            # 403 is the agent string being refused, not load; it will read the
            # same on every attempt, so fail now and say what to change.
            if err.code == 403:
                raise RuntimeError(
                    "403 Forbidden -- the FCC refused the User-Agent %r. It needs "
                    "a product/version token in it." % USER_AGENT) from None
            if attempt == attempts:
                raise
            print("    %s -- retrying in %ds" % (err, delay))
            time.sleep(delay)
            delay *= 2
        except (urllib.error.URLError, OSError) as err:
            if attempt == attempts:
                raise
            print("    %s -- retrying in %ds" % (err, delay))
            time.sleep(delay)
            delay *= 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("services", nargs="*", default=None,
                        help="service codes to fetch (default: all)")
    args = parser.parse_args()

    wanted = [s.upper() for s in args.services] if args.services else list(SERVICES)
    unknown = [s for s in wanted if s not in SERVICES]
    if unknown:
        parser.error("unknown service(s): %s" % ", ".join(unknown))

    os.makedirs(RAW, exist_ok=True)
    failed = []
    for service in wanted:
        url, name = SERVICES[service]
        if url is None:
            url = lms_url()
        print("%s ..." % service)
        try:
            body = fetch(url)
        except Exception as err:                      # noqa: BLE001
            print("    failed: %s" % err)
            failed.append(service)
            continue
        if len(body) < MIN_BYTES.get(service, MIN_BYTES_DEFAULT):
            # Written to a .partial so the previous good copy survives and the
            # bad response is still there to look at.
            path = os.path.join(RAW, name + ".partial")
            with open(path, "wb") as out:
                out.write(body)
            print("    short response, %d bytes -- kept as %s, previous copy left alone"
                  % (len(body), os.path.basename(path)))
            failed.append(service)
            continue
        path = os.path.join(RAW, name)
        with open(path, "wb") as out:
            out.write(body)
        if name.endswith(".zip"):
            print("    %-12s %6.1f MB" % (name, len(body) / 1e6))
        else:
            print("    %-12s %6.1f MB  %d records"
                  % (name, len(body) / 1e6, body.count(b"\n|") + body.startswith(b"|")))

    if failed:
        print("\nIncomplete: %s" % ", ".join(failed))
        return 1
    print("\nNow run: python3 build_site.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
