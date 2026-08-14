#!/usr/bin/env python3
"""Build the static site into docs/ (for GitHub Pages / offline PWA).

Reads the downloaded query files from data/raw/, normalizes them through
fcc.py, exports one station table, records what changed since the last build,
copies the frontend from static/, and writes the PWA pieces.

Usage: python3 build_site.py
"""
import csv
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
           ("fb.txt", "FM"), ("am.txt", "AM")]

COLUMNS = ["id", "band", "service", "call", "freq", "status", "live", "class",
           "city", "state", "country", "lat", "lon", "erp", "erp_night",
           "haat", "hours", "directional", "licensee"]

# The fields whose change is worth a line in the change log. Licensee moves on
# every ownership deal and would drown out the rest, so it is left out.
TRACKED = ["call", "freq", "status", "city", "state", "erp", "lat", "lon"]


def station_id(station):
    facility = station["facility"]
    if facility and facility not in ("0", "-"):
        return "%s%s" % (station["service"], facility)
    # Foreign records notified under the border agreements may carry no
    # facility ID; frequency and call sign identify those well enough.
    return "%s-%s-%s" % (station["service"], station["call"],
                         str(station["freq"]).replace(".", ""))


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
    today = date.today().isoformat()
    current = {s["id"]: s for s in stations}
    rows = []

    for sid in sorted(set(current) - set(previous)):
        s = current[sid]
        rows.append([today, "added", sid, s["band"], s["call"], s["freq"],
                     s["city"], s["state"], ""])
    for sid in sorted(set(previous) - set(current)):
        s = previous[sid]
        rows.append([today, "removed", sid, s["band"], s["call"], s["freq"],
                     s["city"], s["state"], ""])
    for sid in sorted(set(previous) & set(current)):
        old, new = previous[sid], current[sid]
        for field in TRACKED:
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


def write_meta(stations):
    by_service, by_country = {}, {}
    live = [s for s in stations if s["live"]]
    for s in live:
        by_service[s["service"]] = by_service.get(s["service"], 0) + 1
        by_country[s["country"]] = by_country.get(s["country"], 0) + 1
    meta = {
        "generated": date.today().isoformat(),
        # The headline figure counts stations on the air. The permits and
        # applications are in the table too, but calling them stations would
        # overstate what there is to listen to by several thousand.
        "stations": len(live),
        "records": len(stations),
        "byService": by_service,
        "byCountry": by_country,
        "serviceNames": fcc.SERVICE_NAMES,
        "source": "FCC Media Bureau AM and FM query, transition.fcc.gov",
    }
    with open(os.path.join(DATA_OUT, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1, sort_keys=True)
        f.write("\n")
    print("  %-14s %s" % ("meta.json", ", ".join(
        "%s %d" % (k, v) for k, v in sorted(by_service.items()))))


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
        shutil.copy2(os.path.join(STATIC, name), os.path.join(DOCS, name))
        print("  %s" % name)


def write_pwa(stations):
    for size in (180, 512):
        with open(os.path.join(DOCS, "icon-%d.png" % size), "wb") as f:
            f.write(png(size, (0x11, 0x2B, 0x3A)))
    manifest = {
        "name": "Radio Stations",
        "short_name": "Radio",
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

    # The cache name carries the station count so that a refresh which changes
    # the data also changes this file, which is what makes the browser fetch
    # the new service worker and drop the old cache.
    worker = """/* Generated by build_site.py -- do not edit. */
const CACHE = 'radio-stations-%s-%d';
const ASSETS = ['./', './index.html', './style.css', './app.js',
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
""" % (date.today().isoformat(), len(stations))
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
