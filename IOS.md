<!--
SPDX-FileCopyrightText: 2026 Mike Parker <mike@rsbl.org>
SPDX-License-Identifier: LicenseRef-AllRightsReserved
-->

# Notes toward dxdial-ios

Decisions made while building the web app that were made *for* the iOS one, and
which are not visible in any code here. Written 2026-08-22, before any iOS work
started, so that the reasoning survives the gap.

## The five-tab constraint shaped the web app

An iPhone tab bar shows five items and folds the rest into a **More** list,
which is where features go to die. The web nav was designed backwards from that.

    tab bar   Nearby · Bands · Search · Logbook · More
    More      Changes · About

Everything used in the field is one tap. Changes is read occasionally and About
is reference, so those are the two that tolerate the drawer.

This is why **Bands** is one tab with an AM/FM/TV segmented control rather than
three tabs. Three band tabs plus Nearby, Search, Logbook, Changes and About is
eight, and any arrangement of eight buries either Search or the Logbook. A
segmented control is also the native iOS answer to switching between variants of
one view, so the web shape is the shape the port wants rather than something to
redesign.

## The Logbook is why television is in this app at all

`localStorage` is per-origin, so two apps would mean two logbooks permanently,
for one person. The WTFDA is the Worldwide *TV-FM* DX Association: somebody who
catches a tropo opening logs an FM and a TV the same night. One log across three
bands is the whole argument, and it is why the Logbook must never be the tab
that gets pushed under More.

The log's export format carries `LOG_SHAPE`, currently 1, so an iOS importer can
tell what it has been handed. Bump it on a rename or a removal; a new column an
old reader can ignore does not need it.

## What the app already knows about the port

- **`EXPORT_SHAPE`** in `build_site.py` exists for exactly this. The web app
  ships with its data and cannot drift, but a store binary sits at whatever was
  approved while the CSV keeps moving weekly. Adding columns an old reader
  ignores does not bump it; renaming one or changing its meaning does.
- **Refresh is manual**, by design: poll `docs/data/meta.json`, pull the CSV
  only when the reader asks. Not a background fetch.
- **A privacy policy URL is required** for every App Store submission, plus a
  nutrition label — even "Data Not Collected" has to be declared. About has no
  privacy section yet, deliberately: it should be written when there is a URL to
  point at, and it must cover the one caveat the current copy would fail, which
  is that `tile.openstreetmap.org` receives a request per map tile and therefore
  learns the area being viewed.
- **A version number belongs to the binary, not here.** `APP_VERSION` was added
  to the web app and then removed: the page redeploys with its data, so the data
  vintage is version enough. The binary is the thing that needs its own.

## Preferences the port has to carry

Four keys, all `localStorage`, all with the same shape:

    dxdial.place      the location, {lat, lon, label}
    dxdial.band       AM | FM | TV, the segmented control's position
    dxdial.daynight   day | night | absent, absent meaning follow the sun
    dxdial.radius     {day, night, fm, tv}, distances in kilometres
    dxdial.units      mi | km, miles by default
    dxdial.log        the logbook

Distances are kilometres everywhere internally -- the haversine returns km, the
stored radii are km, the filters compare km -- and converted only when printed.
Keep that. It is the single reason a unit can only ever be wrong in one place.

## A bug pattern worth knowing before writing it again

Adding a third band broke five things that were written correctly for two. All
had the same shape: a binary test where the third case fell through to whichever
branch was `else`.

- Map dots coloured `AM ? orange : teal`, so TV drew as FM.
- The legend's class sentence split two ways, so FM was told how AM rows draw.
- `neighbours()` stepped `FM ? 0.2 : 10`, so TV measured in AM's units and
  called five channels adjacent.
- The band-ordering comparator answered `AM ? -1 : 1`, which contradicts itself
  when neither side is AM.
- `bandOfFreq` split at 500, meaningless for channels spanning 57 to 605 MHz.

Grep for `band ===` before assuming a two-way test is still two-way.
