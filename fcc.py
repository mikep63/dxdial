#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Mike Parker <mike@rsbl.org>
# SPDX-License-Identifier: LicenseRef-AllRightsReserved
"""Turn the FCC's AM, FM and TV query output into one normalized station table.

The FCC serves these as pipe-delimited text. Both bands put the facility ID,
the transmitter coordinates and the licensee in the same columns, so one
geometry reads both; only the columns before those differ per band.

Four things in the raw data produce a wrong app if taken at face value:

  * A licensed record does not mean a station on the air. A station may sit
    silent for up to twelve months under 47 U.S.C. 312(g) and still read as
    LIC here. Nothing in this file can tell them apart -- that needs the FCC's
    separate silent lists, which is why status is carried through unaltered
    rather than collapsed to a boolean.
  * A call sign of NEW or - marks an unbuilt allotment, not a station. Near the
    Canadian and Mexican borders these were a quarter of the foreign rows, and
    they would render as phantom stations sitting on real frequencies.
  * One facility emits several rows -- a licence plus any pending modification
    or construction permit. Status is a column here, not a filter: asking the
    query for status=L returns the same rows as asking for nothing.
  * An AM facility emits a row per operation, DAY and NIG separately, or a
    single UNL row for unlimited-time stations. Day and night power differ by
    an order of magnitude and the pattern usually differs too, so the two rows
    are one station with two power figures, not two stations.

Coordinates are degrees/minutes/seconds against NAD27 in the older records and
NAD83 in the newer ones, with no column saying which. The difference runs to
about 100 m, which is under the error of any propagation estimate built on
these figures, so this reads them all as one datum and does not pretend
otherwise.

The two bands do not cover the same ground, and the status column does not mean
the same thing in both.

The FM query returns the United States plus the strip of Canada and Mexico
covered by the border coordination agreements -- four countries in all -- and
those foreign records carry an honest LIC.

The AM query returns thirty-seven countries. Medium wave carries across the
hemisphere after dark, so the Region 2 agreements have every country notify its
assignments, and the FCC files all of them. It has no authority to license a
station in Havana or Sao Paulo, so it files them as CP. Read literally, that
marks five thousand Mexican and two thousand Brazilian stations as unbuilt
proposals; is_live below is what keeps them from being thrown away with the
genuine permits.
"""
import os
import zipfile
from datetime import date


# Column positions after splitting a line on "|". Index 0 is the empty string
# before the leading pipe, so these run one higher than they look.
_CALL, _FREQ, _SERVICE = 1, 2, 3
_STATUS, _CITY, _STATE, _COUNTRY = 9, 10, 11, 12
_FACILITY = 18
_NS, _LAT_D, _LAT_M, _LAT_S = 19, 20, 21, 22
_EW, _LON_D, _LON_M, _LON_S = 23, 24, 25, 26
_LICENSEE = 27

# FM-only columns. The horizontal and vertical figures pair up: a station
# radiating only vertically carries "-" for ERP-H and 0.0 for HAAT-H.
#
# _FM_PATTERN is DA or ND, and every row carries one -- unlike AM, where the
# column is the word "Directional" or nothing at all. It shares an index with
# _AM_HOURS below and means something else entirely; the columns before the
# shared geometry differ per band, as the module docstring says.
_FM_CLASS = 7
_FM_PATTERN = 5
_FM_ERP_H, _FM_ERP_V, _FM_HAAT_H, _FM_HAAT_V = 14, 15, 16, 17

# AM-only columns.
_AM_HOURS, _AM_CLASS, _AM_POWER, _AM_PATTERN = 5, 7, 14, 15

# TV-only columns. The shared geometry -- call, service, status, city, state,
# country, facility, lat/lon -- sits where FM puts it, and so do ERP and HAAT,
# so _parse_common and the _FM_ERP/_FM_HAAT indices read a TV row unchanged.
# Three columns do differ:
#
# _FREQ, which carries "88.1  MHz" on FM, is empty on every TV row. The RF
# channel takes its place at _TV_CHANNEL, and _TV_VIRTUAL holds the number the
# set displays -- 15 for WHDF, which transmits on RF 2. Both were confirmed
# against RabbitEars for that station, along with facility 65128 at _FACILITY.
#
# Index 7 is the FCC's TV zone, 1 to 3. It is not a class, and nothing here
# reads it: a TV station's class is its service code.
_TV_CHANNEL, _TV_VIRTUAL = 4, 38
_TV_PATTERN = _FM_PATTERN

# Generous bounding boxes per country, used only to throw out a record whose
# coordinates cannot be what it says they are. They are deliberately loose --
# the job is catching a dropped digit, not policing a border.
#
# The FCC's file does contain such errors. XECSMO in Morelia is filed at
# W 10 11 31 rather than W 101 11 31, which puts a Mexican AM station in the
# Atlantic off Morocco; the record for another Morelia station two lines away
# has the longitude right. A station in the wrong ocean is worse than a station
# absent, because it silently corrupts every distance calculated from it.
#
# Only countries with a box are checked. The AM query carries thirty-odd more
# and an unchecked record is kept as it stands.
COUNTRY_BOUNDS = {
    "US": [(24.0, 49.5, -125.0, -66.5),      # contiguous
           (51.0, 72.0, -180.0, -129.0),     # Alaska
           (18.5, 22.5, -161.0, -154.5),     # Hawaii
           (17.5, 18.6, -68.0, -64.5),       # Puerto Rico and the USVI
           (13.2, 20.6, 144.5, 146.2),       # Guam and the Northern Marianas
           (-14.6, -11.0, -171.5, -168.0)],  # American Samoa
    "CA": [(41.5, 84.0, -142.0, -52.0)],
    "MX": [(14.0, 33.0, -119.0, -86.0)],
}

# Records thrown out by the bounds test, so the build can report them rather
# than dropping them silently.
MISPLACED = []


def in_bounds(country, lat, lon):
    boxes = COUNTRY_BOUNDS.get(country)
    if not boxes:
        return True
    return any(la0 <= lat <= la1 and lo0 <= lon <= lo1
               for la0, la1, lo0, lo1 in boxes)


# Placeholder call signs. "NEW" is an application for a station that does not
# exist yet; "-" is a record the FCC has no call sign for.
PLACEHOLDER_CALLS = {"NEW", "-", ""}

# Preference order when one facility has several rows. A licence outranks a
# permit to build something that is not there yet.
_STATUS_RANK = {"LIC": 0, "STA": 1, "MOD": 2, "CP": 3, "NCECP": 4, "NCECPA": 5,
                "APP": 6, "EXT": 7}

# A record for a station that no longer exists. Kept out entirely rather than
# flagged, since there is nothing to tune to.
CANCELLED = {"CNL", "EXP", "DEL"}

# Statuses meaning the record describes something on the air rather than
# something proposed. See the note on the AM band in the module docstring.
ON_AIR = {"LIC", "STA"}


def is_live(row):
    """Whether this record describes a station that exists, not a proposal."""
    if row["status"] in CANCELLED:
        return False
    if row["band"] == "AM" and row["country"] != "US":
        # Every foreign AM assignment is filed as CP because the FCC cannot
        # license one. Treating that as "proposed" would empty the band
        # everywhere south of the border.
        return row["status"] in ("CP", "LIC")
    return row["status"] in ON_AIR

SERVICE_NAMES = {
    "FM": "Full power FM",
    "FL": "Low power FM",
    "FX": "FM translator",
    "FB": "FM booster",
    "AM": "AM",
    "DTV": "Full power TV",
    "DTS": "TV distributed transmitter",
    "DCA": "Class A TV",
    "LPD": "Low power TV",
    # Not analog, which is what this said until 2026-08-22. Analog low power
    # ended in July 2021 and 2,920 of these are licensed and on air. LPT is the
    # translator service: LPD originates programming under an -LD call sign,
    # LPT relays somebody else's.
    "LPT": "TV translator",
    "DRT": "TV replacement translator",
}


def _field(parts, i):
    return parts[i].strip() if i < len(parts) else ""


def _number(text):
    """Read a numeric column, which may be blank, "-", or carry a unit."""
    text = text.replace("kW", "").replace("MHz", "").replace("kHz", "").strip()
    if not text or text == "-":
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _dms(degrees, minutes, seconds, hemisphere):
    """Fold a degrees/minutes/seconds triple into one signed decimal degree."""
    d, m, s = _number(degrees), _number(minutes), _number(seconds)
    if d is None:
        return None
    value = d + (m or 0) / 60.0 + (s or 0) / 3600.0
    return -value if hemisphere.upper() in ("S", "W") else value


def _best(a, b):
    """The larger of two optional figures, keeping one when the other is blank.

    ERP and HAAT arrive split into horizontal and vertical components, and
    which one carries the real number depends on how the station radiates. The
    larger is the one that matters for how far the signal reaches. HAAT can be
    legitimately negative -- a transmitter below the surrounding terrain -- so
    this cannot treat a negative as missing.
    """
    if a is None:
        return b
    if b is None:
        return a
    return max(a, b)


def _identity(row):
    """A key that survives the records having no facility ID.

    US records all carry one. Foreign records notified under the border
    coordination agreements sometimes do not, so those fall back to the call
    sign and frequency, which is enough to collapse a station's duplicate rows.
    """
    if row["facility"] and row["facility"] not in ("0", "-"):
        # One TV facility can hold several licensed transmitters at once. A
        # distributed system runs synchronised sites on one channel, and a
        # replacement translator fills what the main signal lost; KNME-TV in
        # Albuquerque is licensed for two DRT sites 90 km apart alongside its
        # main transmitter. Keyed on facility alone they collapse to one, and
        # which one survives depends on the order the FCC happened to return
        # its rows -- two pulls two hours apart disagreed and wrote 82 phantom
        # coordinate changes into the log. Across all six TV services this was
        # dropping 176 real transmitter sites, which for an app whose job is
        # saying where to point an antenna is the wrong thing to lose.
        #
        # AM and FM stay keyed on the facility. There a second row is a day or
        # night pair or a pending proposal, and collapsing it is the intent.
        if row["band"] == "TV":
            return ("f", row["service"], row["facility"], row["lat"], row["lon"])
        return ("f", row["service"], row["facility"])
    return ("c", row["service"], row["call"], row["freq"], row["country"])


def _parse_common(parts, band):
    call = _field(parts, _CALL).upper()
    if call in PLACEHOLDER_CALLS:
        return None
    if _field(parts, _STATUS).upper() in CANCELLED:
        return None
    lat = _dms(_field(parts, _LAT_D), _field(parts, _LAT_M),
               _field(parts, _LAT_S), _field(parts, _NS))
    lon = _dms(_field(parts, _LON_D), _field(parts, _LON_M),
               _field(parts, _LON_S), _field(parts, _EW))
    if lat is None or lon is None:
        return None  # nothing to place on a map or measure a distance from
    country = _field(parts, _COUNTRY) or "US"
    if not in_bounds(country, lat, lon):
        MISPLACED.append("%s %s %s %.4f,%.4f"
                         % (call, _field(parts, _CITY), country, lat, lon))
        return None
    return {
        "band": band,
        "call": call,
        "service": _field(parts, _SERVICE),
        "status": _field(parts, _STATUS),
        "city": _field(parts, _CITY),
        "state": _field(parts, _STATE),
        "country": country,
        "facility": _field(parts, _FACILITY),
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "licensee": _field(parts, _LICENSEE),
        # Only TV fills these in. They are declared for every band so the
        # writer can read them off any row without asking which band it is.
        "channel": None,
        "virtual": None,
    }


def parse_fm(line):
    parts = line.split("|")
    row = _parse_common(parts, "FM")
    if row is None:
        return None
    freq = _number(_field(parts, _FREQ))
    if freq is None:
        return None
    row.update({
        "freq": round(freq, 1),
        "class": _field(parts, _FM_CLASS).replace("-", ""),
        "erp": _best(_number(_field(parts, _FM_ERP_H)),
                     _number(_field(parts, _FM_ERP_V))),
        "erp_night": None,
        "haat": _best(_number(_field(parts, _FM_HAAT_H)),
                      _number(_field(parts, _FM_HAAT_V))),
        "hours": "",
        "directional": "Y" if _field(parts, _FM_PATTERN).upper().startswith("D") else "",
    })
    return row


# The US channel plan, as four contiguous runs with gaps between them. A
# channel is 6 MHz wide and the figure kept is its centre, so the frequency
# column means the same thing on every band and a reader that knows nothing
# about channels can still sort by it. Channel 37 is not in the plan at all --
# it is reserved for radio astronomy, and no record uses it.
_TV_BANDS = ((2, 4, 54), (5, 6, 76), (7, 13, 174), (14, 83, 470))


def _tv_frequency(channel):
    for first, last, base in _TV_BANDS:
        if first <= channel <= last:
            return base + (channel - first) * 6 + 3
    return None


def parse_tv(line):
    parts = line.split("|")
    row = _parse_common(parts, "TV")
    if row is None:
        return None
    channel = _number(_field(parts, _TV_CHANNEL))
    if channel is None:
        return None
    freq = _tv_frequency(int(channel))
    if freq is None:
        return None  # outside the channel plan; nothing to place on a dial
    virtual = _number(_field(parts, _TV_VIRTUAL))
    row.update({
        "freq": freq,
        "channel": int(channel),
        # Blank on 70% of licensed records -- every LPT, nearly every LPD. The
        # major channel is assigned with a full power licence and low power
        # mostly has none, so this is absent rather than unknown, and the app
        # falls back to the RF channel it always has.
        "virtual": None if virtual is None else int(virtual),
        # A TV station's class is its service code, so there is no letter to
        # carry. Left empty rather than invented.
        "class": "",
        "erp": _best(_number(_field(parts, _FM_ERP_H)),
                     _number(_field(parts, _FM_ERP_V))),
        "erp_night": None,
        "haat": _best(_number(_field(parts, _FM_HAAT_H)),
                      _number(_field(parts, _FM_HAAT_V))),
        "hours": "",
        "directional": "Y" if _field(parts, _TV_PATTERN).upper().startswith("D") else "",
    })
    return row


def parse_am(line):
    parts = line.split("|")
    row = _parse_common(parts, "AM")
    if row is None:
        return None
    freq = _number(_field(parts, _FREQ))
    if freq is None:
        return None
    hours = _field(parts, _AM_HOURS).upper()
    power = _number(_field(parts, _AM_POWER))
    row.update({
        "freq": int(freq),
        "class": _field(parts, _AM_CLASS).replace("-", ""),
        # Held apart until merge() folds a facility's rows together, because
        # which figure this is depends on the row's hours column.
        "erp": power if hours in ("DAY", "UNL") else None,
        "erp_night": power if hours in ("NIG", "UNL") else None,
        "haat": None,
        "hours": hours,
        "directional": "Y" if _field(parts, _AM_PATTERN).upper().startswith("D") else "",
    })
    return row


def merge(rows):
    """Collapse each facility's rows into one station.

    Two distinct collapses happen here. Several application records for one
    facility reduce to the most authoritative -- a licence over a permit. An
    AM station's DAY and NIG rows reduce to one station carrying both powers.
    """
    stations = {}
    for row in rows:
        key = _identity(row)
        kept = stations.get(key)
        if kept is None:
            stations[key] = dict(row)
            continue
        # Day and night powers live on separate rows; take whichever this row
        # has that the kept one lacks, whatever their relative status.
        for field in ("erp", "erp_night"):
            if kept.get(field) is None and row.get(field) is not None:
                kept[field] = row[field]
        # Sticky on AM for the same reason the powers are: the DAY and NIG rows
        # are one station, and a station directional only after dark files the
        # pattern on the night row alone. FM has no such pair -- a second row is
        # a pending proposal, and 183 facilities file a licensed ND against a
        # MOD proposing DA. Taking the flag from those would advertise an
        # antenna nobody has built, so FM lets _rank pick the licence instead.
        if row["band"] == "AM" and row["directional"] == "Y":
            kept["directional"] = "Y"
        if _rank(row) < _rank(kept):
            power = {f: kept.get(f) for f in ("erp", "erp_night")}
            kept.update(row)
            for field, value in power.items():
                if kept.get(field) is None:
                    kept[field] = value
    for station in stations.values():
        station["hours"] = _hours(station)
        station["live"] = is_live(station)
    return sorted(stations.values(),
                  key=lambda s: (s["band"], s["freq"], s["call"]))


def _rank(row):
    return _STATUS_RANK.get(row["status"], 9)


def _hours(station):
    """Restate the AM hours column now that day and night rows are one row."""
    if station["band"] != "AM":
        return ""
    day, night = station.get("erp"), station.get("erp_night")
    if day is not None and night is not None:
        return "U" if station["hours"] == "UNL" else "DN"
    if night is not None:
        return "N"
    return "D"


def facility_date(path):
    """The day the FCC built the LMS dump, from the dump itself.

    Not the day it was downloaded, which is what a file mtime would say and is
    a different fact. update_data.lms_url walks back up to four days to find a
    dump that answers, so a fetch on a morning before the nightly build lands
    writes a file whose mtime is today and whose contents are Tuesday's.

    The zip carries the answer: its entry timestamp is when the FCC generated
    facility.dat, and it survives the download. Falls back to the file's own
    mtime when the archive is unreadable or carries no timestamp, which is
    still better than claiming the query files' date covers this one too.
    """
    if not os.path.exists(path):
        return None
    try:
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if entries and entries[0].date_time[0] > 1980:
                return date(*entries[0].date_time[:3]).isoformat()
    except (zipfile.BadZipFile, OSError, ValueError):
        pass
    try:
        return date.fromtimestamp(os.path.getmtime(path)).isoformat()
    except OSError:
        return None


def load_facility(path):
    """facility_id -> {"network", "atsc3", "primary"} from the LMS facility table.

    The query CGIs the rest of this module reads carry none of these. That is
    not the FCC withholding them -- they are in the Licensing and Management
    System, which publishes its tables as daily dumps, and the facility table
    states them outright: NBC against WWBT rather than the guess you would have
    to make from a licensee reading "Nexstar Media Inc."

    Read straight out of the zip. Unpacked the table is 42 MB to get four
    columns out of thirty-one, and nothing else here wants it on disk.

    Three fields are taken, and all three are licence data -- what the station
    told the FCC, not what is on the air tonight.

    network_affiliation and atsc3_ind are television's, and the table proves it
    rather than merely implying it: both are blank on every one of the 15,286
    AM, 24,453 FM, 23,374 FX and 7,828 FL rows in the file. So is
    nielsen_dma_rank, and so is tv_virtual_channel. Radio is in this table in
    full; those columns are simply not radio's.

    primary_station is the one that is. It is the facility ID of the station a
    translator or booster rebroadcasts, and it is radio's almost entirely:
    every licensed FM translator files one, four in five boosters do, and no
    LPFM does, which is correct rather than missing -- an LPFM may not
    rebroadcast. "Independent" against a network and a filed primary against a
    translator are both values in their own right, which is what lets a blank
    mean "none filed" rather than "we did not look".

    A missing or unreadable file returns nothing rather than failing the build.
    All three are enrichments; the station table is complete without them and
    every other source here is a separate download that can be missing.
    """
    if not os.path.exists(path):
        return {}
    out = {}
    try:
        with zipfile.ZipFile(path) as archive:
            name = archive.namelist()[0]
            with archive.open(name) as handle:
                header = handle.readline().decode("latin-1").split("|")
                index = {h.strip(): i for i, h in enumerate(header)}
                need = ("facility_id", "network_affiliation", "atsc3_ind",
                        "primary_station")
                if any(k not in index for k in need):
                    return {}
                for raw in handle:
                    parts = raw.decode("latin-1").split("|")
                    if len(parts) < len(header) - 1:
                        continue
                    fid = parts[index["facility_id"]].strip()
                    if not fid:
                        continue
                    network = parts[index["network_affiliation"]].strip()
                    atsc3 = parts[index["atsc3_ind"]].strip()
                    # Both sides of this join are facility IDs, and the file
                    # zero-pads inconsistently between them. Stripped on the
                    # way in so the lookup does not have to guess.
                    primary = parts[index["primary_station"]].strip().lstrip("0")
                    if network or atsc3 == "Y" or primary:
                        out[fid] = {"network": network,
                                    "atsc3": "Y" if atsc3 == "Y" else "",
                                    "primary": primary}
    except (zipfile.BadZipFile, OSError, UnicodeDecodeError):
        return {}
    return out


def load(path, band):
    """Read one downloaded query file into parsed rows, skipping junk lines."""
    parse = {"AM": parse_am, "TV": parse_tv}.get(band, parse_fm)
    rows = []
    with open(path, encoding="latin-1") as handle:
        for line in handle:
            if not line.startswith("|"):
                continue  # the CGI prefaces the data with a plain-text header
            row = parse(line)
            if row is not None:
                rows.append(row)
    return rows
