# Working on DXDial

Read **`DESIGN.md` before proposing any design change.** Its first half is the
product layer — the name, the signal model, which data sources are allowed,
what units mean — and those decisions bind any client, not just this one. Most
of what is in there was argued once already, with the alternatives written down.
If you find yourself proposing something that section rejected, read why first;
if the reasoning has genuinely expired, edit the entry in place and say so.

`DATA.md` is what the FCC's files mean. `IOS.md` is what this app has decided on
the port's behalf, and moves to `dxdial-ios` when that exists.

## The rule everything else serves

**`docs/` is generated. Never edit it by hand.** The frontend lives in
`static/`; `build_site.py` copies it, writes the CSV, the manifest and the
service worker, and appends to the change log. Editing `docs/` directly means
the next build silently reverts you.

```sh
python3 update_data.py     # fetch — data/raw is gitignored, so a fresh clone needs this
python3 build_site.py      # normalize, export, copy the frontend
python3 verify.py          # must end "Fit to publish."
```

`verify.py` is the gate, and it checks against things the build cannot fake: the
FCC's separately published station totals, the channel grids, the network join's
coverage. **A change that makes it fail is wrong until proven otherwise** —
loosen a tolerance only with a reason written into the file.

## Three bands, and the trap that comes with them

AM, FM and TV. Adding the third broke five things that were written correctly
for two, all of them a binary test where the third case fell through to the
`else`: map colours, the legend's class sentence, channel spacing in
`neighbours()`, the band-ordering comparator, and `bandOfFreq`.

**Grep `band ===` before assuming a two-way test is still two-way.**

Two rules that are not preferences:

- **Television gets no signal column, ever.** `kW/km²` is defensible on AM
  because groundwave and skywave are not line-of-sight, and wrong on VHF and
  UHF, where terrain is the answer rather than a caveat.
- **Distances are kilometres everywhere internally** and converted only when
  printed, so a unit can be wrong in exactly one place. Height above average
  terrain stays in metres in both modes: it is the FCC's filed figure.

## The shape numbers

`EXPORT_SHAPE` in `build_site.py` and `SHAPE` in `static/app.js` describe the
published CSV. `LOG_SHAPE` describes an exported logbook. They exist for a
client that pins to one version while the data keeps moving weekly — which is
an iOS binary, not this page, since this page ships with its data.

**Adding a column an old reader can ignore does not bump them. Renaming one, or
changing what it means, does.** The TV band added `channel`, `virtual`,
`network` and `atsc3` without a bump, and kept `freq` in MHz for television
rather than putting a channel number in it, precisely so it would not have to.

## Before you call anything done

The build must say **"Fit to publish."** with 0 errors and 0 warnings.

If a change touches the frontend, render it and read it back rather than
reasoning about the diff — several bugs this repository has had were invisible
in the source and obvious on screen: television drawing in FM's colour, a sort
silently undone by a row cap, a control that had moved but kept its old
listener.

Commit after a verified build. **Never push** — that is Mike's.
