#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Mike Parker <mike@rsbl.org>
# SPDX-License-Identifier: LicenseRef-AllRightsReserved
"""Build the static site into docs/ (for GitHub Pages / offline PWA).

Reads the downloaded query files from data/raw/, normalizes them through
fcc.py, exports one station table, records what changed since the last build,
copies the frontend from static/, and writes the PWA pieces.

Usage: python3 build_site.py
"""
import csv
import hashlib
import json
import os
import shutil
import struct
import sys
import zlib
from datetime import date

import fcc

BASE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(BASE, "data", "raw")
STATIC = os.path.join(BASE, "static")
DOCS = os.path.join(BASE, "docs")
DATA_OUT = os.path.join(DOCS, "data")

SOURCES = [("fm.txt", "FM"), ("fl.txt", "FM"), ("fx.txt", "FM"),
           ("fb.txt", "FM"), ("am.txt", "AM"), ("tv.txt", "TV")]

COLUMNS = ["id", "band", "service", "call", "freq", "status", "live", "class",
           "city", "state", "country", "lat", "lon", "erp", "erp_night",
           "haat", "hours", "directional", "licensee", "channel", "virtual",
           "network", "atsc3", "relay"]

# The fields whose change is worth a line in the change log. Licensee moves on
# every ownership deal and would drown out the rest, so it is left out.
TRACKED = ["call", "freq", "status", "city", "state", "erp", "lat", "lon",
           "channel", "network", "relay"]

# The shape of what docs/data/ publishes. A reader carries the number it was
# written against and stops rather than draws when they disagree.
#
# The site cannot really drift -- its HTML, JS and CSV deploy together and the
# service worker caches them under one key -- but an app store binary can. It is
# pinned at whatever was approved while this data keeps moving weekly, so a
# column renamed here reaches it as a field that silently reads empty. This is
# the number that lets it say so instead. It costs nothing until the day it is
# needed, and cannot be added retroactively to a client already shipped.
#
# 1  columns as at 2026-08-15: id, band, service, call, freq, status, live,
#    class, city, state, country, lat, lon, erp, erp_night, haat, hours,
#    directional, licensee.
#
# Bump it when a column is renamed, removed, or changes meaning. Adding one an
# old reader can ignore does not need it.
#
# The TV band added channel and virtual on 2026-08-20 and did not bump this,
# which is the rule working rather than being dodged. Both are new columns at
# the end, empty on AM and FM, and a reader that has never heard of them sees
# the table it already knew. freq deliberately stays in MHz for TV -- the
# centre of the 6 MHz channel -- because putting a channel number in it would
# have changed what an existing column means, and that is the case this number
# exists for.
EXPORT_SHAPE = 1


def site_tag(station):
    """A short stable name for one transmitter site of a multi-site facility.

    Derived from the coordinates rather than from a position in a list, because
    a list index moves when a sibling site is added or removed and would take
    every logbook entry for the surviving sites with it. The same transmitter
    keeps the same tag for as long as it stays where it is.
    """
    seed = "%s,%s" % (station["lat"], station["lon"])
    return hashlib.sha256(seed.encode("utf-8")).hexdigest()[:4]


def station_id(station):
    facility = station["facility"]
    if facility and facility not in ("0", "-"):
        # TV carries the site because the facility is not unique on its own --
        # see _identity in fcc.py. Applied to every TV row rather than only to
        # the facilities that have siblings today, so that the day a second
        # site is licensed the first one's id does not change underneath a log.
        if station["band"] == "TV":
            return "%s%s.%s" % (station["service"], facility, site_tag(station))
        return "%s%s" % (station["service"], facility)
    # Foreign records notified under the border agreements may carry no
    # facility ID; frequency and call sign identify those well enough.
    return "%s-%s-%s" % (station["service"], station["call"],
                         str(station["freq"]).replace(".", ""))


def attach_lms(stations):
    """Fill in the network, the ATSC 3.0 flag and the relay from LMS.

    Joined on the FCC's facility ID, which both sides carry, so this is an
    exact match rather than call signs matched by hand.

    Nothing is invented where the file is silent. A blank network means none is
    filed, and "Independent" is a value the FCC records in its own right, which
    is what makes the blank readable rather than ambiguous. The same holds for
    the relay: a blank means no primary was filed, which for LPFM is the rule
    rather than an omission.
    """
    extra = fcc.load_facility(os.path.join(RAW, "facility.zip"))
    for s in stations:
        s["network"] = ""
        s["atsc3"] = ""
        s["relay"] = ""
    if not extra:
        print("  no LMS facility table -- network, ATSC 3.0 and relay left blank")
        return

    # Network and ATSC 3.0 land on the transmitter rather than the facility, so
    # a station running several transmitters carries its network on each of
    # them. That is right for a list read one row at a time: a translator's row
    # that said nothing about the network would look like an unaffiliated
    # station rather than the affiliate it repeats.
    named = 0
    for s in stations:
        if s["band"] != "TV":
            continue
        found = extra.get(str(s["facility"]).lstrip("0"))
        if not found:
            continue
        s["network"] = found["network"]
        s["atsc3"] = found["atsc3"]
        if found["network"]:
            named += 1
    print("  %d television transmitters named a network" % named)

    # The relay is the other direction: primary_station names the facility a
    # translator or booster rebroadcasts, and what a reader wants from it is
    # the station, not the number. So it is resolved to an id in this very
    # table, which makes it a link to a page that already exists rather than a
    # call sign copied to a second place to go stale.
    #
    # Radio only, though the file carries a few hundred TV translators too. A
    # television id is facility plus a site tag -- see station_id -- so a bare
    # facility does not name one transmitter there, and picking a site to point
    # at would be inventing the part the FCC did not say.
    by_facility = {}
    for s in stations:
        if s["band"] == "TV":
            continue
        fid = str(s["facility"]).lstrip("0")
        if fid and fid not in ("0", "-"):
            by_facility.setdefault(fid, s["id"])

    relayed = dangling = 0
    for s in stations:
        if s["band"] == "TV":
            continue
        found = extra.get(str(s["facility"]).lstrip("0"))
        primary = found and found["primary"]
        if not primary:
            continue
        target = by_facility.get(primary)
        # A primary that is silent, foreign or lapsed is not in this table. The
        # cell stays blank rather than carrying a facility number that points
        # at no page -- a dangling id is worse than an absent one, because a
        # reader cannot tell it is dangling.
        if not target or target == s["id"]:
            dangling += 1
            continue
        s["relay"] = target
        relayed += 1
    print("  %d radio transmitters relay a station in this table (%d primaries not in it)"
          % (relayed, dangling))


def load_all():
    rows, missing = [], []
    for name, band in SOURCES:
        path = os.path.join(RAW, name)
        if not os.path.exists(path):
            missing.append(name)
            continue
        found = fcc.load(path, band)
        print("  %-8s %6d rows" % (name, len(found)))
        rows.extend(found)
    if missing:
        print("\nMissing from data/raw/: %s" % ", ".join(missing))
        print("Run: python3 update_data.py")
        if not rows:
            sys.exit(1)
    return rows


def write_stations(stations):
    path = os.path.join(DATA_OUT, "stations.csv")
    with open(path, "w", newline="", encoding="utf-8") as f:
        # LF, not the csv module's CRLF: .gitattributes normalizes to LF on
        # commit, so writing CRLF leaves the file modified after every build
        # with no content change.
        writer = csv.writer(f, lineterminator="\n")
        writer.writerow(COLUMNS)
        for s in stations:
            writer.writerow([
                s["id"], s["band"], s["service"], s["call"], s["freq"],
                s["status"], "1" if s["live"] else "", s["class"],
                s["city"], s["state"], s["country"], s["lat"], s["lon"],
                "" if s["erp"] is None else s["erp"],
                "" if s["erp_night"] is None else s["erp_night"],
                "" if s["haat"] is None else s["haat"],
                s["hours"], s["directional"], s["licensee"],
                "" if s["channel"] is None else s["channel"],
                "" if s["virtual"] is None else s["virtual"],
                s["network"], s["atsc3"], s["relay"],
            ])
    print("  %-14s %6d stations  %6.1f KB"
          % ("stations.csv", len(stations), os.path.getsize(path) / 1024))


def read_previous():
    """The station table from the last build, for the change log."""
    path = os.path.join(DATA_OUT, "stations.csv")
    if not os.path.exists(path):
        return None
    with open(path, newline="", encoding="utf-8") as f:
        return {row["id"]: row for row in csv.DictReader(f)}


def write_changes(previous, stations):
    """Append what changed to the running change log.

    This is the one thing the incumbents do not offer: they each present a
    static picture of now, with no way to ask what moved. It falls out of
    running the refresh anyway, so it costs a diff.

    Note what this cannot say. A station that has gone silent keeps its licence
    and so keeps its row here unchanged -- silence is invisible in this data.
    """
    if previous is None:
        print("  %-14s (first build, nothing to compare against)" % "changes.csv")
        return
    today = data_date()
    current = {s["id"]: s for s in stations}
    rows = []

    # A band this table has never carried before is not thousands of stations
    # appearing on the air overnight; it is this app starting to look at them.
    # Logging it as 7,932 additions, which is what adding TV did on the first
    # run, buries a year of real changes under one day of import. The stations
    # are in the table either way -- they just do not get a line in a log that
    # exists to say what moved.
    known = {s.get("band") for s in previous.values()}
    arriving = {s["band"] for s in stations} - known
    if arriving:
        print("  %-14s %s now carried; not logged as additions"
              % ("", ", ".join(sorted(arriving))))

    # The same argument one column down. A tracked field the previous table did
    # not have is not thousands of stations changing; it is a column arriving.
    # Adding network wrote 2,514 entries saying every affiliate had just become
    # one, which is the log describing this build rather than the world.
    sample = next(iter(previous.values()))
    fresh = [f for f in TRACKED if f not in sample]
    if fresh:
        print("  %-14s %s newly recorded; first values not logged as changes"
              % ("", ", ".join(fresh)))

    for sid in sorted(set(current) - set(previous)):
        s = current[sid]
        if s["band"] in arriving:
            continue
        rows.append([today, "added", sid, s["band"], s["call"], s["freq"],
                     s["city"], s["state"], ""])
    for sid in sorted(set(previous) - set(current)):
        s = previous[sid]
        rows.append([today, "removed", sid, s["band"], s["call"], s["freq"],
                     s["city"], s["state"], ""])
    for sid in sorted(set(previous) & set(current)):
        old, new = previous[sid], current[sid]
        for field in TRACKED:
            if field in fresh:
                continue
            before = (old.get(field) or "").strip()
            after = "" if new.get(field) is None else str(new[field])
            if before != after and (before or after):
                rows.append([today, field, sid, new["band"], new["call"],
                             new["freq"], new["city"], new["state"],
                             "%s -> %s" % (before or "(blank)", after or "(blank)")])

    path = os.path.join(DATA_OUT, "changes.csv")
    exists = os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, lineterminator="\n")
        if not exists:
            writer.writerow(["date", "change", "id", "band", "call", "freq",
                             "city", "state", "detail"])
        writer.writerows(rows)
    print("  %-14s %6d new entries" % ("changes.csv", len(rows)))


def data_date():
    """The day the FCC was actually asked, not the day this ran.

    date.today() was the wrong answer to "FCC data of". Every rebuild restamped
    it, so a day spent on the frontend advanced a date that claims to describe
    the data, and the colophon could say the data came from a day nothing was
    fetched. The newest file in data/raw is when the queries last ran, which is
    the thing the label names.

    Falls back to today only when there is no raw directory to read -- a build
    from a checkout that has never fetched, where there is no better answer.

    This is the six query files and deliberately not facility.zip, which is a
    separate download on its own schedule and can be days apart from them --
    update_data fetches per service when asked to, and lms_url walks back up to
    four days for a dump that answers. Folding both into one date would let the
    newer one speak for the older, so the LMS day is reported beside this one
    rather than averaged into it. See fcc.facility_date.
    """
    newest = 0
    for name, _ in SOURCES:
        path = os.path.join(RAW, name)
        if os.path.exists(path):
            newest = max(newest, os.path.getmtime(path))
    if not newest:
        return date.today().isoformat()
    return date.fromtimestamp(newest).isoformat()


def write_meta(stations):
    by_service, by_country = {}, {}
    live = [s for s in stations if s["live"]]
    for s in live:
        by_service[s["service"]] = by_service.get(s["service"], 0) + 1
        by_country[s["country"]] = by_country.get(s["country"], 0) + 1
    meta = {
        "shape": EXPORT_SHAPE,
        "generated": data_date(),
        # The day the LMS dump was built, which is not the day the queries ran
        # and not the day it was downloaded either. Network, ATSC 3.0 and relay
        # all come from it, so a build where this trails "generated" is serving
        # three columns older than the table around them and should say so.
        # null when there is no facility.zip to read, which is a build with
        # those three columns empty.
        "lmsGenerated": fcc.facility_date(os.path.join(RAW, "facility.zip")),
        # The headline figure counts stations on the air. The permits and
        # applications are in the table too, but calling them stations would
        # overstate what there is to listen to by several thousand.
        "stations": len(live),
        "records": len(stations),
        "byService": by_service,
        "byCountry": by_country,
        "serviceNames": fcc.SERVICE_NAMES,
        "source": "FCC Media Bureau AM, FM and TV queries, transition.fcc.gov",
    }
    with open(os.path.join(DATA_OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1, sort_keys=True)
        f.write("\n")
    print("  %-14s %s" % ("meta.json", ", ".join(
        "%s %d" % (k, v) for k, v in sorted(by_service.items()))))
    lms = meta["lmsGenerated"]
    if lms != meta["generated"]:
        print("  %-14s queries %s, LMS %s -- network and relay are from a different day"
              % ("", meta["generated"], lms or "absent"))


# ----------------------------------------------------------------- frontend

def png(size, rgb):
    """A solid-colour square PNG, so the PWA icons need no image library."""
    r, g, b = rgb
    raw = b"".join(b"\x00" + bytes([r, g, b]) * size for _ in range(size))

    def chunk(tag, payload):
        body = tag + payload
        return (struct.pack(">I", len(payload)) + body
                + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


def copy_frontend():
    for name in sorted(os.listdir(STATIC)):
        if name.startswith("."):
            continue
        src, dst = os.path.join(STATIC, name), os.path.join(DOCS, name)
        # vendor/ holds third-party code carried in the repository rather than
        # fetched at run time: the page must work with no network but its own
        # cache, and a CDN would also hand every reader's address to a third
        # party on every visit.
        if os.path.isdir(src):
            shutil.copytree(src, dst, dirs_exist_ok=True)
            print("  %s/" % name)
            continue
        shutil.copy2(src, dst)
        print("  %s" % name)


def write_pwa(stations):
    # Pages runs a branch deploy through Jekyll unless this file is present,
    # which would silently drop anything under a name starting with _ and adds
    # a build step to every push for nothing. copy_frontend() skips dotfiles,
    # so static/ cannot carry it and it has to be written here.
    open(os.path.join(DOCS, ".nojekyll"), "w").close()

    for size in (180, 512):
        with open(os.path.join(DOCS, "icon-%d.png" % size), "wb") as f:
            f.write(png(size, (0x11, 0x2B, 0x3A)))
    manifest = {
        "name": "DXDial",
        "short_name": "DXDial",
        "start_url": ".",
        "display": "standalone",
        "background_color": "#112b3a",
        "theme_color": "#112b3a",
        "icons": [{"src": "icon-180.png", "sizes": "180x180", "type": "image/png"},
                  {"src": "icon-512.png", "sizes": "512x512", "type": "image/png"}],
    }
    with open(os.path.join(DOCS, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=1, sort_keys=True)
        f.write("\n")

    # The cache name has to change whenever anything the worker caches changes,
    # or activate keeps the old cache and fetch keeps serving out of it. Date and
    # station count alone do not do that: a frontend fix on a day the data held
    # still produces the same name, the browser drops nothing, and the reader
    # gets yesterday's app.js with no way to tell -- which is exactly what
    # happened on 2026-08-15. Hashing the cached files is the honest key, since
    # it moves for a code change and a same-count data change alike. Date and
    # count stay in front of it because they are what a human reads.
    cached = ["index.html", "style.css", "app.js", "manifest.json",
              os.path.join("vendor", "leaflet.js"), os.path.join("vendor", "leaflet.css"),
              os.path.join("data", "stations.csv"), os.path.join("data", "meta.json")]
    digest = hashlib.sha256()
    for name in cached:
        with open(os.path.join(DOCS, name), "rb") as f:
            digest.update(f.read())
    stamp = digest.hexdigest()[:8]

    # Leaflet is cached; map tiles deliberately are not. The OSMF tile policy
    # names offline download and prefetching as bulk downloading and prohibits
    # both, so ASSETS must never grow a tile. The fetch handler below is safe on
    # that count by construction: it serves from the cache or falls through to
    # the network, and never writes what it fetched back. Offline, the tiles go
    # blank while the markers and range rings still draw, because Leaflet builds
    # those as vectors that owe nothing to the tile layer.
    worker = """/* Generated by build_site.py -- do not edit. */
const CACHE = 'dxdial-%s-%d-%s';
const ASSETS = ['./', './index.html', './style.css', './app.js',
  './vendor/leaflet.js', './vendor/leaflet.css',
  './data/stations.csv', './data/meta.json', './manifest.json'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request)));
});
""" % (date.today().isoformat(), len(stations), stamp)
    with open(os.path.join(DOCS, "sw.js"), "w", encoding="utf-8") as f:
        f.write(worker)
    print("  manifest.json, sw.js, icon-180.png, icon-512.png")


def main():
    os.makedirs(DATA_OUT, exist_ok=True)
    print("Reading data/raw/ ...")
    rows = load_all()

    print("\nNormalizing ...")
    stations = fcc.merge(rows)
    for s in stations:
        s["id"] = station_id(s)
    attach_lms(stations)
    if fcc.MISPLACED:
        print("  dropped %d record(s) whose coordinates cannot be where they claim:"
              % len(fcc.MISPLACED))
        for entry in fcc.MISPLACED:
            print("    %s" % entry)
    dropped = len(rows) - len(stations)
    print("  %d rows -> %d stations (%d duplicate, permit and day/night rows folded in)"
          % (len(rows), len(stations), dropped))

    print("\nExporting ...")
    previous = read_previous()
    write_stations(stations)
    write_changes(previous, stations)
    write_meta(stations)

    print("\nFrontend ...")
    copy_frontend()
    write_pwa(stations)
    print("\nBuilt docs/. Serve it with: python3 -m http.server -d docs 8000")


if __name__ == "__main__":
    main()
