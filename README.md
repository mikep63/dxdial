# Radio Stations

Every licensed AM and FM transmitter, searchable three ways: by how close it is
to you, by where it sits on the dial, and by call sign.

Static site, no server. GitHub Pages serves one CSV and the browser does the
rest. Refreshed weekly from the FCC.

**Live:** https://mikep63.github.io/radio-stations/

## Building it

```sh
python3 update_data.py     # download the current FCC records into data/raw/
python3 build_site.py      # normalize them and build docs/
python3 verify.py          # check the result is fit to publish
python3 -m http.server -d docs 8000
```

Python 3 standard library only — nothing to install.

`update_data.py` pulls five separate queries (full power FM, low power FM, FM
translators, FM boosters, AM) because that is how the FCC exposes them. `build_site.py`
folds them into one table, writes `docs/data/stations.csv`, records what
changed since the last build in `docs/data/changes.csv`, and copies the
frontend from `static/`.

Edit the frontend in `static/`, never in `docs/` — the build overwrites it.

`.github/workflows/update.yml` runs all three every Sunday and commits the result.
That is the one push here that does not go through GitHub Desktop. `verify.py`
gates it: a failed or partial download arrives as a table that is short,
misplaced or off the channel grid, and the job stops rather than publishing it,
leaving the previous build serving.

Every conversion between the raw records and the published table is specified
in [DATA.md](DATA.md) — read that before changing the pipeline or writing
anything that consumes `stations.csv`.

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

Checked against the FCC's own Broadcast Station Totals of 2026-03-31, which
the Media Bureau compiles independently of these queries:

| Service | US on air | FCC published | Total incl. foreign |
|---|---:|---:|---:|
| Full power FM | 11,364 | 11,357 | 12,137 |
| FM translators | 8,438 | — | 8,471 |
| FM boosters | 406 | — | 406 |
| Translators + boosters | 8,844 | 8,854 | |
| AM | 4,284 | 4,310 | 11,602 |
| Low power FM | 2,020 | 2,007 | 2,020 |

AM carries 7,318 foreign stations because the AM query covers thirty-eight
countries — see [DATA.md](DATA.md).

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
weekly job runs Sunday morning, which is why it runs on a named day rather than
whichever one a daily schedule landed on -- 09:40 UTC is Thursday *morning*
Eastern, inside that window.

## Layout

```
fcc.py            parsing and normalization — where the data-quality rules live
update_data.py    download the five query files into data/raw/
build_site.py     normalize, export, diff, and build docs/
verify.py         check the built table before it is allowed out
DATA.md           every conversion, specified
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
