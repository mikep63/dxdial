# Radio Stations

Every licensed AM and FM transmitter, searchable three ways: by how close it is
to you, by where it sits on the dial, and by call sign.

Static site, no server. GitHub Pages serves one CSV and the browser does the
rest. Refreshed nightly from the FCC.

**Live:** https://mikep63.github.io/radio-stations/

## Building it

```sh
python3 update_data.py     # download the current FCC records into data/raw/
python3 build_site.py      # normalize them and build docs/
python3 -m http.server -d docs 8000
```

Python 3 standard library only — nothing to install.

`update_data.py` pulls four separate queries (full power FM, low power FM, FM
translators, AM) because that is how the FCC exposes them. `build_site.py`
folds them into one table, writes `docs/data/stations.csv`, records what
changed since the last build in `docs/data/changes.csv`, and copies the
frontend from `static/`.

Edit the frontend in `static/`, never in `docs/` — the build overwrites it.

`.github/workflows/update.yml` runs the same two commands nightly and commits
the result. That is the one push here that does not go through GitHub Desktop.

## What the data is, and what it is not

Everything comes from the FCC's Media Bureau AM and FM queries. Four things
about those records shape the whole app, and all four are places where the
obvious reading is wrong.

**A licence is not a broadcast.** A station may sit silent for up to twelve
months under 47 U.S.C. 312(g) and keep its licence the whole time. Nothing in
this data marks it. A station listed here may have been dark since last winter.
Fixing this needs the FCC's separate silent-station lists, which are not yet
wired in — see below.

**Status does not mean the same thing on both bands.** The FM query covers four
countries and its foreign records carry an honest `LIC`. The AM query covers
thirty-eight, because medium wave crosses the hemisphere after dark and the
Region 2 agreements have every country notify its assignments. The FCC cannot
license a station in Havana or São Paulo, so it files all of them as `CP`. Read
literally that marks about 7,300 real foreign stations as unbuilt proposals.
The derived `live` column in `stations.csv` is what sorts this out; `status`
is kept alongside it unaltered.

**Distance is not reception.** On FM it is a fair proxy — the signal is roughly
line-of-sight, so distance, power and antenna height explain most of it, though
a ridge beats all three. On AM it is a poor one. Daytime groundwave depends on
soil conductivity, and after dark skywave puts a station three states away over
one across town while that nearby station cuts power or goes directional. Day
and night power are both carried for this reason. Ranking AM by distance alone
produces results listeners experience as wrong.

**Format is not in here at all.** The FCC licenses transmitters, not
programming. Nothing in this data knows which station plays country and which
plays news — and format is the attribute most likely to change.

### Counts, as of the first build

| Service | On air | Note |
|---|---:|---|
| Full power FM | 12,137 | 11,364 US |
| FM translators | 8,471 | |
| AM | 11,603 | 4,284 US, 7,319 foreign |
| Low power FM | 2,020 | |

## How the FCC serves this

Two things will waste an afternoon if nobody writes them down.

**Use `transition.fcc.gov`, not `www.fcc.gov`.** The data CGIs on
`transition` serve scripts without complaint. The documentation pages on `www`
return 403, then 429, and then stop answering for minutes — readable in a
browser, not from a script.

**The User-Agent needs a `product/version` token.** `radio-stations/1.0` is
served; a bare `radio-stations-updater` gets a flat 403. This is not rate
limiting and does not clear on its own, so `update_data.py` does not retry it.

LMS is down for maintenance Wednesday 18:00 to Thursday 08:00 US Eastern. The
nightly job is scheduled well clear of it.

## Layout

```
fcc.py            parsing and normalization — where the data-quality rules live
update_data.py    download the four query files into data/raw/
build_site.py     normalize, export, diff, and build docs/
static/           the frontend, edited here
docs/             the built site, served by Pages — generated, do not edit
```

## Still to do

- **Silent-station lists.** The one real accuracy gap. Until it is joined in,
  "on air" means "licensed", which is not the same claim.
- **Place-name search.** Location is geolocation or typed coordinates today. A
  ZIP-centroid table would let people type where they are.
- **Terrain.** Distance ranking ignores the hill in the way. Longley-Rice over
  elevation tiles is what the better commercial tools do and is a large piece
  of work; ERP and HAAT are already carried for whenever it happens.
- **iOS.** To follow once the web app settles, as a `radio-stations-ios` pair.

## Licence

MIT for the code; the FCC records are public domain. See [LICENSE](LICENSE).
