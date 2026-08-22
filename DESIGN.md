<!--
SPDX-FileCopyrightText: 2026 Mike Parker <mike@rsbl.org>
SPDX-License-Identifier: LicenseRef-AllRightsReserved
-->

# Design decisions

Settled decisions and the alternatives that lost, so they are not re-argued.

What belongs here: a choice where something else was seriously considered, and
the reason it was not taken. What does not: how the code works, which is what
the code comments are for; why a particular change was made, which is in the
commit that made it (`git log --grep`); what the data means, which is DATA.md.

If an entry here is ever reopened, edit it and say why rather than adding a
second entry that disagrees with the first.

## Two levels, and why they live here

Most of what follows is not a decision about a web app. It is about what DXDial
*is* and what the data can honestly say — the name, the signal model, which
sources are allowed, what units mean. Those bind any client, and a second one
must not quietly decide them differently.

They live in this repository because this is where the data is made:
`update_data.py`, `fcc.py`, `build_site.py` and the published CSV are all here,
and an iOS app is a reader of that CSV. Ownership follows the pipeline rather
than the platform, which is why there is no third repository for shared notes —
one file for a single document would be more ceremony than it saves.

So: **Product and data** below is the authority for every client. **The web
app** is this client only. When `dxdial-ios` exists it gets its own DESIGN.md
for its own choices — tab bar, refresh, store requirements — opening with a
line pointing back here for anything in the first section. `IOS.md` in this
repository is the seed for it, and should move there when it does.

---

# Product and data

Binding on every client, this one and any other.

## The name is DXDial · 2026-08-19

Renamed from `radio-stations`. The head noun is Dial and the modifier is DX: it
is a dial with DX in it, which is still what the app is with television added,
since AM and FM are 80% of the table.

Rejected: **RadioDX** (the New Zealand Radio DX League, an active club in the
same hobby), **radiolog** (swallowed by radiology), **radio-finder** and
**radio-search** (invisible among generic streaming apps), **skywave** (App
Store collision), **dxradio** (weaker; "radio" adds nothing the app does not
imply), **SignalDX** ("Signal" is a crowded App Store token; also the reversal
of an active company, dxsignal.io), **DialDX** and **DialTV** (English puts the
head last, so those are a DX and a TV rather than a dial; and a name ending in
spelled-out letters reads like a hardware SKU), **BroadcastQTH** (QTH is
amateur-radio vocabulary and this audience is broadcast DXers).

Reconsidered when television was added and kept. It would become wrong if
television or antenna-aiming ever became the primary use — that is the
cord-cutter product, which would be separate and would need its own name.

## The signal model is kW/km², and stays wrong in known ways · 2026-08-17

`signal()` scores `kW / km²` and ranks only against others on the same channel.
It knowingly omits terrain, antenna height, ground conductivity and antenna
direction. Raised, analysed, and deliberately left alone.

What would actually decide a close case is the night directional pattern, and
**the FCC's AM and FM exports carry no azimuth data at all** — only a
directional boolean. Direction-aware ranking would need the LMS antenna tables,
which is a separate dependency and real maths.

This is also why **television has no signal column and will not get one**. On
VHF and UHF terrain is the answer rather than a caveat, so the same heuristic
would be wrong in the one way that matters.

## Nearby is exhaustive · 2026-08-19

The "hide under 50 W" filter was removed entirely and nothing replaced it. Every
other filter asks what kind of thing a station is; that one asked whether you
would hear it, which is a judgement this data cannot make. Do not reintroduce a
power filter.

## Formats are absent, and that is settled · 2026-08-18

The FCC licenses transmitters, not programmes. External format sources were
considered and rejected as too volatile — format is the thing about a radio
station most likely to change.

**Television is a partial exception**, added 2026-08-22: the network *is* on
file, in the LMS facility table, and is shown. Sub-channels are not, because
12.1 and 12.2 are decided in the broadcast stream rather than in a licence.

## Network and ATSC 3.0 come from LMS, not from a scrape · 2026-08-22

`enterpriseefiling.fcc.gov/dataentry/api/download/dbfile/MM-DD-YYYY/facility.zip`,
daily, public domain, joined on facility ID with a 100% hit rate.

Rejected: **the networks' own sites** (no licence, no feed), **StationIndex**
(copyright asserted, no terms page at all), **RabbitEars** (copyright asserted;
also one volunteer's work, so scraping it would be wrong before it was illegal),
**Wikipedia** (CC BY-SA, which is a real offer, but ten fragile scrapers and a
share-alike question against an all-rights-reserved app), **Wikidata** (CC0 and
ideal, but only 130 US TV stations carry both a facility ID and an affiliation).

Do not send the permission emails drafted for RabbitEars and StationIndex. They
are moot.

## Television is a third band, not a second app · 2026-08-20

`localStorage` is per-origin, so two apps would mean two logbooks permanently,
for one person — and the WTFDA is the Worldwide *TV-FM* DX Association, so it is
one person. Reuse argues for one codebase, not two.

## One band view with a switch, not three destinations · 2026-08-22

The bands are one place with an AM/FM/TV switch across the top, and Nearby is
merged. **Nearby is show me everything; the band view is band-specific intent.**
Any client should hold that shape.

Why separate the bands at all: one distance cannot serve two. At 400 km the
dial listed 109 AM channels before the first FM one, and past that every one of
FM's 100 channels is occupied while AM keeps growing to all 118 — a channel
list that answers "all of them" has stopped discriminating. Each band therefore
remembers its own distance, and AM remembers day and night separately.

Rejected: **three separate band destinations.** An iPhone tab bar shows five
items and folds the rest into a list nobody opens; with Nearby, Search, Logbook,
Changes and About that makes eight, and every arrangement of eight buries either
Search or the Logbook. The Logbook is the entire argument for one app rather
than two, so it cannot be the thing that goes under More.

Rejected: **a dropdown.** This is navigation rather than filtering, three
options do not need hiding behind a tap, and a `<select>` becomes a picker wheel
on iOS — three interactions for a switch that gets flipped constantly.

## Miles by default, kilometres available · 2026-08-22

The FCC licenses the United States. But the table carries 38 countries and the
hobby quotes QRB in kilometres across a border, so it is a setting rather than a
replacement. Each unit gets its own round menu rungs rather than a conversion of
the other's.

**HAAT stays in metres in both modes.** It is the FCC's filed figure, the one a
coverage study runs against; converting it would mean the number on screen no
longer matches the record it came from.

Distances are kilometres everywhere internally and converted only when printed,
so a unit can be wrong in exactly one place.

## About carries no counted numbers · 2026-08-22

Figures drawn from the station table were removed. The class C and C1 counts had
drifted by a third without anyone noticing, which is the argument against having
them rather than for checking them harder. Regulatory facts stay — class power
limits, the channel plan, Class A's 1999 — because those are not counts of what
happened to be licensed on the day of a build.

# The web app

This client only. An iOS app faces the same questions and may answer them
differently — a tab bar is not a nav strip, and a picker wheel is not a select.

## Six tabs, in this order · 2026-08-22

`Nearby · Bands · Search · Logbook · Changes · About`, in a wrapping nav strip,
with the band switch rendered as a row of three buttons above the view.

This is the web arrangement of the decision above, not the decision itself. It
counts six because the iPhone tab bar it is aimed at shows five and puts the
rest under More — Changes and About are the two that tolerate that, and
everything used in the field stays one tap away. An iOS build should reach the
same five and need not reproduce the strip, the wrapping or the button styling.

# Deferred, not decided

- **A privacy section in About**, until `dxdial-ios` needs a URL for the App
  Store. It must cover the caveat the current copy would fail: OpenStreetMap
  receives a request per map tile and therefore learns the area being viewed.
- **Encrypted ATSC 3.0** and **sub-channels**. Neither is in FCC data.
  RabbitEars is linked for both.

---

See `IOS.md` for what this app has already decided on the port's behalf.
