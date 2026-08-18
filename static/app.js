/* Radio Stations — everything runs in the browser against docs/data/*.csv.
   There is no server: GitHub Pages hands over the station table and the
   filtering, distance maths and sorting all happen here.

   SPDX-FileCopyrightText: 2026 Mike Parker <mike@rsbl.org>
   SPDX-License-Identifier: LicenseRef-AllRightsReserved */
'use strict';

(function () {
  const KM_PER_DEGREE = 111.319;
  const EARTH_RADIUS_KM = 6371.0088;
  const STORE_KEY = 'radio-stations.place';
  const LOG_KEY = 'radio-stations.log';
  const DAYNIGHT_KEY = 'radio-stations.daynight';
  const RADIUS_KEY = 'radio-stations.radius';

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

  // The floor for "you are not going to hear this". See matches() for why 50 W
  // and not the round 100 that the low power FM cap would suggest.
  const TINY_KW = 0.05;

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

  /* The FCC draws the line at local sunset and sunrise, which move with the date
     and the latitude. The clock hour is a coarser stand-in and wrong by up to an
     hour or so at the edges of the year -- which is why the switch is there to
     be moved rather than only inferred. */
  function isNight() {
    if (nightOverride !== null) return nightOverride;
    const h = new Date().getHours();
    return h < 6 || h >= 18;
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
      hideTiny: $('hide-tiny').checked,
      live: $('live').checked,
      usOnly: $('us-only').checked,
      // Empty means no limit. Null rather than Infinity so selected() can tell
      // "no bound asked for" from "a bound that happens to be huge" -- the
      // bounding-box pre-filter is worth skipping entirely in the first case.
      radius: $('radius').value === '' ? null : Number($('radius').value),
    };
  }

  function matches(s, f) {
    if (f.band && s.band !== f.band) return false;
    /* 50 W, and the number is not arbitrary. LPFM is capped at 100 W by rule and
       most of it runs at the cap -- median 100, upper quartile 100 -- so a floor
       anywhere above that deletes the entire low power FM service in one step,
       and those are real stations somebody in town listens to. Below the cliff,
       50 W takes out 2,899 records, 2,125 of them translators repeating another
       station across a few kilometres.

       Day power, and a null is not a zero: 127 live records carry no ERP at all,
       and cutting those would assert they are weak when what the FCC actually
       did was not say. Unknown stays in. */
    if (f.hideTiny && s.erp !== null && s.erp < TINY_KW) return false;
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
         ${total.toLocaleString()} shown. Narrow the distance, the band or the
         power to see the rest.</p>`
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
    const top = o ? rows.reduce((m, s) => Math.max(m, signal(s, o.night) || 0), 0) : 0;
    return `<div class="scroll"><table>
      <thead><tr>${o
        ? sortHead('signal', 'Signal', 'Strength relative to the strongest on this frequency')
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

  function drawNearbyMap(rows) {
    const box = $('map-box');

    if (!nearbyMap) {
      nearbyMap = L.map(box, { scrollWheelZoom: false });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" '
          + 'target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      }).addTo(nearbyMap);
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
        color: am ? '#c2603a' : '#2f7d8c', weight: 1.5,
        fillColor: am ? '#c2603a' : '#2f7d8c', fillOpacity: 0.55,
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
    nearbyMap.fitBounds(
      L.latLng(place.lat, place.lon).toBounds(NEARBY_RADIUS * 2000),
      { padding: [8, 8] });
    // The tab is display:none until the router shows it, and a map built or
    // resized while hidden measures zero and renders one grey tile.
    nearbyMap.invalidateSize();
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
    const { rows, total } = capByDistance(current.rows);
    rows.sort(bySignal(night));
    const prev = step(at - 1), next = step(at + 1);

    const daynight = !amHere ? '' : `
      <div class="daynight">
        <button type="button" data-night="0"${night ? '' : ' class="on"'}>Day</button>
        <button type="button" data-night="1"${night ? ' class="on"' : ''}>Night</button>
        <span class="muted">${night ? 'night power' : 'day power'}, strongest arrival first${
          nightOverride === null ? ' — from the clock'
            : ' — <button type="button" class="link-btn" id="night-auto">follow the clock</button>'}</span>
      </div>`;

    $('dial-out').innerHTML = `
      ${bandHint(f)}
      <div class="split">
        <nav class="chans" aria-label="Occupied frequencies">
          <p class="chans-head">${chans.length} occupied</p>
          ${list}
        </nav>
        <section class="panel">
          <div class="tune">
            ${prev ? `<a class="tune-btn" href="${prev}">‹ down</a>`
                   : '<span class="tune-btn tune-off">‹ down</span>'}
            <h2>${freqLabel(current.top)} <span class="unit">${freqUnit(current.top)}</span></h2>
            ${next ? `<a class="tune-btn" href="${next}">up ›</a>`
                   : '<span class="tune-btn tune-off">up ›</span>'}
          </div>
          ${daynight}
          ${capNote(total)}
          ${stationTable(rows, { night })}
          ${adjacentBlock(current, chans)}
        </section>
      </div>`;

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

  function renderChanges() {
    if (!CHANGES.length) {
      $('changes-out').innerHTML =
        '<p class="empty">No changes recorded yet — the log starts at the second refresh.</p>';
      return;
    }
    const recent = CHANGES.slice(-400).reverse();
    $('changes-out').innerHTML = `<div class="scroll"><table>
      <thead><tr><th>Date</th><th>Change</th><th>Call</th><th>Freq</th>
      <th>City</th><th>Detail</th></tr></thead><tbody>${recent.map((c) => `<tr>
      <td class="num">${esc(c.date)}</td>
      <td><span class="chg chg-${esc(c.change)}">${esc(c.change)}</span></td>
      <td class="call">${esc(c.call)}</td>
      <td class="freq">${esc(c.freq)}</td>
      <td>${esc(titleCase(c.city))}${c.state ? ', ' + esc(c.state) : ''}</td>
      <td>${esc(c.detail)}</td></tr>`).join('')}</tbody></table></div>`;
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

  // Relative to the strongest on this channel, which is a comparison the data
  // supports. An absolute figure in dBu would not be.
  function signalBadge(s, top, night) {
    if (signsOff(s, night)) {
      return '<span class="sig-rel sig-off" title="Files no night power — off the air after dark">off</span>';
    }
    const v = signal(s, night);
    if (v === null || !top) {
      return '<span class="sig-rel sig-none" title="No power filed">—</span>';
    }
    const share = v / top;
    const [cls, label] = share >= 0.5 ? ['sig-a', 'strongest on this channel']
      : share >= 0.1 ? ['sig-b', 'within a tenth of the strongest']
      : share >= 0.01 ? ['sig-c', 'within a hundredth of the strongest']
      : ['sig-d', 'far weaker than the strongest here'];
    return `<span class="sig-rel ${cls}" title="${esc(label)}"></span>`;
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
      <p class="small"><a href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=11/${s.lat}/${s.lon}"
        target="_blank" rel="noopener">Transmitter on a map</a></p>

      <h3>Did you hear it?</h3>
      ${captureForm(s)}
      <div id="cap-list">${captureList(s.id)}</div>

      ${neighbours(s)}`;

    // The list and its delete buttons are rebuilt together, so redrawing and
    // rewiring are one step that hands itself back for the next one.
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
        station from any list and mark it heard.</p>`;
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
      <p><button id="log-export" type="button">Export as CSV</button></p>
      <div class="scroll"><table>
        <thead><tr><th>Heard at</th><th>Station</th><th>City</th><th>Signal</th>
        <th>From</th><th>Notes</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;

    $('log-export').addEventListener('click', () => exportLog(entries));
    wireDeletes(renderLog);
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
    for (const id of ['live', 'us-only', 'hide-tiny']) {
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
