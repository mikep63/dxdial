# The data pipeline, in full

Everything the build does to the FCC's records between downloading them and
publishing `docs/data/stations.csv`. Written down because the conversions have
to be repeatable — the iOS app will consume the same table, and anyone
rebuilding this from scratch needs to land on the same numbers.

Run order:

```sh
python3 update_data.py     # 1. fetch          -> data/raw/*.txt
python3 build_site.py      # 2. convert        -> docs/data/*.csv
python3 verify.py          # 3. check          -> exit 1 if unfit
```

The weekly workflow runs all three and refuses to publish if step 3 fails.

---

## 1. Sources

Five queries, one per service. The FCC exposes no combined table.

| File | Query | `serv=` | What it is |
|---|---|---|---|
| `fm.txt` | `fcc-bin/fmq` | `FM` | Full power FM |
| `fl.txt` | `fcc-bin/fmq` | `FL` | Low power FM (LPFM) |
| `fx.txt` | `fcc-bin/fmq` | `FX` | FM translators |
| `fb.txt` | `fcc-bin/fmq` | `FB` | FM boosters |
| `am.txt` | `fcc-bin/amq` | — | AM (its own CGI) |

Both CGIs take `list=4` (pipe-delimited output) and `size=9`. The AM query
additionally takes `freq=530&fre2=1700&type=0`.

### Service codes deliberately not fetched

**`FS`** returns 2,128 records that are already in `fm.txt` — 2,112 of the
call-and-frequency pairs and 2,116 of the facility IDs are shared, and the
classes are the full power ones. Fetching it double counts two thousand
stations.

### Three rules about the host

1. **Use `transition.fcc.gov`.** The same data via `www.fcc.gov` returns 403,
   then 429, then stops answering for minutes.
2. **The User-Agent needs a `product/version` token.** `dxdial/1.0` is
   served; a bare `dxdial-updater` gets a flat 403. This is not rate
   limiting, does not clear on its own, and so is never retried.
3. **Avoid Wednesday 18:00 – Thursday 08:00 US Eastern.** LMS, which these
   queries read, is down for maintenance and will return nothing or a partial
   table.

A response under 500 KB (50 KB for boosters, a genuinely small service) is
treated as a failed fetch: it is saved as `.partial` and the previous good copy
is left in place.

---

## 2. Raw record layout

One record per line, fields separated by `|`, with a leading `|`. Splitting on
`|` therefore puts an empty string at index 0 and the call sign at index 1.

Both bands share the same geometry from index 18 onward — this is what lets one
parser read both.

| Index | FM | AM |
|---:|---|---|
| 1 | Call sign | Call sign |
| 2 | Frequency (`88.1  MHz`) | Frequency (`550   kHz`) |
| 3 | Service code | `AM` |
| 4 | Channel | Subtype (`NCE`, `CRI`, blank) |
| 5 | `ND` / `DA` | Hours: `DAY` / `NIG` / `UNL` / `CRI` |
| 6 | Polarisation (`H`, blank) | Hours label |
| 7 | **Class** | **Class** |
| 9 | **Status** | **Status** |
| 10 | City of licence | City of licence |
| 11 | State | State |
| 12 | Country | Country |
| 13 | Application number | Application number |
| 14 | ERP horizontal (kW) | **Power (kW)** |
| 15 | ERP vertical (kW) | Pattern (`Directional`, blank) |
| 16 | HAAT horizontal (m) | — |
| 17 | HAAT vertical (m) | — |
| 18 | **Facility ID** | **Facility ID** |
| 19 | N/S | N/S |
| 20–22 | Latitude d / m / s | Latitude d / m / s |
| 23 | E/W | E/W |
| 24–26 | Longitude d / m / s | Longitude d / m / s |
| 27 | Licensee | Licensee |

Lines not beginning with `|` are the CGI's plain-text preamble and are skipped.
Files are read as **latin-1**; licensee names contain bytes that are not valid
UTF-8.

---

## 3. Conversions

### Coordinates — DMS to signed decimal

```
decimal = degrees + minutes/60 + seconds/3600
negated when the hemisphere is S or W
rounded to 6 places
```

**Datum is not recorded.** Older records are NAD27, newer ones NAD83, and no
column says which. The two differ by roughly 100 m. Measured against the FCC's
own distance figures over 59 stations, the mean disagreement is 0.106 km, which
is that datum spread. Everything here treats the coordinates as one datum. Do
not add a datum conversion without a column to drive it.

### Numeric fields

Columns may be blank, `-`, or carry a unit suffix (`kW`, `MHz`, `kHz`). Strip
the unit; treat blank and `-` as null. Null is not zero — a blank ERP means not
recorded, and rendering it as 0 kW is a false statement about the station.

### ERP and HAAT — collapsing horizontal and vertical

FM carries each figure twice, horizontal and vertical. Which one holds the real
number depends on how the station radiates: a vertical-only station has `-` for
ERP-H and `0.0` for HAAT-H.

```
erp  = max(erp_h,  erp_v)    ignoring nulls
haat = max(haat_h, haat_v)   ignoring nulls
```

**HAAT can legitimately be negative** — a transmitter below the surrounding
terrain. `-9.0` and `-102.0` both occur. Do not treat a negative as missing.

### AM power — day and night

AM emits a separate record per operating period. The power column means
different things depending on index 5:

| Index 5 | Assigned to |
|---|---|
| `DAY` | `erp` |
| `NIG` | `erp_night` |
| `UNL` | both |
| `CRI` | neither (critical hours, a distinct condition around sunrise and sunset) |

---

## 4. Records dropped

| Rule | Why |
|---|---|
| Call sign is `NEW`, `-`, or blank | An unbuilt allotment, not a station. Near the borders these were a quarter of the foreign rows and would render as phantoms on real frequencies. |
| Status in `CNL`, `EXP`, `DEL` | Cancelled. Nothing to tune to. |
| Latitude or longitude unparseable | Cannot be placed or measured from. |
| Coordinates outside the country's bounds | See below. |

### The bounds test

Generous per-country boxes (`fcc.COUNTRY_BOUNDS`), covering the contiguous US,
Alaska, Hawaii, Puerto Rico and the USVI, Guam and the Northern Marianas, and
American Samoa; plus Canada and Mexico. Only those three countries are checked
— the AM query carries thirty-odd more, and an unchecked record is kept as it
stands.

The job is catching a dropped digit, not policing a border.

**This finds real errors in the FCC's file.** `XECSMO` in Morelia is filed at
`W 10 11 31` instead of `W 101 11 31`, putting a Mexican AM station in the
Atlantic off Morocco — while the record for another Morelia station two lines
away has the longitude right. A station in the wrong ocean is worse than a
station absent, because it silently corrupts every distance computed from it.
The build names each record it drops this way.

---

## 5. Merging — several records into one station

Identity key, in order of preference:

1. `(service, facility_id)` when the facility ID is present and not `0` or `-`.
2. `(service, call, freq, country)` otherwise. Foreign records notified under
   the coordination agreements sometimes carry no facility ID.

Two distinct collapses happen:

**Application records.** One facility emits a licence plus any pending
modification or permit. The most authoritative wins, ranked:

```
LIC > STA > MOD > CP > NCECP > NCECPA > APP > EXT
```

Note that `status` is a *column*, not a query filter — asking the CGI for
`status=L` returns exactly the same rows as asking for nothing. Filtering has
to happen here.

**AM day and night rows.** Merged into one station carrying both powers.
Whichever of `erp` / `erp_night` a record has that the kept one lacks is taken
across **regardless of status rank**, so a lower-ranked record still
contributes its half of the pair. `directional` is sticky **on AM only**: if any
AM record for the facility is directional, the station is, because a station
directional after dark files the pattern on its night row alone.

FM is not sticky. A second FM row is a pending proposal rather than the other
half of one station, and 183 facilities file a licensed ND against a MOD
proposing DA. Stickiness there would advertise an antenna nobody has built, so
the flag comes from whichever record wins on status rank.

Roughly 47,600 raw rows reduce to 35,200 stations.

---

## 6. Derived fields

### `live` — on the air, or merely proposed

This is the column the app filters on, and it exists because **`status` cannot
be read the same way on both bands.**

The FM query covers four countries, and its foreign records carry an honest
`LIC`. The AM query covers thirty-eight — medium wave crosses the hemisphere
after dark, so the Region 2 agreements have every country notify its
assignments. The FCC cannot license a station in Havana or São Paulo, so it
files all of them as `CP`. Read literally, that marks about 7,300 real foreign
stations as unbuilt proposals.

```
live = false                             if status in {CNL, EXP, DEL}
     = status in {CP, LIC}               if band is AM and country is not US
     = status in {LIC, STA}              otherwise
```

`status` is published alongside `live` unaltered, so nothing is lost.

### `hours` — AM only

Restated after the day and night rows are merged:

| Value | Meaning |
|---|---|
| `U` | Unlimited (was a single `UNL` record) |
| `DN` | Separate day and night operation |
| `D` | Daytime only |
| `N` | Night figure only |

### `id`

`service + facility_id`, e.g. `FM121839`. Where there is no facility ID,
`service-call-freq` with the decimal point stripped.

Stable across builds, which is what makes the change log possible.

---

### `relay` — what a translator rebroadcasts

Radio only. The LMS `facility` table carries `primary_station`, the facility ID
of the station a translator or booster repeats, and `attach_lms` resolves it to
an `id` in this same table so it names a station rather than a number.

Coverage is effectively total where the concept applies, which is what makes a
blank readable:

| Service | Licensed | Files a primary | Resolves |
|---|---|---|---|
| `FX` translators | 8,470 | 8,437 (100%) | 8,393 (99%) |
| `FB` boosters | 414 | 333 (80%) | 321 |
| `FM` | 12,143 | 1,039 (9%) | 1,024 |
| `AM` | 7,675 | 90 (1%) | 45 |
| `FL` LPFM | 2,017 | **0** | 0 |

LPFM's zero is the rule rather than an omission: an LPFM may not rebroadcast
another station. **39.6% of translators with a primary point at an AM station**
— the arrangement that moved most of AM's programming onto the FM band.

Two deliberate blanks:

- **A primary not in this table** — silent, foreign, or lapsed — leaves the
  cell empty rather than storing a facility number that points at no page. A
  dangling id is worse than an absent one because a reader cannot tell it is
  dangling. 66 records at the time of writing.
- **Television**, though the file carries a few hundred TV translators. A TV
  `id` is facility *plus* a site tag, so a bare primary facility does not name
  one transmitter, and choosing a site would invent the part the FCC did not
  say. `verify.py` errors if a TV row ever acquires one.

Like `network`, this is licence data: what was filed, not what is modulating
the carrier tonight.

## 7. Output schema — `docs/data/stations.csv`

| Column | Type | Units | Null? | Notes |
|---|---|---|---|---|
| `id` | string | | no | Stable across builds |
| `band` | `AM` \| `FM` \| `TV` | | no | |
| `service` | `AM` \| `FM` \| `FL` \| `FX` \| `FB` \| `DTV` \| `DTS` \| `DCA` \| `DRT` \| `LPT` \| `LPD` | | no | |
| `call` | string | | no | May carry a suffix: `KEXP-FM`, `KHPR-FM1` |
| `freq` | number | MHz (FM), kHz (AM) | no | FM one decimal; AM integer |
| `status` | string | | no | Raw FCC value, unaltered |
| `live` | `1` \| empty | | no | See above |
| `class` | string | | yes | National systems differ: `A1` is Canadian, `AA` Mexican, `LP1`/`LP2` LPFM |
| `city` | string | | no | City of licence, **not** transmitter location |
| `state` | string | | yes | Blank for some foreign records |
| `country` | string | | no | 38 values; `US`, `CA`, `MX` predominate |
| `lat` | number | degrees | no | Signed decimal, 6 places |
| `lon` | number | degrees | no | Signed decimal, 6 places |
| `erp` | number | kW | yes | AM: daytime power |
| `erp_night` | number | kW | yes | AM only |
| `haat` | number | m | yes | FM only; **may be negative** |
| `hours` | string | | yes | AM only |
| `directional` | `Y` \| empty | | yes | Both bands. Empty means non-directional on FM, and either that or unfiled on AM |
| `licensee` | string | | yes | May contain commas — the CSV is quoted, so parse it properly |
| `channel` | integer | | yes | TV only — the RF channel, which decides the antenna |
| `virtual` | integer | | yes | TV only — the number the set displays. Blank on ~70% of licensed TV, nearly all of it low power |
| `network` | string | | yes | TV only, from LMS. Free text as filed: `FOX` and `Fox` both occur. `Independent` is a value; blank means none filed |
| `atsc3` | `Y` \| empty | | yes | TV only, from LMS |
| `relay` | string | | yes | Radio only, from LMS. The `id` of the station this one rebroadcasts — see below |

Line endings are LF. `.gitattributes` normalises on commit, so writing CRLF
would leave the file modified after every build with no content change.

### `docs/data/changes.csv`

Appended each build: `date, change, id, band, call, freq, city, state, detail`.
`change` is `added`, `removed`, or the name of the field that moved.

Tracked fields: `call`, `freq`, `status`, `city`, `state`, `erp`, `lat`, `lon`,
`channel`, `network`, `relay`. Licensee is excluded — it moves on every
ownership deal and would drown the rest.

A tracked column the previous table did not have is not thousands of stations
changing at once; it is a column arriving. `write_changes` detects that and
does not log the first values, which is why adding `network` and then `relay`
each wrote zero entries rather than several thousand.

---

## 8. Verification

`verify.py` gates publication. Errors block; warnings do not.

**External check.** US on-air counts are compared against the FCC's own
Broadcast Station Totals, published quarterly by the Media Bureau and compiled
independently of these queries. This is the only genuinely independent check
available and is what caught the missing booster service.

As of the 2026-03-31 release, with a 5% tolerance for drift between quarterly
publication and any given night:

| Service | FCC published | Built |
|---|---:|---:|
| AM | 4,310 | 4,284 |
| FM full power | 11,357 | 11,364 |
| Translators + boosters | 8,854 | 8,844 |
| LPFM | 2,007 | 2,020 |

Update `FCC_TOTALS` in `verify.py` when a new release comes out; it is prose,
not a feed.

**Other checks:** unique ids, required fields present, numbers parse,
coordinates in range and not `0,0`, `live` follows the documented rule, FM on
the 200 kHz channel grid and AM on the 10 kHz one, power within service limits,
class recognised for its country, coordinates inside the country's bounds,
build freshness, and continuity against the previous build.

### Things the checks must not flag

Each of these was a false positive once, and each cost time:

- **FM channel grid arithmetic must be done in integer tenths.** `88.1` and
  `87.9` are both inexact in binary; `(88.1 - 87.9) * 5` evaluates to
  `0.9999999999999432`, which fails an equality test for every station on the
  band.
- **Guam and the Northern Marianas are ITU Region 3**, where AM is spaced every
  9 kHz, not 10. `KGUM` on 567 and `KTWG` on 801 are correct.
- **Grandfathered superpower FM is real.** `WBCT` Grand Rapids runs 320 kW and
  `WLFP` Memphis 300 kW, both licensed before the class limits. Canada licenses
  higher than the US outright — `CFPL-FM` London runs 380 kW.
- **American Samoa is south of the equator**, at roughly −14.3, −170.7.
- **`A1` is a Canadian FM class and `AA` a Mexican one.** Neither exists in the
  US system.

---

## 9. What this data cannot tell you

- **Whether a station is actually broadcasting.** A licence survives up to
  twelve months of silence under 47 U.S.C. 312(g), and nothing here marks it.
  `live` means "licensed and not a proposal", which is a weaker claim than "on
  the air". Closing this needs the FCC's separate silent-station lists.
- **What a station plays.** The FCC licenses transmitters, not programming.
  Format is the attribute most likely to change and is absent entirely.
- **Whether you can receive it.** These are transmitter locations and powers.
  Terrain is not modelled. On AM, groundwave depends on soil conductivity and
  skywave rewrites the band after dark.
- **City of licence is not the transmitter.** It is a regulatory designation;
  the transmitter is often tens of kilometres away. Use `lat`/`lon` for
  distance, never the city.
