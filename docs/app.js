/* DXDial — everything runs in the browser against docs/data/*.csv.
   There is no server: GitHub Pages hands over the station table and the
   filtering, distance maths and sorting all happen here.

   SPDX-FileCopyrightText: 2026 Mike Parker <mike@rsbl.org>
   SPDX-License-Identifier: LicenseRef-AllRightsReserved */
'use strict';

(function () {
  const KM_PER_DEGREE = 111.319;
  const EARTH_RADIUS_KM = 6371.0088;
  const STORE_KEY = 'dxdial.place';
  const LOG_KEY = 'dxdial.log';
  const DAYNIGHT_KEY = 'dxdial.daynight';
  const RADIUS_KEY = 'dxdial.radius';

  /* These keys were 'radio-stations.*' until the rename on 2026-08-19. The old
     values are still readable: localStorage is keyed by origin and a project
     Pages site keeps its origin when the repository is renamed, since the name
     lives in the path. So nothing was orphaned by the move -- but everything
     would be orphaned by the four renames above, logbook included, without
     this. It copies rather than moves, so a reader still being served a stale
     app.js out of the old service worker cache goes on finding what it wrote.
     Safe to delete once no client is reading the old names. */
  (function carryOldKeys() {
    const renamed = [['radio-stations.place', STORE_KEY],
                     ['radio-stations.log', LOG_KEY],
                     ['radio-stations.daynight', DAYNIGHT_KEY],
                     ['radio-stations.radius', RADIUS_KEY]];
    try {
      for (const [was, now] of renamed) {
        const v = localStorage.getItem(was);
        if (v !== null && localStorage.getItem(now) === null) {
          localStorage.setItem(now, v);
        }
      }
    } catch (e) { /* private mode */ }
  }());

  /* The shape of an exported logbook, so an importer -- this app next year, or
     the iOS one -- can tell what it has been handed.
     1  log_shape, key, heard_at, facility, call, band, frequency, city, state,
        country, signal, signal_note, heard_from, lat, lon, notes, now_call,
        now_frequency.
     Bump on a rename or a removal; a new column an old reader can ignore does
     not need it. */
  const LOG_SHAPE = 1;

  /* The export shape this file was written against, matching EXPORT_SHAPE in
     build_site.py. This page ships with its data so it should never disagree,
     but saying so out loud is what makes the number mean anything to the app
     store client that will read the same files without shipping alongside
     them. A mismatch is reported rather than drawn through. */
  const SHAPE = 1;

  // The most rows any one view will build. Search already stopped at this
  // number; the wider distance tiers made it everyone's problem.
  const MAX_ROWS = 500;

  /* Nearby is fixed here rather than taking the distance control, because the
     control is shared with Dial and a distance that belongs to a DX channel
     followed the reader back to a view called Nearby -- park on an AM channel
     after dark, which is 4,000 km, and the local list silently became a
     continental one.

     This view answers what is close. What can be heard is Dial's question, and
     the two must not be confused: no rule here weighs power against distance,
     because that is a claim about reception and this data cannot make one --
     ground conductivity alone swings AM groundwave past 100 km more than power
     does, and it is not in the FCC's tables at all.

     100 km is what the word means, and it is one figure for both bands because
     the question it answers does not know which band you are on.

     This was 200 on AM for a day, widened because WTAR -- 50 kW at Norfolk,
     106 km out -- had dropped off a list covering Richmond. Widening was the
     wrong fix. 200 km also reached Baltimore at 197 km, two markets away, and
     the case for it was always that a 50 kW AM carries that far, which is a
     reception argument and therefore Dial's. A station you can hear but would
     never call close belongs on the channel, not on this list. WTAR sits
     outside 100 km and is found by walking 850 kHz.

     Anything that starts with "but you can hear X from here" is arguing for
     Dial. Widen this only if 100 km stops meaning close.

     Rows stay well inside the cap: the densest sampled point in the data,
     eastern Pennsylvania, ran 465 at AM 200, and less at 100, against
     MAX_ROWS of 500.

     Distance stays a control on Dial, where reaching for 4,000 km is the point. */
  const NEARBY_RADIUS = 100;

  /* What a DXer writes down about a catch. Numbers rather than words so the
     log can sort and compare, labels for reading. Loosely the S of SINPO,
     which is the scale the hobby already thinks in. */
  const SIGNAL = {
    5: 'Strong, armchair copy',
    4: 'Good, easy listening',
    3: 'Fair, readable with effort',
    2: 'Weak, fading in and out',
    1: 'Bare threshold, ID only',
  };

  let STATIONS = [];
  let CHANGES = [];
  let META = null;
  let place = null;                       // {lat, lon, label}
  let BY_ID = new Map();                  // station id -> station
  let LOGGED = new Set();                 // station ids with at least one catch
  let nightOverride = null;               // null = follow the clock

  /* AM carries as far as the hour lets it: groundwave over roughly a state by
     day, skywave across a country after dark, which is where XEW and XERF sit
     at 3,600 km. So the distance is not one setting but two, and each is
     remembered separately -- someone who wants 1,500 km at night and 100 by day
     should have to say so once rather than every time the sun moves.

     AM only. FM files one power, does not skywave reliably, and has no day and
     night to have two settings for. */
  const AM_RADIUS_DEFAULT = { day: '400', night: '4000' };
  let radiusPref = { day: '400', night: '4000' };

  function readRadiusPref() {
    try {
      const v = JSON.parse(localStorage.getItem(RADIUS_KEY) || 'null');
      if (v && typeof v === 'object') {
        return {
          day: v.day || AM_RADIUS_DEFAULT.day,
          night: v.night || AM_RADIUS_DEFAULT.night,
        };
      }
    } catch (e) { /* nothing saved */ }
    return { day: AM_RADIUS_DEFAULT.day, night: AM_RADIUS_DEFAULT.night };
  }

  function writeRadiusPref() {
    try { localStorage.setItem(RADIUS_KEY, JSON.stringify(radiusPref)); } catch (e) { /* private mode */ }
  }

  // Which slot a distance change belongs in -- only while an AM channel is the
  // thing on screen, since that is the only place the two modes exist.
  function amModeOnScreen() {
    const r = route();
    if (r.tab !== 'dial') return null;
    const freq = Number(r.arg);
    if (!freq || bandOfFreq(freq) !== 'AM') return null;
    return isNight() ? 'night' : 'day';
  }

  /* Sunrise and sunset at a place, by the standard sunrise equation: mean solar
     time, the sun's mean anomaly, the equation of centre, ecliptic longitude,
     declination, hour angle. Good to about a minute, which is finer than the
     FCC's own rounding to the quarter hour in its licences.

     The horizon is taken at -0.833 degrees rather than zero, which is what
     everyone means by sunrise: half a degree for the sun being a disc that
     clears the horizon edge-first, and about a third for refraction lifting it
     into view before it is geometrically there.

     Null inside the polar circles, where the sun can fail to rise or fail to
     set for the day and the hour angle has no solution. Callers fall back to
     the clock, which is wrong there too but at least answers. */
  function sunTimes(when, lat, lon) {
    const rad = Math.PI / 180, J2000 = 2451545;
    const jdate = when.valueOf() / 86400000 + 2440587.5;
    const n = Math.round(jdate - J2000 + 0.0008);
    const js = n + 0.0009 + (-lon) / 360;
    const m = (357.5291 + 0.98560028 * js) % 360;
    const c = 1.9148 * Math.sin(m * rad) + 0.02 * Math.sin(2 * m * rad)
      + 0.0003 * Math.sin(3 * m * rad);
    const lam = (m + c + 180 + 102.9372) % 360;
    const transit = J2000 + js + 0.0053 * Math.sin(m * rad)
      - 0.0069 * Math.sin(2 * lam * rad);
    const dec = Math.asin(Math.sin(lam * rad) * Math.sin(23.4397 * rad));
    const cosW = (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(dec))
      / (Math.cos(lat * rad) * Math.cos(dec));
    if (cosW > 1 || cosW < -1) return null;
    const w = Math.acos(cosW) / rad;
    const at = (j) => new Date((j - 2440587.5) * 86400000);
    return { rise: at(transit - w / 360), set: at(transit + w / 360) };
  }

  // Today's sun where the reader is, or null with no location set.
  function sunHere(when) {
    return place ? sunTimes(when || new Date(), place.lat, place.lon) : null;
  }

  /* The FCC draws the line at local sunset and sunrise, which move with the date
     and the latitude, so that is the line this draws too once a location is
     known. The clock hour survives as the fallback for a reader who has set no
     location and for inside the polar circles -- it is wrong by up to an hour
     at the edges of the year, which is why the switch was always there to be
     moved rather than only inferred. */
  function isNight() {
    if (nightOverride !== null) return nightOverride;
    const now = new Date();
    const sun = sunHere(now);
    if (sun) return now < sun.rise || now >= sun.set;
    const h = now.getHours();
    return h < 6 || h >= 18;
  }

  /* What the Day/Night switch is going on, said where the switch is. "From the
     clock" was an apology for a heuristic; the times are the thing itself.

     Grayline gets its own word because it is the reason to be at the radio at
     all on medium wave: for a window around sunrise and sunset the D layer that
     absorbs skywave by day has gone or has not formed, while the reflecting
     layers above are still lit, and paths open that are shut the rest of the
     day. Half an hour either side is the conventional window. */
  const GRAYLINE_MIN = 30;

  function sunNote(night) {
    if (nightOverride !== null) {
      return ' — <button type="button" class="link-btn" id="night-auto">follow the sun</button>';
    }
    const sun = sunHere();
    if (!sun) return ' — from the clock';
    const hhmm = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const now = Date.now();
    const near = Math.min(Math.abs(now - sun.rise), Math.abs(now - sun.set)) / 60000;
    return ` — sunset ${hhmm(sun.set)}, sunrise ${hhmm(sun.rise)}`
      + (near <= GRAYLINE_MIN ? ' · <strong>grayline</strong>' : '');
  }

  // A choice the reader made outlives the tab; the clock is only the fallback.
  function readNightOverride() {
    try {
      const v = localStorage.getItem(DAYNIGHT_KEY);
      return v === 'night' ? true : v === 'day' ? false : null;
    } catch (e) { return null; }
  }

  function writeNightOverride(v) {
    try {
      if (v === null) localStorage.removeItem(DAYNIGHT_KEY);
      else localStorage.setItem(DAYNIGHT_KEY, v ? 'night' : 'day');
    } catch (e) { /* private mode */ }
  }

  // AM runs 530-1700 and FM 88.1-107.9, so a bare frequency names its own band.
  // Needed before the channel list exists, to know which radius to build it at.
  function bandOfFreq(freq) { return freq >= 500 ? 'AM' : 'FM'; }

  // ------------------------------------------------------------- utilities

  /* A CSV reader that respects quoted fields. Licensee names carry commas
     ("CSN INTERNATIONAL, INC."), so splitting on commas loses every column
     after the licensee on those rows. */
  function parseCSV(text) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
        } else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function toObjects(rows) {
    const header = rows[0];
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].length < 2) continue;
      const o = {};
      for (let j = 0; j < header.length; j++) o[header[j]] = rows[i][j];
      out.push(o);
    }
    return out;
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(a));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const toRad = Math.PI / 180;
    const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
    const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad)
      - Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
    const deg = (Math.atan2(y, x) / toRad + 360) % 360;
    return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
  }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
  }

  function freqLabel(s) {
    return s.band === 'FM' ? Number(s.freq).toFixed(1) : String(s.freq);
  }

  function freqUnit(s) { return s.band === 'FM' ? 'MHz' : 'kHz'; }

  // ------------------------------------------------------------ filtering

  function filters() {
    return {
      band: $('band').value,
      live: $('live').checked,
      usOnly: $('us-only').checked,
      // Empty means no limit. Null rather than Infinity so selected() can tell
      // "no bound asked for" from "a bound that happens to be huge" -- the
      // bounding-box pre-filter is worth skipping entirely in the first case.
      radius: $('radius').value === '' ? null : Number($('radius').value),
    };
  }

  /* There was a "hide under 50 W" filter here, on by default, and it is gone.

     It answered the wrong question. Every other filter here asks what kind of
     thing a station is -- which band, on the air or not, which country. That one
     asked whether you would hear it, which is a judgement this data cannot make
     and which belongs to Dial, not to a list of what is nearby.

     Power alone could not make it either, because it never saw the distance. It
     treated WRIR-LP, a 42 W community station 21 km away that anyone in Richmond
     could name, exactly like a 10 W translator 85 km off. Five genuinely local
     stations were missing from that reader's Nearby list and the app gave no
     sign they existed.

     Nothing needed it to be there. Showing everything takes the worst Nearby
     list in the country from 382 rows to 420 against a cap of 500, and the Dial
     channel list from 102 to 114 -- and at 400 km, not at all, those translators
     already sharing a channel with something bigger. */
  function matches(s, f) {
    if (f.band && s.band !== f.band) return false;
    // s.live, not status === 'LIC': a foreign AM station is filed as a permit
    // because the FCC cannot license one, and testing the raw status would
    // hide most of the hemisphere's medium wave.
    if (f.live && !s.live) return false;
    if (f.usOnly && s.country !== 'US') return false;
    return true;
  }

  /* Stations passing the filters, with distance attached when a location is
     set. The bounding box is a cheap pre-filter: at 400 km the full haversine
     over 25,000 stations runs on every keystroke otherwise. */
  function selected(f, useRadius) {
    const out = [];
    // "Any distance" is radius null: every station still gets a distance, but
    // nothing is excluded for having one, and the box below is skipped.
    const bound = useRadius && f.radius !== null;
    let latMin = -Infinity, latMax = Infinity, lonMin = -Infinity, lonMax = Infinity;
    if (place && bound) {
      const dLat = f.radius / KM_PER_DEGREE;
      const cos = Math.max(0.01, Math.cos(place.lat * Math.PI / 180));
      const dLon = f.radius / (KM_PER_DEGREE * cos);
      latMin = place.lat - dLat; latMax = place.lat + dLat;
      lonMin = place.lon - dLon; lonMax = place.lon + dLon;
    }
    for (const s of STATIONS) {
      if (!matches(s, f)) continue;
      if (place) {
        if (bound && (s.lat < latMin || s.lat > latMax
          || s.lon < lonMin || s.lon > lonMax)) continue;
        s.km = distanceKm(place.lat, place.lon, s.lat, s.lon);
        if (bound && s.km > f.radius) continue;
      } else s.km = null;
      out.push(s);
    }
    return out;
  }

  /* A table nobody can read is not a table. 4,000 km from Portland reaches
     28,189 stations and "any" reaches 34,631; building that many rows locks the
     tab for seconds and scrolls like treacle afterwards. The nearest MAX_ROWS
     are kept and the count says so, the same way the neighbour tables on a
     station page say "nearest 20 of 431".

     Nearest, then re-sorted into dial order -- not the first 500 in dial order,
     which would hand back the whole AM band and no FM at all. */
  function capByDistance(list) {
    if (list.length <= MAX_ROWS || !place) return { rows: list, total: list.length };
    const rows = list.slice().sort((a, b) => a.km - b.km).slice(0, MAX_ROWS);
    return { rows, total: list.length };
  }

  function capNote(total) {
    return total > MAX_ROWS
      ? `<p class="note">Nearest ${MAX_ROWS.toLocaleString()} of
         ${total.toLocaleString()} shown. Narrow the distance or the band to see
         the rest.</p>`
      : '';
  }

  /* Asking for a thousand kilometres of both bands at once is asking for a
     thousand kilometres of AM and a few hundred of FM, whether or not you meant
     it. Rather than enforce that -- FM does travel on a tropospheric duct or a
     sporadic-E opening, and neither is predictable from anything the FCC files,
     so a rule would hide real catches -- the reader is told which lever to
     pull. Only when both bands are showing, since choosing one is the fix. */
  function bandHint(f) {
    const wide = f.radius === null || f.radius >= 1500;
    if (!wide || f.band) return '';
    return `<p class="note">Past a few hundred kilometres FM needs a
      tropospheric duct or a sporadic-E opening — real, but occasional, and not
      something this can predict. AM skywave after dark is the one that travels
      reliably. Set <strong>Band</strong> to AM only if local FM is crowding out
      what you came for.</p>`;
  }

  // -------------------------------------------------------------- rendering

  /* The Service column prints the FCC's codes, and the filter that used to spell
     them out in its options is gone. Built from meta.serviceNames rather than a
     list here, so a service the FCC adds arrives named instead of as two bare
     letters. The names carry "FM" that the code already says -- "FM translator"
     against a cell reading FX -- so that word comes out and the code stands for
     it. AM is skipped: those rows print the class letter alone, and the sentence
     after the codes covers it. */
  function writeLegend() {
    const names = META && META.serviceNames;
    if (!names) return;
    const parts = Object.keys(names).filter((k) => k !== 'AM').sort().map((k) => {
      const label = names[k].replace(/\bFM\b/, '').replace(/\s+/g, ' ').trim();
      return `<b>${esc(k)}</b> ${esc(label.toLowerCase())}`;
    });
    $('legend').innerHTML = `${parts.join(' · ')} · <b>AM</b> rows show their
      class letter alone. A letter after any code is the station class.`;
  }

  /* The tick sits before the call sign, and takes up its width whether or not it
     is showing. An empty marker that collapsed would step every unheard call
     sign left of every heard one, turning a column you scan into a ragged edge
     for the sake of a few characters. */
  function heardMark(id) {
    return `<span class="heard"${LOGGED.has(id) ? ' title="You have logged this one"' : ''}>${
      LOGGED.has(id) ? '✓' : ''}</span>`;
  }

  function callCell(s) {
    return `${heardMark(s.id)}<a href="#station/${encodeURIComponent(s.id)}">${esc(s.call)}</a>${
      !s.live ? `<span class="tag">${esc(s.status)}</span>` : ''}`;
  }

  function stationRows(list, opts, top, lic) {
    return list.map((s) => {
      const power = s.erp === null ? ''
        : s.band === 'AM' && s.erpNight !== null && s.erpNight !== s.erp
          ? `${s.erp} / ${s.erpNight} kW`
          : `${s.erp} kW`;
      const dist = s.km == null ? ''
        : `${s.km < 10 ? s.km.toFixed(1) : Math.round(s.km)} km ${bearing(place.lat, place.lon, s.lat, s.lon)}`;
      return `<tr${opts && signsOff(s, opts.night) ? ' class="row-off"' : ''}>
        ${opts ? `<td class="sig-cell">${signalBadge(s, top, opts.night)}</td>` : ''}
        <td class="freq">${freqLabel(s)}<span class="unit">${freqUnit(s)}</span></td>
        <td class="call">${callCell(s)}</td>
        <td>${esc(titleCase(s.city))}${s.state ? ', ' + esc(s.state) : ''}${s.country !== 'US' ? ` <span class="flag">${esc(s.country)}</span>` : ''}</td>
        <td class="num">${esc(dist)}</td>
        <td class="num">${esc(power)}</td>
        <td class="svc">${esc(s.service === 'AM' ? (s.class || 'AM') : s.service + (s.class ? ' ' + s.class : ''))}</td>
        ${lic ? `<td class="licensee">${esc(titleCase(s.licensee))}</td>` : ''}
      </tr>`;
    }).join('');
  }

  // One table with its column headings. Split out from table() so Nearby can
  // put several under band headings while Search keeps a single ranked list.
  /* Which way each column runs on its first click. Nobody wants the furthest
     station first or the weakest transmitter first, so those two open the way
     they are actually asked for and reverse on a second click. */
  const SORTS = {
    signal: { dir: -1, of: (s, n) => signal(s, n) },
    km: { dir: 1, of: (s) => s.km },
    erp: { dir: -1, of: (s, n) => (n && s.band === 'AM' ? s.erpNight : s.erp) },
  };

  let sortBy = null;   // null = whatever order the view built

  // The channel Dial last drew, so a re-render can tell a new choice from a
  // redraw of the same one. Null until the first, which must not scroll.
  let lastDialFreq = null;

  function setSort(col) {
    if (!SORTS[col]) return;
    sortBy = sortBy && sortBy.col === col
      ? { col, dir: -sortBy.dir }
      : { col, dir: SORTS[col].dir };
  }

  // Unknown sinks whichever way the column is pointing: a station that filed no
  // power is not the weakest one, it is the one that did not say.
  function applySort(list, night) {
    if (!sortBy) return list;
    const of = SORTS[sortBy.col].of;
    return list.slice().sort((a, b) => {
      const x = of(a, night), y = of(b, night);
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x - y) * sortBy.dir;
    });
  }

  function sortHead(col, label, title) {
    const on = sortBy && sortBy.col === col;
    const arrow = on ? (sortBy.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable${on ? ' sorted' : ''}" data-sort="${col}"${
      title ? ` title="${esc(title)}"` : ''}>${esc(label)}${arrow}</th>`;
  }

  /* opts.night, when given, adds the Signal column and makes the numeric columns
     sortable. Only Dial passes it, because the comparison is against the
     strongest on one frequency -- across a mixed list it would be comparing
     arrivals on different channels, which means nothing.

     opts.licensee adds the Licensee column, and only Search passes it. There the
     name is why a row matched -- search "iHeart", get eight hundred rows, and
     without the column the results look arbitrary. Everywhere else it is the
     widest cell in the table answering a question the view did not ask: Dial
     compares arrivals on one channel, Nearby lists what is audible, and neither
     turns on who owns the licence. The station page carries it regardless. */
  function stationTable(list, opts) {
    const o = opts && 'night' in opts ? opts : null;
    const lic = !!(opts && opts.licensee);
    const rows = o ? applySort(list, o.night) : list;
    // The reference comes from the caller, because the honest one is not on
    // this table: it is the strongest arrival on this band anywhere in range.
    // Derived from these rows it could only ever say "best of the three here".
    const top = o ? (o.top || 0) : 0;
    return `<div class="scroll"><table>
      <thead><tr>${o
        ? sortHead('signal', 'Signal', 'Strength against the strongest arrival on this band within range, in dB')
        : ''}
      <th>Freq</th><th>Call</th><th>City</th>
      ${o ? sortHead('km', 'Distance') : '<th>Distance</th>'}
      ${o ? sortHead('erp', 'Power') : '<th>Power</th>'}
      <th>Service</th>${lic ? '<th class="licensee">Licensee</th>' : ''}</tr></thead>
      <tbody>${stationRows(rows, o, top, lic)}</tbody></table></div>`;
  }

  function table(list, note, opts) {
    if (!list.length) return `<p class="empty">${note || 'Nothing matches.'}</p>`;
    return `<p class="count">${list.length.toLocaleString()} stations</p>
      ${stationTable(list, opts)}`;
  }

  /* Nearby, split at the band change. The two bands are separate dials with
     separate units -- kHz against MHz -- so running them into one table asks the
     reader to notice the switch from a number in the Freq column. A heading says
     it instead. Groups come off the list in the order it is already sorted in
     rather than being collected by band, so the headings cannot disagree with
     the ordering above them. */
  function bandTables(list, note) {
    if (!list.length) return `<p class="empty">${note || 'Nothing matches.'}</p>`;
    const groups = [];
    for (const s of list) {
      if (!groups.length || groups[groups.length - 1].band !== s.band) {
        groups.push({ band: s.band, rows: [] });
      }
      groups[groups.length - 1].rows.push(s);
    }
    return `<p class="count">${list.length.toLocaleString()} stations</p>` +
      groups.map((g) => `<h3>${esc(g.band)} <span class="count-in-head">${
        g.rows.length.toLocaleString()}</span></h3>${stationTable(g.rows)}`).join('');
  }

  function renderNearby() {
    if (!place) {
      $('nearby-out').innerHTML =
        '<p class="empty">Set a location above to sort by distance.</p>';
      $('nearby-map-link').hidden = true;
      return;
    }
    // The map is a link rather than a panel. Drawn here it pushed the tables --
    // the thing the tab is for -- below the fold, and a map is worth a page of
    // its own rather than a strip above something else.
    $('nearby-map-link').hidden = false;
    // Dial order, not distance order: the reader is holding a radio, and the
    // useful sequence is the one the tuning knob follows. AM and FM do not share
    // a scale -- 98.5 and 985 are different places -- so band leads and each is
    // ordered within itself, nearest first where two share a frequency.
    //
    // AM leads because it genuinely is the low end: it runs to 1700 kHz, which
    // is 1.7 MHz, and FM does not start until 88. Reading the two in kHz puts
    // them in the order a dial actually sweeps.
    // Its own distance, not the shared control's -- see NEARBY_RADIUS. Every
    // other filter still applies, so band and power narrow this list normally.
    const { f, rows, total } = nearbyRows();
    rows.sort((a, b) => a.band === b.band
      ? (a.freq - b.freq) || (a.km - b.km)
      : (a.band === 'AM' ? -1 : 1));
    // bandHint stays quiet at this distance and capNote cannot fire, both by
    // construction; they are left in so a change to NEARBY_RADIUS still lands.
    $('nearby-out').innerHTML = bandHint(f) + capNote(total)
      + bandTables(rows, `No stations within ${NEARBY_RADIUS} km.`);
  }

  // What Nearby lists, which is also what the map draws. Shared so a filter
  // change moves both and neither can quietly show a different hundred km.
  function nearbyRows() {
    const f = { ...filters(), radius: NEARBY_RADIUS };
    return { f, ...capByDistance(selected(f, true)) };
  }

  // --------------------------------------------------------------- the map

  /* Where the list is, rather than what is in it. A table sorted by frequency
     cannot show that half of what you can hear sits along one bearing, which is
     the thing a directional antenna acts on.

     Tiles come from OpenStreetMap at run time and are never cached: the OSMF
     policy calls prefetching for offline use bulk downloading and forbids it.
     Leaflet draws its vector layers independently of the tile layer, so with no
     network the map goes blank underneath while the markers and the range rings
     stay exactly where they belong -- a bearing-and-distance plot, which is the
     part a DXer was reading anyway.

     One dot per transmitter site, not per station. 140 stations here stand on
     85 sites and the busiest tower carries nine; a marker each would draw eight
     of them invisibly underneath the ninth. */
  let nearbyMap = null;      // built once -- Leaflet cannot re-init a container
  let nearbyDrawn = null;    // the markers and rings, cleared on every redraw

  function renderMap() {
    if (!place) {
      $('map-box').hidden = true;
      $('map-out').innerHTML =
        '<p class="empty">Set a location above to draw the map.</p>';
      return;
    }
    // Vendored, so absence is a broken deploy rather than a slow network. Say
    // so plainly: on its own page a blank rectangle explains nothing, whereas
    // on Nearby the tables carried the tab and a quiet hide was defensible.
    if (typeof L === 'undefined') {
      $('map-box').hidden = true;
      $('map-out').innerHTML = '<p class="empty">The map could not load. '
        + 'The <a href="#nearby" data-tab="nearby">Nearby</a> list still works.</p>';
      return;
    }
    const { rows, total } = nearbyRows();
    $('map-box').hidden = false;
    drawNearbyMap(rows);
    const sites = new Set(rows.map((s) => `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`));
    $('map-out').innerHTML = `<p class="count">${rows.length.toLocaleString()}
      stations on ${sites.size.toLocaleString()} sites within
      ${NEARBY_RADIUS} km</p>` + capNote(total);
  }

  /* Where the Signal rule runs out. 60 dB down covers the ninetieth percentile
     of the widest case in the data -- AM on night power at 4,000 km, whose
     median is 52 dB and worst 69 -- so the scale spans what is actually there
     rather than a round number, and anything past it draws the same stub. */
  const SIG_FLOOR_DB = 60;

  // AM and FM keep the same two colours wherever a transmitter is drawn.
  const BAND_INK = { AM: '#c2603a', FM: '#2f7d8c' };

  // Every map in the app is made here, so the tile URL the OSMF policy requires
  // and the attribution it requires with it exist in one place and cannot drift
  // apart between two callers.
  function mapIn(box) {
    const map = L.map(box, { scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" '
        + 'target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map);
    return map;
  }

  /* Measure, then fit. Both are needed and this order is the whole point, which
     is why no caller is trusted to remember it.

     A tab sits at display:none until the router shows it, so Leaflet's cached
     size can still be the zero it measured while hidden -- and fitBounds picks
     a zoom by dividing the container size by the bounds. Zero minus the padding
     goes negative, the log of a negative is NaN, and the map settles wherever a
     NaN zoom clamps to, which in practice was fully zoomed in: half a mile
     across, centred on the reader. Fitting before measuring also cannot be
     rescued afterwards, because invalidateSize keeps the centre and zoom it
     finds and only changes the frame around them.

     Unanimated because these are arrivals at a view, not journeys between two. */
  function fitMap(map, bounds) {
    map.invalidateSize({ animate: false });
    map.fitBounds(bounds, { padding: [8, 8], animate: false });
  }

  function drawNearbyMap(rows) {
    const box = $('map-box');

    if (!nearbyMap) {
      nearbyMap = mapIn(box);
      nearbyDrawn = L.layerGroup().addTo(nearbyMap);
    }
    nearbyDrawn.clearLayers();

    // Stations sharing a mast collapse to one dot. Four decimal places is about
    // 10 m, which separates two real masts and joins the same one filed twice.
    const sites = new Map();
    for (const s of rows) {
      const key = `${s.lat.toFixed(4)},${s.lon.toFixed(4)}`;
      if (!sites.has(key)) sites.set(key, { lat: s.lat, lon: s.lon, list: [] });
      sites.get(key).list.push(s);
    }

    for (const r of [25, 50, 100]) {
      L.circle([place.lat, place.lon], {
        radius: r * 1000, fill: false, color: '#7a8b99',
        weight: 1, dashArray: '4 4', interactive: false,
      }).addTo(nearbyDrawn);
    }

    for (const site of sites.values()) {
      const n = site.list.length;
      const am = site.list.some((s) => s.band === 'AM');
      L.circleMarker([site.lat, site.lon], {
        // Area, not radius, tracks the count -- doubling the radius would draw
        // a two-station mast four times the size of a one-station mast.
        radius: Math.min(4 + Math.sqrt(n) * 2.2, 14),
        color: am ? BAND_INK.AM : BAND_INK.FM, weight: 1.5,
        fillColor: am ? BAND_INK.AM : BAND_INK.FM, fillOpacity: 0.55,
      }).bindPopup(site.list
        .slice()
        .sort((a, b) => (a.band === b.band ? a.freq - b.freq : a.band === 'AM' ? -1 : 1))
        .map((s) => `<strong>${esc(s.call)}</strong> ${freqLabel(s)} ${freqUnit(s)}`
          + `<br><span class="muted">${esc(titleCase(s.city))}, ${esc(s.state)}`
          + ` · ${Math.round(s.km)} km ${bearing(place.lat, place.lon, s.lat, s.lon)}</span>`)
        .join('<hr>')).addTo(nearbyDrawn);
    }

    L.circleMarker([place.lat, place.lon], {
      radius: 5, color: '#f2f6f8', weight: 2,
      fillColor: '#112b3a', fillOpacity: 1,
    }).bindPopup('You are here').addTo(nearbyDrawn);

    // Fit the outer ring rather than the markers: an empty quadrant is itself
    // worth seeing, and fitting the markers would silently zoom in to hide it.
    fitMap(nearbyMap, L.latLng(place.lat, place.lon).toBounds(NEARBY_RADIUS * 2000));
  }

  /* One transmitter, and the path to it when a location is known. The line is
     the point: it carries the bearing, which is what a loop or a beam is turned
     to, and a distant catch reads as a line across three states rather than a
     number in a table.

     Rebuilt per station rather than kept, because renderStation replaces the
     whole panel's innerHTML and the old map's container goes with it. Leaflet
     would otherwise be left holding a detached node and its tile requests. */
  let stationMap = null;

  function drawStationMap(s) {
    if (stationMap) { stationMap.remove(); stationMap = null; }
    const box = $('station-map');
    if (!box || typeof L === 'undefined') return;
    stationMap = mapIn(box);

    L.circleMarker([s.lat, s.lon], {
      radius: 7, weight: 2,
      color: BAND_INK[s.band] || BAND_INK.FM,
      fillColor: BAND_INK[s.band] || BAND_INK.FM, fillOpacity: 0.55,
    }).bindPopup(`<strong>${esc(s.call)}</strong> ${freqLabel(s)} ${freqUnit(s)}`
      + `<br><span class="muted">${esc(titleCase(s.city))}`
      + `${s.state ? ', ' + esc(s.state) : ''}</span>`).addTo(stationMap);

    if (!place) {
      // No location, so nothing to draw a path to. 60 km of context puts the
      // transmitter in its own countryside rather than on a rooftop.
      fitMap(stationMap, L.latLng(s.lat, s.lon).toBounds(60000));
      return;
    }
    L.polyline([[place.lat, place.lon], [s.lat, s.lon]], {
      color: '#7a8b99', weight: 1.5, dashArray: '5 5', interactive: false,
    }).addTo(stationMap);
    L.circleMarker([place.lat, place.lon], {
      radius: 5, color: '#f2f6f8', weight: 2,
      fillColor: '#112b3a', fillOpacity: 1,
    }).bindPopup('You are here').addTo(stationMap);
    fitMap(stationMap, L.latLngBounds([[place.lat, place.lon], [s.lat, s.lon]]));
  }

  /* The occupied channels in range, in dial order, each with what heads it.
     AM leads for the same reason it leads on Nearby: 1700 kHz is 1.7 MHz and FM
     does not start until 88, so on one scale the AM band sits entirely below. */
  function channelsInRange(f, night) {
    const groups = new Map();
    for (const s of selected(f, true)) {
      const key = s.band + '|' + s.freq;
      if (!groups.has(key)) groups.set(key, { band: s.band, freq: s.freq, rows: [] });
      groups.get(key).rows.push(s);
    }
    const out = [...groups.values()];
    for (const g of out) {
      /* The name against a channel is what you would hear on it, which is the
         strongest arrival and not the nearest transmitter -- the two differ
         often enough to matter, and the panel already ranks this way. signal()
         reads the night column only for AM, so one flag serves a list holding
         both bands. */
      g.rows.sort(bySignal(night));
      g.top = g.rows[0];
      g.strength = signal(g.top, night);
    }
    out.sort((a, b) => a.band === b.band
      ? a.freq - b.freq
      : (a.band === 'AM' ? -1 : 1));
    return out;
  }

  function renderDial() {
    if (!place) {
      $('dial-out').innerHTML =
        '<p class="empty">Set a location above to walk the dial.</p>';
      return;
    }
    /* The radius has to be settled before the channel list is built, and the
       band decides it -- so it comes off the frequency in the hash rather than
       out of the list we have not made yet. */
    const asked = Number(route().arg);
    /* Whether the URL names a channel, which on one column is the whole
       difference between the picker page and the stations page. Not the same
       question as whether `current` exists -- that always resolves, falling
       back to the loudest in range, which is what makes landing on #dial useful
       on a desktop where both halves are on screen at once. */
    const picked = route().arg !== '';
    const mode = amModeOnScreen();
    if (mode && $('radius').value !== radiusPref[mode]) {
      $('radius').value = radiusPref[mode];
    }
    const f = filters();
    const chans = channelsInRange(f, isNight());
    if (!chans.length) {
      $('dial-out').innerHTML = '<p class="empty">No stations within that radius.</p>';
      return;
    }

    // Landing on #dial with nothing chosen parks on the loudest thing in range,
    // which is a more useful opening than the bottom of the AM band -- and the
    // same measure the channel list is named by.
    let current = chans.find((c) => c.freq === asked);
    if (!current) {
      current = chans.reduce((best, c) =>
        (c.strength ?? -1) > (best.strength ?? -1) ? c : best, chans[0]);
    }
    const at = chans.indexOf(current);
    const step = (i) => (i < 0 || i >= chans.length ? null
      : `#dial/${chans[i].freq}`);

    const list = chans.map((c) => {
      const on = c === current;
      return `<a class="chan${on ? ' chan-on' : ''}" href="#dial/${c.freq}">
        <span class="chan-freq">${freqLabel(c.top)}<span class="unit">${freqUnit(c.top)}</span></span>
        <span class="chan-top">${esc(c.top.call)}</span>
        <span class="chan-n">${c.rows.length > 1 ? c.rows.length : ''}</span></a>`;
    }).join('');

    /* Night only means something on AM. FM files one power and keeps it, and
       does not skywave reliably, so there is nothing to switch and the control
       would sit there doing nothing. */
    const amHere = current.band === 'AM';
    const night = amHere && isNight();
    /* The yardstick for the Signal column: the loudest thing on this band
       anywhere in range, so a badge means the same on every channel the reader
       steps through. Per band, because AM and FM do not propagate alike and
       kW/km2 across the two really would compare nothing. */
    const bandTop = chans.reduce((m, c) =>
      c.band === current.band ? Math.max(m, c.strength || 0) : m, 0);
    const { rows, total } = capByDistance(current.rows);
    rows.sort(bySignal(night));
    const prev = step(at - 1), next = step(at + 1);

    const daynight = !amHere ? '' : `
      <div class="daynight">
        <button type="button" data-night="0"${night ? '' : ' class="on"'}>Day</button>
        <button type="button" data-night="1"${night ? ' class="on"' : ''}>Night</button>
        <span class="muted">${night ? 'night power' : 'day power'}, strongest arrival first${sunNote(night)}</span>
      </div>`;

    $('dial-out').innerHTML = `
      ${bandHint(f)}
      <div class="split${picked ? ' split-picked' : ''}">
        <nav class="chans" aria-label="Occupied frequencies">
          <p class="chans-head">${chans.length} occupied</p>
          ${list}
        </nav>
        <section class="panel">
          <p class="crumb dial-back"><a href="#dial">‹ All frequencies</a></p>
          <div class="tune">
            ${prev ? `<a class="tune-btn" href="${prev}">‹ down</a>`
                   : '<span class="tune-btn tune-off">‹ down</span>'}
            <h2>${freqLabel(current.top)} <span class="unit">${freqUnit(current.top)}</span></h2>
            ${next ? `<a class="tune-btn" href="${next}">up ›</a>`
                   : '<span class="tune-btn tune-off">up ›</span>'}
          </div>
          ${daynight}
          ${capNote(total)}
          ${stationTable(rows, { night, top: bandTop })}
          ${adjacentBlock(current, chans)}
        </section>
      </div>`;

    /* The list is rebuilt on every render, so it comes back scrolled to the top
       with the channel you care about somewhere off the bottom. Put it back
       under the reader's thumb by setting the box's own scrollTop -- not
       scrollIntoView, which would take the page with it.

       On the picker page nothing is selected, so it aims at the channel last
       looked at instead. Coming back from 570 should land on 570, not at the
       bottom of the AM band. */
    /* On the picker page the highlight is on the loudest channel, because that
       is what `current` falls back to -- not on the one just left. So the last
       channel looked at wins there, and the highlight only when a channel is
       actually chosen or nothing has been looked at yet. */
    const nav = document.querySelector('#dial-out .chans');
    const lastEl = nav && lastDialFreq !== null
      && nav.querySelector(`a.chan[href="#dial/${lastDialFreq}"]`);
    const mark = nav && (picked
      ? (nav.querySelector('.chan-on') || lastEl)
      : (lastEl || nav.querySelector('.chan-on')));
    if (nav && mark) {
      nav.scrollTop = Math.max(0,
        mark.offsetTop - nav.offsetTop - nav.clientHeight / 2 + mark.offsetHeight / 2);
    }

    /* Arriving at the stations page should start at the stations. Only when the
       channel actually changed, or every filter keystroke and every day/night
       toggle would throw the page back to the top while being read. Narrow
       only: on two columns the panel is already beside the list and scrolling
       would be moving the page for no reason. */
    if (picked && lastDialFreq !== null && current.freq !== lastDialFreq
      && window.matchMedia('(max-width: 819px)').matches) {
      window.scrollTo(0, 0);
    }
    lastDialFreq = current.freq;

    for (const btn of document.querySelectorAll('[data-night]')) {
      btn.addEventListener('click', () => {
        nightOverride = btn.dataset.night === '1';
        writeNightOverride(nightOverride);
        // Each mode carries its own distance, so switching mode brings that
        // mode's distance with it rather than keeping the other one's.
        $('radius').value = radiusPref[nightOverride ? 'night' : 'day'];
        renderDial();
      });
    }
    const auto = $('night-auto');
    if (auto) {
      auto.addEventListener('click', () => {
        nightOverride = null;
        writeNightOverride(null);
        renderDial();
      });
    }
    for (const th of document.querySelectorAll('#dial-out th[data-sort]')) {
      th.addEventListener('click', () => {
        setSort(th.dataset.sort);
        renderDial();
      });
    }
  }

  /* What sits one channel either side, which is most of why a station you can
     see listed is not a station you can hear. Taken from the channels already
     in range rather than the whole table, so it answers about this dial rather
     than about the country. */
  function adjacentBlock(current, chans) {
    const stepKHz = current.band === 'FM' ? 0.2 : 10;
    const near = chans.filter((c) => c.band === current.band && c !== current
      && Math.abs(c.freq - current.freq) <= stepKHz * 1.01);
    if (!near.length) {
      return `<h3>Either side</h3><p class="empty">Both neighbouring channels are
        clear in range — nothing to splatter into this one.</p>`;
    }
    return `<h3>Either side</h3>` + near.map((c) => `
      <p class="adj"><a href="#dial/${c.freq}">${freqLabel(c.top)}
        ${freqUnit(c.top)}</a> — ${c.rows.length}
        ${c.rows.length === 1 ? 'station' : 'stations'},
        strongest ${esc(c.top.call)}</p>`).join('');
  }

  function renderSearch() {
    const q = $('q').value.trim().toUpperCase();
    if (q.length < 2) {
      $('search-out').innerHTML = '<p class="empty">Type at least two characters.</p>';
      return;
    }
    const f = filters();
    // Call signs match from the start; a station's identity is its prefix, and
    // matching anywhere turns a search for KEX into every W-station with those
    // letters buried in it. City and licensee match anywhere.
    const list = selected(f, false).filter((s) =>
      s.call.startsWith(q) || s.cityUpper.includes(q) || s.licenseeUpper.includes(q));
    list.sort((a, b) => {
      const ap = a.call.startsWith(q), bp = b.call.startsWith(q);
      if (ap !== bp) return ap ? -1 : 1;
      if (place) return a.km - b.km;
      return a.call.localeCompare(b.call);
    });
    $('search-out').innerHTML = table(list.slice(0, 500),
      `Nothing matches “${esc(q)}”.`, { licensee: true });
  }

  /* A station appearing, going, being renamed, moving frequency or changing
     status is news. A transmitter's coordinates being refined by a hundred
     metres is bookkeeping, and there is far more bookkeeping: of 470 changes in
     one refresh, 297 were latitude and longitude and 119 were power, leaving
     nine that a reader would call events. So the summary leads with the nine.

     The old view was a flat table of the last 400 rows, newest first. That was
     readable for two weeks and then stopped being a history at all -- the log
     appends about 450 rows a refresh and never trims, so by a year in, 400 rows
     is the last three weeks and everything before it exists in the file and
     cannot be reached from the page. */
  const CHANGE_NEWS = ['added', 'removed', 'call', 'freq', 'status'];

  /* One line per station, not per column that moved. The log is written a field
     at a time, so a transmitter that was resurveyed writes a lat row and a lon
     row and reads as two events; 470 rows on 16 August were 210 stations, and
     the commonest set by far is lat with lon -- a move, recorded twice.

     So lat and lon collapse into one "moved", with the distance, which is the
     thing the two rows were circling around anyway. It also separates a survey
     correction of eighty metres from a genuine relocation across town, which
     the raw before-and-after coordinates state without ever saying. */
  function movedBy(rows, station) {
    const pick = (f) => {
      const r = rows.find((x) => x.change === f);
      if (!r) return null;
      const m = String(r.detail).split('->').map((s) => Number(s.trim()));
      return m.length === 2 && m.every(isFinite) ? m : null;
    };
    const la = pick('lat'), lo = pick('lon');
    if (!la && !lo) return null;
    // A row carries only the field that changed, so the other side of the pair
    // comes from the station as it stands. Without it, a lone longitude cannot
    // be scaled -- a degree of it is 111 km at the equator and nothing at all
    // at the pole -- so that one goes unmeasured rather than guessed.
    const lat0 = la ? la[0] : (station ? station.lat : null);
    const lat1 = la ? la[1] : lat0;
    if (lat0 === null) return null;
    const lon0 = lo ? lo[0] : (station ? station.lon : null);
    const lon1 = lo ? lo[1] : lon0;
    if (lon0 === null) return la ? distanceKm(lat0, 0, lat1, 0) : null;
    return distanceKm(lat0, lon0, lat1, lon1);
  }

  function movedLabel(km) {
    return km < 1 ? `moved ${Math.round(km * 1000)} m`
      : `moved ${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
  }

  // What one station did in one refresh, as a sentence rather than a column.
  function changeDetail(rows, station) {
    const bits = [];
    const km = movedBy(rows, station);
    if (km !== null) bits.push(movedLabel(km));
    for (const r of rows) {
      if (r.change === 'lat' || r.change === 'lon') continue;
      if (r.change === 'added' || r.change === 'removed') continue;
      bits.push(`${r.change === 'freq' ? 'frequency' : r.change} ${
        String(r.detail).replace('->', '→')}`);
    }
    return bits.join(' · ');
  }

  // Counts stations, not log rows, so it agrees with the table underneath it.
  function changeSummary(stations) {
    const kinds = {};
    let routine = 0;
    for (const g of stations) {
      const mine = new Set(g.map((c) => c.change));
      const news = CHANGE_NEWS.filter((k) => mine.has(k));
      for (const k of news) kinds[k] = (kinds[k] || 0) + 1;
      if (!news.length) routine++;
    }
    const said = CHANGE_NEWS.filter((k) => kinds[k])
      .map((k) => `${kinds[k]} ${k === 'freq' ? 'frequency' : k === 'call' ? 'call sign' : k}`);
    const edits = routine ? `${routine.toLocaleString()} moved or re-rated` : '';
    return [...said, edits].filter(Boolean).join(' · ');
  }

  function renderChanges() {
    if (!CHANGES.length) {
      $('changes-out').innerHTML =
        '<p class="empty">No changes recorded yet — the log starts at the second refresh.</p>';
      return;
    }
    const byDate = new Map();
    for (const c of CHANGES) {
      if (!byDate.has(c.date)) byDate.set(c.date, []);
      byDate.get(c.date).push(c);
    }
    // Each date becomes its stations, once, before anything is drawn -- the
    // summary and the table under it have to be counting the same thing.
    const days = [...byDate.keys()].sort().reverse().map((d) => {
      const perStation = new Map();
      for (const c of byDate.get(d)) {
        if (!perStation.has(c.id)) perStation.set(c.id, []);
        perStation.get(c.id).push(c);
      }
      return { date: d, stations: [...perStation.values()] };
    });
    const touched = days.reduce((n, g) => n + g.stations.length, 0);
    /* Newest open, the rest closed. Opening every one would rebuild the flat
       wall this replaced, and the most recent refresh is the one anybody came
       to read. <details> rather than a route: it is native, needs no JavaScript
       to work, and a date is not a place worth having a URL of its own. */
    $('changes-out').innerHTML = `<p class="count">${
      touched.toLocaleString()} station ${touched === 1 ? 'change' : 'changes'}
      across ${days.length} ${days.length === 1 ? 'refresh' : 'refreshes'}</p>`
      + days.map(({ date: d, stations }, i) => {
        const shown = stations.slice(0, MAX_ROWS);
        return `<details class="chg-day"${i === 0 ? ' open' : ''}>
          <summary><strong>${esc(d)}</strong>
            <span class="chg-n">${stations.length.toLocaleString()}</span>
            <span class="muted">${esc(changeSummary(stations))}</span></summary>
          ${shown.length < stations.length ? `<p class="note">First ${
            MAX_ROWS.toLocaleString()} of ${stations.length.toLocaleString()} shown.</p>` : ''}
          <div class="scroll"><table>
            <thead><tr><th>Change</th><th>Call</th><th>Freq</th>
            <th>City</th><th>What moved</th></tr></thead><tbody>${shown.map((g) => {
              const c = g[0];
              const station = BY_ID.get(c.id);
              const moved = movedBy(g, station) !== null;
              const kinds = g.map((x) => x.change)
                .filter((k) => !(moved && (k === 'lat' || k === 'lon')));
              if (moved) kinds.push('moved');
              return `<tr>
                <td>${[...new Set(kinds)].map((k) =>
                  `<span class="chg chg-${esc(k)}">${esc(k)}</span>`).join(' ')}</td>
                <td class="call">${station
                  ? `<a href="#station/${encodeURIComponent(c.id)}">${esc(c.call)}</a>`
                  : esc(c.call)}</td>
                <td class="freq">${esc(c.freq)}</td>
                <td>${esc(titleCase(c.city))}${c.state ? ', ' + esc(c.state) : ''}</td>
                <td>${esc(changeDetail(g, station))}</td></tr>`;
            }).join('')}</tbody></table></div>
        </details>`;
      }).join('');
  }

  // ------------------------------------------------------- station detail

  /* Which of the stations on one frequency you are likeliest to be hearing.
     Power over distance squared -- free-space power density, the same arithmetic
     that says a lamp twice as far away looks a quarter as bright.

     It matters because distance alone gets this wrong. On 100.1 near Portland
     the nearest signal is a 100 W translator at 192 km and the one you would
     actually receive is KQFO, 8.4 kW at 283 km: further away and 39 times
     stronger. Ordering by distance puts the translator first.

     What it leaves out, and these are not small: terrain, which beats power
     outright on FM; antenna height, which on FM counts for nearly as much as
     power; and ground conductivity, which sets how fast AM groundwave dies and
     is not in this data at all. So it ranks the stations on one channel against
     each other -- never a claim about what you will hear, only about which is
     the stronger arrival. Comparing across frequencies would be meaningless.

     Distance is floored at 1 km. Nearer than that the arithmetic runs away and
     the answer is the same either way: you are on top of it. */
  function signal(s, night) {
    const kw = night && s.band === 'AM' ? s.erpNight : s.erp;
    if (kw === null || kw === undefined || s.km === null) return null;
    return kw / Math.pow(Math.max(s.km, 1), 2);
  }

  // Sorts strongest first, with anything unscoreable last rather than treated
  // as zero -- 127 live records file no power and that is not the same as none.
  function bySignal(night) {
    return (a, b) => {
      const x = signal(a, night), y = signal(b, night);
      if (x === null && y === null) return (a.km ?? 0) - (b.km ?? 0);
      if (x === null) return 1;
      if (y === null) return -1;
      return y - x;
    };
  }

  // A station filing day power and no night power is not quieter after dark, it
  // is off. 1,527 of them, and listing one at 2am as though you might tune it is
  // worse than saying nothing.
  function signsOff(s, night) {
    return night && s.band === 'AM' && s.erp !== null && s.erpNight === null;
  }

  /* Measured against the strongest arrival on this band at this location, not
     against the strongest on this channel.

     Against the channel it was actively misleading. A channel whose best
     station is a 250 W translator drew the same full bar as one headed by a
     50 kW local, because each was the best of its own three -- on 92.7 here,
     W224EB at 250 W and 38 km led the channel and read identical to an FM 930
     times stronger. The reader compares channels; the badge did not.

     Still nothing absolute: this is a ratio against a station the same reader
     could hear on the same band, which is a comparison the data supports. An
     absolute figure in dBu would not be, for the same reasons signal() lists.

     Said in dB because these run over five decades and because a ham reads
     "30 dB down" without conversion. Power ratios, so a factor of 100 is 20 dB.

     Nothing is lost from the old view: within a channel the rows are still
     sorted strongest first, so which of these three leads is the row order. */
  function signalBadge(s, top, night) {
    if (signsOff(s, night)) {
      return '<span class="sig-rel sig-off" title="Files no night power — off the air after dark">off</span>';
    }
    const v = signal(s, night);
    if (v === null || !top) {
      return '<span class="sig-rel sig-none" title="No power filed">—</span>';
    }
    const share = v / top;
    /* Whole dB. kW/km2 is a power ratio, so ten times log ten, and a tenth of
       a dB out of an estimate that ignores terrain and ground conductivity
       would be invented precision -- the second digit would be real arithmetic
       about an unreal number.

       The figure is printed and a rule under it runs to the same length, so the
       column can be scanned at a glance and read exactly, and neither of those
       depends on a tooltip a phone cannot open.

       The rule is drawn from the figure rather than from the band it fell in.
       In steps, -30 and -31 dB straddled a boundary and drew visibly different
       lengths while reading a decibel apart; measured off the number, the bar
       cannot contradict what it sits under. Colour stays in four steps, which
       is a category and not a measurement. */
    const down = Math.max(0, Math.round(-10 * Math.log10(share)));
    const cls = down <= 20 ? 'sig-a' : down <= 30 ? 'sig-b'
      : down <= 40 ? 'sig-c' : 'sig-d';
    const pct = Math.max(3, Math.min(100, Math.round(100 * (1 - down / SIG_FLOOR_DB))));
    const label = down === 0
      ? `The strongest ${s.band} arrival in range`
      : `${down} dB below the strongest ${s.band} arrival in range`;
    return `<span class="sig-rel ${cls}" style="--sig:${pct}%" title="${
      esc(label)}">${down === 0 ? '0 dB' : `-${down} dB`}</span>`;
  }

  function powerLabel(s) {
    if (s.erp === null) return 'not filed';
    return s.band === 'AM' && s.erpNight !== null && s.erpNight !== s.erp
      ? `${s.erp} kW day · ${s.erpNight} kW night`
      : `${s.erp} kW`;
  }

  /* Everything the CSV holds about one station, including the columns the list
     has no room for. HAAT and hours are the two that change what you will hear:
     an FM's reach comes as much from height as from power, and an AM on daytime
     hours is simply gone after sunset however strong it reads here. */
  function stationFacts(s) {
    const rows = [
      ['Service', `${s.service}${s.class ? ' · class ' + s.class : ''}`],
      ['Power', powerLabel(s)],
      ['Height above terrain', s.haat === null ? 'not filed' : `${s.haat} m`],
      ['Hours', s.hours ? ({ UNL: 'Unlimited', DAY: 'Daytime only', NIG: 'Night only' }[s.hours] || s.hours) : 'not filed'],
      // FM files DA or ND on every row, so an empty flag there is a real
      // answer. AM files the word or nothing, and nothing is ambiguous.
      ['Antenna', s.directional ? 'Directional'
        : s.band === 'FM' ? 'Non-directional' : 'Non-directional or not filed'],
      ['Status', s.status === 'LIC' ? 'Licensed' : s.status === 'CP' ? 'Construction permit' : s.status],
      ['Licensee', titleCase(s.licensee) || 'not filed'],
      ['Transmitter', `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`],
      ['FCC facility', s.id],
    ];
    return `<table class="facts"><tbody>${rows.map(([k, v]) =>
      `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`;
  }

  /* Who else is on this frequency, and who is one step off it. This is the
     question behind most of "why can I not hear it": a co-channel station in
     the same direction buries it, and on FM an adjacent channel splatters into
     it. Both come out of the table already in memory. */
  function neighbours(s) {
    const SHOWN = 20;
    const step = s.band === 'FM' ? 0.2 : 10;
    const near = (a, b) => Math.abs(a - b) < step / 2;
    const withKm = (x) => {
      x.km = place ? distanceKm(place.lat, place.lon, x.lat, x.lon) : null;
      return x;
    };
    const pool = STATIONS.filter((x) => x.band === s.band && x.id !== s.id && x.live);
    const co = pool.filter((x) => near(x.freq, s.freq));
    const adj = pool.filter((x) => !near(x.freq, s.freq)
      && Math.abs(x.freq - s.freq) <= step * 1.5);

    /* A popular FM frequency carries 400-odd stations nationwide, so the whole
       set is never the answer. Nearest is, and only a location makes "nearest"
       mean anything -- without one the first twenty by call sign would be an
       arbitrary slice dressed up as a shortlist, so the count is given and the
       table withheld. The heading always states the true total. */
    const block = (title, list, empty) => {
      const head = `<h3>${esc(title)}
        <span class="count-in-head">${list.length.toLocaleString()}</span></h3>`;
      if (!list.length) return head + `<p class="empty">${esc(empty)}</p>`;
      if (!place) {
        return head + `<p class="empty">Set a location to see which of these
          ${list.length.toLocaleString()} are near you.</p>`;
      }
      const shown = list.map(withKm).sort((a, b) => a.km - b.km).slice(0, SHOWN);
      return head + (list.length > SHOWN
        ? `<p class="count">Nearest ${SHOWN} of ${list.length.toLocaleString()}</p>` : '')
        + stationTable(shown);
    };

    return block(`Also on ${freqLabel(s)} ${freqUnit(s)}`, co,
        'Nothing else licensed on this frequency.')
      + block('One channel either side', adj,
        'Nothing licensed on the neighbouring channels.');
  }

  function captureForm(s) {
    const options = Object.keys(SIGNAL).sort((a, b) => b - a)
      .map((k) => `<option value="${k}">${esc(k)} — ${esc(SIGNAL[k])}</option>`).join('');
    return `<form id="capture" class="capture">
      <div class="row">
        <label>Heard at
          <input id="cap-at" type="datetime-local" value="${esc(localNow())}" required>
        </label>
        <label>Signal
          <select id="cap-signal">${options}</select>
        </label>
      </div>
      <label class="wide">Notes
        <textarea id="cap-notes" rows="2"
          placeholder="Programme, how it identified, fading, interference…"></textarea>
      </label>
      <div class="row">
        <button type="submit">Log this catch</button>
        <span class="muted">${place
          ? 'Heard from ' + esc(place.label)
          : 'No location set — the entry will not record where you heard it.'}</span>
      </div>
    </form>`;
  }

  function captureList(id) {
    const mine = capturesFor(id);
    if (!mine.length) return '<p class="empty">Not logged yet.</p>';
    return `<p class="count">${mine.length}
      ${mine.length === 1 ? 'catch' : 'catches'} logged</p>` + mine.map((e) => `<div class="catch">
      <div class="catch-head">
        <strong>${esc(formatWhen(e.at))}</strong>${asHeard(e, BY_ID.get(e.id))}
        <span class="sig sig-${esc(e.signal)}">${esc(e.signal)}</span>
        <span class="muted">${esc(SIGNAL[e.signal] || '')}</span>
        <button class="link-btn" data-del="${esc(captureKey(e))}">Delete</button>
      </div>
      ${e.from ? `<p class="muted">Heard from ${esc(e.from)}</p>` : ''}
      ${e.notes ? `<p>${esc(e.notes)}</p>` : ''}
    </div>`).join('');
  }

  function renderStation(id) {
    const s = BY_ID.get(id);
    if (!s) {
      $('station-out').innerHTML =
        `<p class="empty">No station with id ${esc(id)}. It may have left the
         FCC's table since that link was made.</p>
         <p><a href="#nearby">Back to Nearby</a></p>`;
      return;
    }
    const km = place ? distanceKm(place.lat, place.lon, s.lat, s.lon) : null;
    const where = km === null ? '' :
      `<p class="sub-dist">${km < 10 ? km.toFixed(1) : Math.round(km)} km
        ${esc(bearing(place.lat, place.lon, s.lat, s.lon))} of ${esc(place.label)}</p>`;

    $('station-out').innerHTML = `
      <p class="crumb"><a href="#nearby">← Back</a></p>
      <h2 class="station-title">${esc(s.call)}
        <span class="station-freq">${freqLabel(s)} <span class="unit">${freqUnit(s)}</span></span>
      </h2>
      <p class="sub">${esc(titleCase(s.city))}${s.state ? ', ' + esc(s.state) : ''}
        ${s.country !== 'US' ? `<span class="flag">${esc(s.country)}</span>` : ''}</p>
      ${where}
      ${stationFacts(s)}
      <div id="station-map"></div>
      <p class="small"><a href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=11/${s.lat}/${s.lon}"
        target="_blank" rel="noopener">Open in OpenStreetMap →</a></p>

      <h3>Did you hear it?</h3>
      ${captureForm(s)}
      <div id="cap-list">${captureList(s.id)}</div>

      ${neighbours(s)}`;

    // The list and its delete buttons are rebuilt together, so redrawing and
    // rewiring are one step that hands itself back for the next one.
    // After the innerHTML above, so the container the map measures exists.
    drawStationMap(s);

    const refresh = () => {
      $('cap-list').innerHTML = captureList(s.id);
      wireDeletes(refresh);
    };

    $('capture').addEventListener('submit', (ev) => {
      ev.preventDefault();
      const at = $('cap-at').value;
      if (!at) return;
      addCapture({
        id: s.id,
        at,
        signal: Number($('cap-signal').value),
        notes: $('cap-notes').value.trim(),
        /* Where you were, in numbers as well as words. The label is whatever the
           reader typed or, after the locate button, the literal string "Your
           location" -- which records nothing at all once the session is over.
           A reception report cites where the receiver stood, so the coordinates
           go in beside it. */
        from: place ? place.label : '',
        lat: place ? Number(place.lat.toFixed(5)) : null,
        lon: place ? Number(place.lon.toFixed(5)) : null,
        // What it was called and where it sat when you heard it. The facility
        // number outlives both -- a translator that moves frequency is renamed
        // by the FCC to match, K209FH on 89.7 becoming K206EU on 89.1 -- and a
        // log that quietly relabelled an old catch to the new call would
        // contradict the notes written beside it.
        call: s.call,
        freq: s.freq,
      });
      $('cap-notes').value = '';
      // Wind the clock on for the next one. Logging two catches in a session
      // otherwise reuses the moment the page was opened for both.
      $('cap-at').value = localNow();
      refresh();
    });
    wireDeletes(refresh);
  }

  // Delete buttons are rebuilt with the list they sit in, so they are wired by
  // walking the container rather than bound once at startup. The caller decides
  // what redrawing means and rewires from there.
  function wireDeletes(refresh) {
    for (const btn of document.querySelectorAll('[data-del]')) {
      btn.addEventListener('click', () => {
        removeCapture(btn.dataset.del);
        refresh();
      });
    }
  }

  // ----------------------------------------------------------------- logbook

  function renderLog() {
    const entries = readLog().sort((a, b) => b.at.localeCompare(a.at));
    if (!entries.length) {
      $('log-out').innerHTML = `<p class="empty">Nothing logged yet. Open a
        station from any list and mark it heard.</p>${logActions(false)}`;
      wireLogActions();
      return;
    }
    const rows = entries.map((e) => {
      const s = BY_ID.get(e.id);
      const name = s
        ? `<a href="#station/${encodeURIComponent(e.id)}">${esc(s.call)}</a>
           <span class="muted">${freqLabel(s)} ${freqUnit(s)}</span>${asHeard(e, s)}`
        : `${esc(e.call || e.id)} <span class="muted">no longer in the FCC table</span>`;
      const town = s ? `${titleCase(s.city)}${s.state ? ', ' + s.state : ''}` : '';
      return `<tr>
        <td>${esc(formatWhen(e.at))}</td>
        <td class="call">${name}</td>
        <td>${esc(town)}</td>
        <td><span class="sig sig-${esc(e.signal)}">${esc(e.signal)}</span></td>
        <td>${esc(e.from || '')}</td>
        <td>${esc(e.notes || '')}</td>
        <td><button class="link-btn" data-del="${esc(captureKey(e))}">Delete</button></td>
      </tr>`;
    }).join('');

    $('log-out').innerHTML = `
      <p class="count">${entries.length.toLocaleString()}
        ${entries.length === 1 ? 'catch' : 'catches'}
        · ${new Set(entries.map((e) => e.id)).size} distinct stations</p>
      ${logActions(true)}
      <div class="scroll"><table>
        <thead><tr><th>Heard at</th><th>Station</th><th>City</th><th>Signal</th>
        <th>From</th><th>Notes</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;

    $('log-export').addEventListener('click', () => exportLog(entries));
    wireLogActions();
    wireDeletes(renderLog);
  }

  // Held across the redraw an import triggers, because renderLog rebuilds the
  // element that would otherwise be holding the message. Shown once.
  let logNote = '';

  /* Import is offered with an empty log as well as a full one. An empty log is
     precisely when a restore is wanted -- a new browser, a new phone, or site
     data cleared to shift a stale service worker, which is a thing this app
     will tell you to do. Export is not, having nothing to write. */
  function logActions(canExport) {
    const note = logNote; logNote = '';
    return `<p class="log-actions">
      ${canExport ? '<button id="log-export" type="button">Export as CSV</button>' : ''}
      <button id="log-import-btn" type="button">Import CSV…</button>
      <input id="log-import" type="file" accept=".csv,text/csv" hidden>
      </p>${note ? `<p class="note">${esc(note)}</p>` : ''}`;
  }

  function wireLogActions() {
    $('log-import-btn').addEventListener('click', () => $('log-import').click());
    $('log-import').addEventListener('change', (ev) => {
      const file = ev.target.files && ev.target.files[0];
      // Cleared so choosing the same file twice fires change the second time.
      ev.target.value = '';
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const r = importLog(String(reader.result));
        logNote = r.error ? r.error
          : `Imported ${r.added} ${r.added === 1 ? 'catch' : 'catches'}`
            + (r.already ? `, ${r.already} already logged` : '')
            + (r.skipped ? `, ${r.skipped} skipped as unreadable` : '')
            + `. ${r.total} in the log now.`;
        renderLog();
      };
      reader.onerror = () => { logNote = 'That file could not be read.'; renderLog(); };
      reader.readAsText(file);
    });
  }

  /* A log nobody can get out of the browser is a log waiting to be lost with the
     site data. CSV because it is what a spreadsheet and every other logging
     program will read. */
  /* Everything an importer needs to rebuild an entry exactly, plus enough for a
     person to read the file without the app.

     Rebuilt from:  key, heard_at, facility, signal, notes, heard_from, lat, lon,
                    call, frequency
     Read from:     band, city, state, country, signal_note, now_call,
                    now_frequency -- all derivable from facility against a
                    current station table, and kept because a catch on a station
                    the FCC has since dropped can be derived from nothing.

     log_shape rides on every row because CSV has nowhere else to put it, and an
     importer written next year has to be able to tell what it is reading. Same
     reasoning as EXPORT_SHAPE on the station data: it costs a column now and
     cannot be added to files already in the wild. */
  function exportLog(entries) {
    const quote = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const head = ['log_shape', 'key', 'heard_at', 'facility', 'call', 'band',
      'frequency', 'city', 'state', 'country', 'signal', 'signal_note',
      'heard_from', 'lat', 'lon', 'notes', 'now_call', 'now_frequency'];
    const lines = [head.join(',')];
    for (const e of entries) {
      const s = BY_ID.get(e.id) || {};
      const call = e.call || s.call || '';
      const freq = e.freq != null ? e.freq : (s.freq == null ? '' : s.freq);
      lines.push([LOG_SHAPE, captureKey(e), e.at, e.id, call, s.band || '', freq,
        s.city || '', s.state || '', s.country || '', e.signal,
        SIGNAL[e.signal] || '', e.from || '',
        e.lat == null ? '' : e.lat, e.lon == null ? '' : e.lon,
        e.notes || '',
        s.call && s.call !== call ? s.call : '',
        s.freq != null && s.freq !== freq ? s.freq : ''].map(quote).join(','));
    }
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `dx-log-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  /* Reading the file back. Split on commas and this breaks on the first catch
     anyone described properly: notes come from a textarea, so they carry
     commas, quotation marks and newlines, and a quoted field holding a newline
     is one field spanning two lines of the file. So this walks the text a
     character at a time, which is the only way to know whether a newline ends a
     record or sits inside a field.

     RFC 4180: "" inside a quoted field is one literal quote. A leading byte
     order mark is stripped, because a spreadsheet that has been anywhere near
     Excel will have added one and it would otherwise become part of the first
     column's name. */
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = [];
    let row = [], field = '', quoted = false, i = 0;
    while (i < text.length) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
        if (c === '"') { quoted = false; i++; continue; }
        // A newline inside a field is content, but keep it in one flavour: a
        // note that has been through Windows would otherwise carry a stray
        // carriage return and hand it back on the next export, and again.
        if (c === '\r' && text[i + 1] === '\n') { field += '\n'; i += 2; continue; }
        field += c; i++; continue;
      }
      if (c === '"') { quoted = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /* The other half of exportLog, and the reason that file carries a key and a
     log_shape at all.

     Merges rather than replaces. Someone importing has a log they care about --
     that is why they exported it -- and a restore that silently discards what
     is already here is a worse failure than any it fixes. Entries already
     present win; the file cannot overwrite them.

     Matched on key, which is what makes repeat imports safe: import the same
     file twice and the second run adds nothing. Entries exported before keys
     existed fall back to facility plus timestamp, exactly as captureKey does.

     Columns are found by name, not position, so a file with columns added or
     reordered still reads. A row missing a facility, a timestamp or a usable
     signal is counted and skipped rather than taken as a broken entry, and the
     count is reported: a silent skip in a restore is how a log quietly loses
     rows it will never be known to have lost. */
  function importLog(text) {
    const rows = parseCsv(text);
    if (!rows.length) return { error: 'That file is empty.' };
    const head = rows[0].map((h) => h.trim().toLowerCase());
    const missing = ['heard_at', 'facility', 'signal'].filter((c) => !head.includes(c));
    if (missing.length) {
      return { error: `That is not a logbook export — it has no ${missing.join(' or ')} column.` };
    }
    const cell = (r, name) => {
      const i = head.indexOf(name);
      return i === -1 ? '' : String(r[i] == null ? '' : r[i]).trim();
    };
    // A file from a later version may use these columns differently. Reading it
    // by today's rules would corrupt the log rather than fail to load it.
    const newer = rows.slice(1).some((r) => Number(cell(r, 'log_shape')) > LOG_SHAPE);
    if (newer) {
      return { error: 'That file was written by a newer version of this app than'
        + ' this one, so it is not safe to read. Update, then import again.' };
    }
    const have = readLog();
    const seen = new Set(have.map(captureKey));
    const out = have.slice();
    let added = 0, already = 0, skipped = 0;
    for (const r of rows.slice(1)) {
      if (!r.some((c) => String(c).trim() !== '')) continue;
      const id = cell(r, 'facility'), at = cell(r, 'heard_at');
      const signal = Number(cell(r, 'signal'));
      if (!id || !at || !(signal >= 1 && signal <= 5)) { skipped++; continue; }
      const e = { key: cell(r, 'key') || `${id}|${at}`, id, at, signal };
      const notes = cell(r, 'notes'); if (notes) e.notes = notes;
      const from = cell(r, 'heard_from'); if (from) e.from = from;
      const call = cell(r, 'call'); if (call) e.call = call;
      for (const [col, prop] of [['lat', 'lat'], ['lon', 'lon'], ['frequency', 'freq']]) {
        const raw = cell(r, col);
        if (raw !== '' && isFinite(Number(raw))) e[prop] = Number(raw);
      }
      const key = captureKey(e);
      if (seen.has(key)) { already++; continue; }
      seen.add(key); out.push(e); added++;
    }
    if (added) { writeLog(out); refreshLogged(); }
    return { added, already, skipped, total: out.length };
  }

  /* The hash was a tab name and nothing else. A station detail needs to say
     which station, so it is the one route with an argument: #station/AM106053.
     Everything else keeps its bare name, and route() is the single place that
     knows the difference. */
  function route() {
    const raw = (location.hash || '#nearby').slice(1);
    const cut = raw.indexOf('/');
    return cut === -1
      ? { tab: raw, arg: '' }
      : { tab: raw.slice(0, cut), arg: decodeURIComponent(raw.slice(cut + 1)) };
  }

  function renderActive() {
    const { tab, arg } = route();
    if (tab === 'nearby') renderNearby();
    else if (tab === 'map') renderMap();
    else if (tab === 'dial') renderDial();
    else if (tab === 'search') renderSearch();
    else if (tab === 'changes') renderChanges();
    else if (tab === 'log') renderLog();
    else if (tab === 'station') renderStation(arg);
  }

  // ------------------------------------------------------------------- log

  /* Captures live in this browser and nowhere else. A DX log is a record of
     something that happened once at a particular place, so each entry carries
     where it was heard from rather than trusting the current location to still
     be the one that heard it -- a log read six months later from a different
     town has to still say where the catch was made. */
  function readLog() {
    try {
      const raw = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((e) => e && e.id && e.at) : [];
    } catch (e) { return []; }
  }

  function writeLog(entries) {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(entries)); } catch (e) {
      // Private mode, or the quota is gone. Saying so beats a button that
      // looks like it worked.
      alert('This browser would not save the entry. Private browsing will do that.');
    }
  }

  /* Which stations have been heard, for the tick in the lists. Kept as a set
     beside the log rather than read from it per row: the tables redraw on every
     keystroke in Search, and parsing the whole log 500 times a keystroke is a
     cost with nothing to show for it. */
  function refreshLogged() { LOGGED = new Set(readLog().map((e) => e.id)); }

  function addCapture(entry) {
    const entries = readLog();
    entries.push({ key: newKey(), ...entry });
    writeLog(entries);
    refreshLogged();
  }

  function removeCapture(key) {
    writeLog(readLog().filter((e) => captureKey(e) !== key));
    refreshLogged();
  }

  /* A station is meant to be logged more than once -- a second catch on another
     night is another reception report, not a correction of the first -- so an
     entry needs a name of its own. Station plus timestamp looked like enough and
     is not: the input is accurate to the minute, and two catches logged inside
     one minute would share a key, so deleting either would take both.
     Entries written before this carry no key and fall back to the old pair,
     which is exactly as unique as it ever was and no worse. */
  function newKey() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function captureKey(e) { return e.key || `${e.id}|${e.at}`; }

  /* Says so when the station has been renamed or moved since the catch. Entries
     written before the snapshot existed carry neither field and get nothing,
     which is right -- we do not know what it was called then. */
  function asHeard(e, s) {
    if (!s) return '';
    const bits = [];
    if (e.call && e.call !== s.call) bits.push(esc(e.call));
    if (e.freq != null && e.freq !== s.freq) bits.push(`${e.freq} ${freqUnit(s)}`);
    return bits.length ? ` <span class="as-heard">logged as ${bits.join(' on ')}</span>` : '';
  }

  function capturesFor(id) {
    return readLog().filter((e) => e.id === id).sort((a, b) => b.at.localeCompare(a.at));
  }

  // A datetime-local input wants local wall-clock, not the Z-suffixed UTC that
  // toISOString gives, so the offset comes off before slicing.
  function localNow() {
    const now = new Date();
    return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString().slice(0, 16);
  }

  function formatWhen(at) {
    const d = new Date(at);
    return isNaN(d) ? at : d.toLocaleString(undefined,
      { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  // --------------------------------------------------------------- location

  // Asking where you are is a question with an answer, and once it has one the
  // form is just clutter above the results. It folds down to the place itself
  // and a way back, rather than staying open waiting to be asked again.
  function syncPlaceControls() {
    $('place-entry').hidden = !!place;
    $('change-place').hidden = !place;
  }

  function setPlace(lat, lon, label) {
    place = { lat, lon, label: label || `${lat.toFixed(3)}, ${lon.toFixed(3)}` };
    $('lat').value = lat.toFixed(4);
    $('lon').value = lon.toFixed(4);
    $('where').textContent = place.label;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(place)); } catch (e) { /* private mode */ }
    syncPlaceControls();
    renderActive();
  }

  function restorePlace() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved && isFinite(saved.lat) && isFinite(saved.lon)) {
        setPlace(saved.lat, saved.lon, saved.label);
      }
    } catch (e) { /* nothing saved */ }
  }

  function wireControls() {
    $('locate').addEventListener('click', () => {
      if (!navigator.geolocation) {
        $('where').textContent = 'This browser will not share a location.';
        return;
      }
      $('where').textContent = 'Locating…';
      navigator.geolocation.getCurrentPosition(
        (pos) => setPlace(pos.coords.latitude, pos.coords.longitude, 'Your location'),
        (err) => { $('where').textContent = 'Location refused (' + err.message + ')'; },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 });
    });

    const manual = () => {
      const lat = parseFloat($('lat').value), lon = parseFloat($('lon').value);
      if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
        setPlace(lat, lon, null);
      }
    };
    $('lat').addEventListener('change', manual);
    $('lon').addEventListener('change', manual);

    $('change-place').addEventListener('click', () => {
      $('place-entry').hidden = false;
      $('change-place').hidden = true;
      $('lat').focus();
    });

    $('band').addEventListener('change', renderActive);
    $('radius').addEventListener('change', () => {
      // Changed while an AM channel is up, it is that mode's distance from now
      // on. Changed anywhere else it is just this view's, and neither AM slot
      // hears about it.
      const mode = amModeOnScreen();
      if (mode) {
        radiusPref[mode] = $('radius').value;
        writeRadiusPref();
      }
      renderActive();
    });
    syncPlaceControls();
    for (const id of ['live', 'us-only']) {
      $(id).addEventListener('change', renderActive);
    }
    $('q').addEventListener('input', renderSearch);
  }

  function wireTabs() {
    const show = () => {
      const { tab } = route();
      for (const section of document.querySelectorAll('.tab')) {
        section.style.display = section.id === 'tab-' + tab ? 'block' : 'none';
      }
      for (const link of document.querySelectorAll('#tabs a')) {
        link.classList.toggle('active', link.dataset.tab === tab);
      }
      // The location and filter bar drives Nearby, Dial and Search; it means
      // nothing on the reference tabs, so it goes away rather than sit inert.
      // A station detail is about one station and the filters cannot narrow it.
      $('controls').style.display =
        ['nearby', 'map', 'dial', 'search'].includes(tab) ? 'block' : 'none';
      // Hidden where it does not drive the view. Search passes useRadius false
      // -- it looks through every station and only sorts by distance, so
      // leaving "within 100 km" above the box would promise a limit that is not
      // applied. Nearby fixes its own distance, so the control would read as a
      // lever that does nothing. Dial is the one place it still means something.
      $('radius-label').hidden = ['search', 'nearby', 'map'].includes(tab);
      // A detail arrived at from halfway down a long list should not open
      // halfway down itself.
      if (tab === 'station') window.scrollTo(0, 0);
      renderActive();
    };
    window.addEventListener('hashchange', show);
    show();
  }

  // ------------------------------------------------------------------ load

  async function load() {
    const [stationsText, metaText, changesText] = await Promise.all([
      fetch('data/stations.csv').then((r) => r.text()),
      fetch('data/meta.json').then((r) => r.json()).catch(() => null),
      fetch('data/changes.csv').then((r) => r.ok ? r.text() : '').catch(() => ''),
    ]);
    META = metaText;

    STATIONS = toObjects(parseCSV(stationsText)).map((s) => ({
      id: s.id,
      band: s.band,
      service: s.service,
      call: s.call,
      freq: Number(s.freq),
      status: s.status,
      live: s.live === '1',
      class: s.class,
      city: s.city,
      state: s.state,
      country: s.country,
      lat: Number(s.lat),
      lon: Number(s.lon),
      erp: s.erp === '' ? null : Number(s.erp),
      erpNight: s.erp_night === '' ? null : Number(s.erp_night),
      haat: s.haat === '' ? null : Number(s.haat),
      hours: s.hours,
      directional: s.directional === 'Y',
      licensee: s.licensee,
      // Cached so the search does not upper-case 25,000 strings per keystroke.
      cityUpper: s.city.toUpperCase(),
      licenseeUpper: s.licensee.toUpperCase(),
      km: null,
    }));

    // The detail route and the logbook both arrive holding only an id.
    BY_ID = new Map(STATIONS.map((s) => [s.id, s]));
    refreshLogged();
    nightOverride = readNightOverride();
    radiusPref = readRadiusPref();

    if (changesText) CHANGES = toObjects(parseCSV(changesText));

    if (META && META.shape !== undefined && META.shape !== SHAPE) {
      document.querySelector('main').innerHTML =
        `<p class="empty">This page was written for data shape ${SHAPE} and the
         data says ${esc(String(META.shape))}. Reload to pick up the matching
         version; if that does not fix it, the deploy is half-finished.</p>`;
      return;
    }

    if (META) {
      $('meta-line').textContent =
        `${META.stations.toLocaleString()} stations · FCC data of ${META.generated}`;
      $('about-meta').textContent =
        `${META.stations.toLocaleString()} stations from ${META.source}, built ${META.generated}.`;
      // The version line of the colophon. There is no release number to show --
      // the code changes rarely and the data weekly, so the data vintage is the
      // version, and the export shape is what a reader would quote in a report.
      $('build-line').textContent =
        `FCC data of ${META.generated} · ${META.records.toLocaleString()} records · shape ${META.shape}`;
      writeLegend();
    }

    wireControls();
    restorePlace();
    wireTabs();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline is a bonus */ });
    }
  }

  load().catch((err) => {
    document.querySelector('main').insertAdjacentHTML('afterbegin',
      `<p class="empty">Could not load the station data: ${esc(err.message)}</p>`);
  });
})();
