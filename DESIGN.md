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
neither export carries one. Direction-aware ranking would need the LMS antenna
tables, which is a separate dependency and real maths.

*Corrected 2026-08-23.* This said the exports "carry no azimuth data at all —
only a directional boolean", and that is not true of FM. There is a degrees
field, filled for exactly the 2,792 directional stations and never for the
10,351 non-directional ones. It changes nothing, which is why the conclusion
above stands: **97% of its values are 0.0**, and the rest cluster on small
angles and multiples of five, so it is the *rotation* applied to a filed
pattern rather than the direction the antenna favours. Without the pattern it
is unusable, and the pattern is in the LMS antenna tables. AM carries nothing
of the kind — checked column by column.

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

**Nearby counts them per band; there is no HD filter** · added 2026-08-23. The
band headings read `FM 104 · 16 in HD`, which answers what a filter would have
been built for — how much of what is around you is in HD — without hiding
anything.

Rejected: **an "HD only" checkbox** in the shared filter bar. It passes the test
in *Nearby is exhaustive* on its face, since it asks what kind of thing a
station is rather than whether you would hear it. It fails on the data. The FCC
leaves `digital_operation` blank on **56% of live FM within sixty miles of
Richmond** — 58 stations of 104 — so the checkbox would present sixteen as the
HD stations and silently drop fifty-eight whose status is unrecorded rather
than negative. **A blank is not a no, and a filter has nowhere to put
"unknown".** That is the power filter's defect wearing a different hat.

It would also have emptied the TV band in silence, since `digital` is radio's
by design, so the control would read as broken rather than deliberate.

A three-way — All / HD / Not stated — would be honest, because the unknowns
become somewhere you can go instead of a silent omission. It is more control
than the question earns while the tag is already on the row, and is the shape
to reach for if this is ever reopened.

## The code in the table, the country on the page · 2026-08-23

Tables keep the two-letter country code; the station page spells it out. A
column has to be narrow and a page does not, and `MX` beside 3,011 Mexican rows
is the right trade in a table that is scanned rather than read.

**The names are built from evidence, not from an ISO table.** These are the
FCC's own abbreviations, and ten of the 38 collide with ISO 3166 on a different
country — so a standard lookup does not fail, it returns something plausible
and wrong. Each name was checked against the transmitter coordinates and the
ITU call sign prefix, which is allocated by country and cannot be argued with.

The case that decided the approach: **`PA` is Paraguay and `PM` is Panama.** An
ISO map labels 59 Paraguayan stations "Panama" while Panama sits in the same
table under another code, so every symptom of the bug looks like correct data.
`ES` is El Salvador rather than Spain and `VI` is the *British* Virgin Islands
by the same kind of margin.

Rejected: **the full 38-row table in About.** The app is the lookup — tap a
station and read the name — so a table there is a second, worse copy of what
the page already does, and 38 rows of mostly-obvious mappings to reach the ten
that matter. About instead names the traps in a paragraph and says the habit
out loud: look, do not translate.

Rejected: **falling back silently to the code** when a name is missing. The
page does fall back, but `verify.py` errors on any exported code without a
published name, so the fallback is a safety net rather than a behaviour. Two
letters nobody can decode is not what a page promising a country should show,
and the next new code will be as unguessable as `BF` for the Bahamas.

`MA` and `ME` are single miscoded Mexican records and are named Mexico, which
is a correction of the source rather than a reading of it — recorded in DATA.md
so it is visible rather than folded in.

## AM power is two rows, and Hours is gone · 2026-08-23

The station page gives **Daytime power** and **Night power** as separate lines,
and a daytimer's night line reads *Off the air*. One row saying "1 kW" was true
of half the day and silent about the other half — the half a DXer is awake for.

Tables carry a **day** or **night** tag beside the power instead, on the same
furniture as HD and 3.0. 1,529 live daytimers and 120 night-only, all AM.

**The Hours row was removed rather than kept beside them**, and this is not a
judgement call: `_hours()` in `fcc.py` *computes* that code from which of the
two powers are filed. It was never independent information. Checked across all
11,605 AM records, and the only thing it added was `U` against `DN` — which is
a filing artifact, since 3,582 `DN` rows file identical day and night powers.
The `hours` column stays in the export for a reader that wants the FCC's code.

Two gaps this closed on the way past. Night-only stations file night power and
no day power, so keying the table cell off `erp` left all 120 with an **empty
Power column**, and `powerLabel` returned *not filed* for a power that is filed
perfectly well, just for the other half of the day.

**The line is sunset, not a clock hour**, and the app already worked that way —
`sunTimes` solves the sunrise equation at the reader's location, good to about
a minute, which is finer than the quarter-hour rounding in the FCC's own
licences. Documented in About rather than changed.

Known and not fixed: **`signsOff` uses the reader's night, where the FCC rule
is the station's**. A daytimer three time zones west is still on for hours
after dark here, which is precisely when its skywave starts arriving — so the
dial dims the most interesting rows on a winter evening. The fix is to solve
the sun at the station's own coordinates, which `sunTimes` already accepts;
what needs deciding first is whether the manual Day/Night override should mean
"night here" or "night there".

Not available at all: **pre-sunrise and post-sunset authority**. Many daytimers
hold one and run low power either side of the licensed hours. The AM query
files only `DAY`, `NIG`, `UNL` and `CRI`, so this cannot be shown per station,
and About says so rather than letting *Off the air* read as a promise.

## The transport stream ID is searchable, the market is not carried · 2026-08-23

An audit of both feeds for unused fields turned up two worth having. One was
built, one was built and removed.

**`tsid` is carried, shown, and searchable.** 1,880 of 1,881 live full power TV
file one, plus 98% of Class A and 55% of low power digital. It is the only
field in either feed a reader arrives *already holding* — the tuner has shown
them a number and the question is which station it was — so search matching it
is the feature, and the station page showing it is the confirmation of the same
fact from the other side.

Rejected: **a TSID column.** Same argument the relay and the network logo lost.
Nobody scans a column of stream IDs; the use is reverse lookup, and a column
would be blank on every AM and FM row and on three-quarters of TV.

Matched **whole rather than by prefix**, unlike call signs: `306` is not most
of a TSID the way `KEX` is most of a call sign, so prefix matching would answer
a question nobody asked and bury the exact hit under nine others.

**`nielsen_dma_rank` was built and then removed.** It names each full power
station's market — useful in principle, since a station licensed to Wilmington
serving Philadelphia is exactly the confusing case. But it reaches only 32% of
live TV rows, half of those simply repeat the licence city, and **174 of its
395 distinct strings are another of those strings in different case**:
`LAS VEGAS` beside `Las Vegas`, `SACRAMNTO-STKTON-MODESTO` beside
`Sacramnto-Stkton-Modesto`. Two stations in one market would print it two ways.
Normalizing the case is the licensee-normalization decision, already declined —
and where the licensee string is at least right 95% of the time, this one
disagrees with itself 44% of the time. 16% incremental value for that is a bad
trade.

Also considered and not taken: `expiration_date` (administrative),
`station_type` (99% one value), `satellite_tv_ind` (a value on 290 rows),
`facility_type` — commercial against educational, 100% of licensed FM, but its
use to a listener is as a proxy for programming, which is the formats decision
wearing a licence class as a hat. `tsid_ntsc` identified the analog
transmission and analog television ended in 2009.

## The rest of the LMS tables were looked at, and left · 2026-08-23

The bulk endpoint that serves `facility.zip` serves a great deal more, on the
same URL pattern, the same daily cadence and the same public-domain terms. It
was audited in full and **nothing was taken.** Written down so the same
afternoon is not spent twice.

Confirmed to exist: **`app_antenna`** (15.7 MB — FM and TV antenna records,
major lobe direction, rotation, beam tilt, make, model, gain), **`app_am_antenna`**
(7.7 MB — AM antenna systems with separate `DAY` and `NIG` modes, a directional
flag and RMS field values), and the large `application` and `app_location`
join tables. `app_am_tower` and `app_am_augmentation` very probably exist too —
they time out where a missing table 404s instantly.

Confirmed absent: any pattern-points table. `app_antenna_field`,
`app_am_pattern`, `antenna`, `license` and `am_ant_sys` all 404. The legacy
CDBS path on transition.fcc.gov returns 403.

Both antenna tables were downloaded and read rather than guessed at, and three
things rule them out together:

- **They join on the wrong key.** `facility.zip` matches on facility ID at
  100%, which is why it was a day's work. These carry `aapp_application_id` and
  `aant_antenna_record_id` — opaque UUIDs, with no facility ID or call sign
  anywhere in the table. Reaching a station means adding `application` and
  `app_location`, both big enough that a HEAD request times out. Three tables,
  not one.
- **They are application history, not current licences.** `app_antenna` holds
  **340,328 rows** — every application ever filed, superseded ones included.
  Choosing the operative record per station is a problem in its own right
  before any value appears.
- **They carry parameters, not patterns.** `aant_major_lobe_dir` is filled on
  **1%** of those rows. The AM side does give real day and night antenna
  systems, but field against azimuth still has to be *computed* from tower
  spacing, orientation, field ratio and phasing, plus augmentations.

Which is precisely what the signal-model entry above predicted — "a separate
dependency and real maths" — and it can now be said with numbers rather than
as an expectation.

**What would reopen it:** deciding that direction-aware ranking is worth a
project rather than a column. The scope is three new tables, a record-version
selection problem, and an implementation of the AM directional array equation.
Nothing smaller in these files is worth having: the best of the rest is antenna
make and model at 63% fill, which is trivia rather than something anyone tunes
on.

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
