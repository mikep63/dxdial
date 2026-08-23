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

## Nearby means sixty miles · 2026-08-22

A fixed radius, not the distance control, because a DX distance set on the band
view once followed the reader back to a list called Nearby and made it
continental. And a round figure in the unit that is showing by default: a
hundred kilometres printed as 62 miles is nobody's idea of a distance.

Rejected: **75 miles.** It is 120 km, which from Richmond reaches all of Hampton
Roads, Charlottesville and a Maryland AM, and takes the list from 153 stations
to 260. This is the same error the radius already made once at 200 km, which
reached Baltimore. Two markets away is two markets away whichever unit says so.

The rule that decides any future proposal: **anything beginning "but you can
hear X from here" is arguing for the band view, not for this list.** Nearby
answers what is close; what can be heard is a different question and this data
cannot answer it.

In kilometres it prints as 97, which is not round. The alternative was a
different radius per unit, and then toggling units would make eight stations
appear and disappear.

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

## The network is a name, not a logo · 2026-08-23

The Network column stays plain text. No logo artwork, and no coloured brand
chip standing in for one.

The numbers are most of the argument. Of 8,682 television rows, **6,168 (71%)
name no network at all** — LMS is silent for most LPT and LPD. The 2,514 that
do are 340 distinct free-text strings, and collapsing the variants leaves
twelve marks worth drawing over **1,456 rows, 17% of the band**. A column that
is blank in seven rows out of ten, a logo in under two, and free text in the
rest is not scanned; it is decoded. Whatever a logo does for a dense table, it
does not do it at that density.

Rejected: **the logos themselves**, bundled as inline SVG. This is the same
test the entry above applies to data, and logo artwork fails it harder than any
source there did — those at least had terms to read, where a network mark comes
with no reuse grant at all. Nominative use is a real doctrine and listing apps
do lean on it, but an all-rights-reserved app headed for App Store review is
the wrong place to find out how far it reaches, and the finding-out would buy
17% of one column.

Rejected: **a coloured chip carrying the name in the page's own type**, reusing
the `.tag` styling that carries `3.0`. It sidesteps the artwork question, which
was the point of it, but it answers the licensing objection rather than the
coverage one, and coverage is the objection that actually decides this. It also
spends the one badge the table has: `3.0` means something no other cell says,
and a column where most rows carry a coloured chip is a column where the tag
that matters stops standing out.

**The FCC's exact string is what is shown**, unnormalized, as with the licensee.
`Fox` and `FOX` both appear, and both are what was filed.

Reopen this if LMS coverage ever climbs materially above 29% of the band. The
licensing objection would still stand against the artwork; the coverage one
would not.

## A translator says what it relays · 2026-08-23

The same LMS facility table carries `primary_station`, the facility ID of the
station a translator or booster rebroadcasts. It is radio's where the network
is television's — blank on all 15,286 AM, 24,453 FM, 23,374 FX and 7,828 FL
rows for `network_affiliation`, and filed by **every licensed FM translator**
for this one. So the answer to "is there anything in there for AM and FM" was
no for the column we imported it for and yes for the one next to it.

It is shown as a **link to the station's own page**, not as a call sign,
because 99% of primaries resolve to a row this table already publishes. A call
sign copied into a second column would be a second place for it to go stale;
an id is the thing that does not move when the FCC renames a translator to
match a new frequency.

**39.6% of translators point at an AM station.** That is the single fact this
column adds that the app could not otherwise show: K201AH on 88.1 in Kaktovik
is KBRW 680 with an FM signal, and nothing else on the page said so.

Rejected: **a Relays column in the band tables.** This is the entry above
arguing in the other direction — a column has to earn its width, and this one
would be blank on all of AM, all of TV, all of LPFM and 92% of full power FM.
The station page is where a fact that applies to one service in five belongs.

**Both directions are shown, from one column** · amended 2026-08-23. The
reverse — "this AM is also on three translators" — turned out to be the more
useful half, and it needs no data at all: the forward column already holds it,
read backwards. It is indexed once in the client rather than exported again,
because a second column would be the same fact stored twice with two chances
to disagree. 5,253 stations are a primary for at least one relay.

The two directions are shown differently, and the distribution is why. The
median primary has **exactly one** relay, so that list is shown outright —
putting a single translator behind "set a location first" would be ceremony
around one line. But the tail is extreme: KAWZ Twin Falls is the primary for
**346**, KLVR for 168, WAFR for 110, and 21 stations are past twenty. Those are
satellite networks rather than a station with a few fill-ins, and for them the
whole list is no more an answer than 400 co-channel stations was — so past
twenty it falls back to the rule the frequency neighbours already use: nearest
few, and only once a location makes "nearest" mean anything.

## Two sources, two dates · 2026-08-23

`meta.json` carries `generated` for the station queries and `lmsGenerated` for
the LMS facility dump, and the page reports them separately.

They are separate downloads on separate schedules. `update_data.py LMS` fetches
that one alone, and `lms_url` walks back up to four days for a dump that
answers — so a run that reports no failure can pair today's station table with
Tuesday's facility table, and `network`, `atsc3` and `relay` all come from the
second one. This is not hypothetical: `data/raw/` sat for three days with query
files from the 20th beside an LMS dump from the 22nd, and nothing anywhere said
so.

Rejected: **one date covering both**, taken as the newer of the two. That lets
a fresh station table vouch for a stale facility table, which is precisely the
thing worth knowing. A single date is only honest when there is a single
source.

Rejected: **the file's mtime** as the LMS date. That records when the download
happened, not which day's dump it is — fetch Tuesday's file on Friday and the
mtime says Friday, which is the walk-back failure reported as success. The zip
carries the FCC's own build timestamp on its entry and it survives the
transfer, so the dump dates itself.

**The footer names the LMS date only when it differs.** A second date on every
build is noise nine times in ten, and the tenth is the one that matters; About
states it either way, because a reader there is asking where the network and
the relay came from. `verify.py` warns past four days apart — `lms_url`'s own
budget, so inside it the fetcher is working as designed — and errors past
thirty.

## HD Radio is noted, not mapped · 2026-08-23

The `digital` column records whether a station runs hybrid, analog or
all-digital, and nothing else. 2,442 live transmitters run hybrid — 2,183 of
them full power FM, about 18% of the band.

**No digital frequency is published.** HD Radio is in-band on-channel: the
sidebands sit on the same channel as the analog signal, from the same
transmitter, under the same licence, both sides at once. There is no second
dial position to list, and this app's frequency column means where you set the
radio.

Rejected: **per-station sideband edges.** The offset is fixed by NRSC-5 —
subcarriers 356 to 546 at 363.37 Hz, so 129.4 to 198.4 kHz either side of
centre — which makes those numbers `freq ± constant`, identical for every row.
238 KB of arithmetic against 45 KB for the flag. And they would assert a
service mode the FCC file does not carry: the outer edge holds in every hybrid
mode, the inner edge moves under extended hybrid, and nothing in LMS says which
a station runs. The rule goes in DATA.md and About, where it can hedge; a
stored number cannot.

Rejected: **chasing the mode and sideband power** through another LMS table.
Power is what decides how badly a hybrid station splatters — −20 to −10 dBc,
asymmetric permitted — so it would genuinely improve the answer. But it is an
unexamined dependency for a column whose useful claim is already complete: that
digital energy exists at a known offset. Reopen it if the interference view
ever needs to rank rather than flag.

**Blank means not stated, and is written that way.** `A` is filed explicitly on
ten thousand rows, so silence is silence — 45% of live FM and 78% of AM. The
station page shows no Transmission row rather than one reading "not stated" on
most of the band.

**All-digital gets its own tag**, not the hybrid one. There are two of them and
they have no analog signal, so an ordinary radio tuned there hears nothing —
the opposite of what an HD tag on a hybrid row promises.

Television is excluded. The column is filled there too, where it means digital
television rather than HD Radio, and would tag every DTV row while meaning
nothing.

Rejected: **storing the raw facility number when it resolves to nothing.** 66
primaries are silent, foreign or lapsed. A dangling id is worse than a blank
because the reader cannot tell it is dangling.

Deferred: **television translators.** LPT and LPD file primaries too, a few
hundred of them, but a TV id is facility plus a site tag, so a bare facility
does not name one transmitter and picking a site would invent the part the FCC
did not say. `verify.py` errors if a TV row ever acquires a relay, so this
stays a decision rather than becoming an accident.

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
