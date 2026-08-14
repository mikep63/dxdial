/* Radio Stations — everything runs in the browser against docs/data/*.csv.
   There is no server: GitHub Pages hands over the station table and the
   filtering, distance maths and sorting all happen here. */
'use strict';

(function () {
  const KM_PER_DEGREE = 111.319;
  const EARTH_RADIUS_KM = 6371.0088;
  const STORE_KEY = 'radio-stations.place';

  let STATIONS = [];
  let CHANGES = [];
  let META = null;
  let place = null;                       // {lat, lon, label}

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
      service: $('service').value,
      live: $('live').checked,
      usOnly: $('us-only').checked,
      radius: Number($('radius').value),
    };
  }

  function matches(s, f) {
    if (f.band && s.band !== f.band) return false;
    if (f.service && s.service !== f.service) return false;
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
    let latMin = -Infinity, latMax = Infinity, lonMin = -Infinity, lonMax = Infinity;
    if (place && useRadius) {
      const dLat = f.radius / KM_PER_DEGREE;
      const cos = Math.max(0.01, Math.cos(place.lat * Math.PI / 180));
      const dLon = f.radius / (KM_PER_DEGREE * cos);
      latMin = place.lat - dLat; latMax = place.lat + dLat;
      lonMin = place.lon - dLon; lonMax = place.lon + dLon;
    }
    for (const s of STATIONS) {
      if (!matches(s, f)) continue;
      if (place) {
        if (useRadius && (s.lat < latMin || s.lat > latMax
          || s.lon < lonMin || s.lon > lonMax)) continue;
        s.km = distanceKm(place.lat, place.lon, s.lat, s.lon);
        if (useRadius && s.km > f.radius) continue;
      } else s.km = null;
      out.push(s);
    }
    return out;
  }

  // -------------------------------------------------------------- rendering

  function stationRows(list) {
    return list.map((s) => {
      const power = s.erp === null ? ''
        : s.band === 'AM' && s.erpNight !== null && s.erpNight !== s.erp
          ? `${s.erp} / ${s.erpNight} kW`
          : `${s.erp} kW`;
      const dist = s.km == null ? ''
        : `${s.km < 10 ? s.km.toFixed(1) : Math.round(s.km)} km ${bearing(place.lat, place.lon, s.lat, s.lon)}`;
      return `<tr>
        <td class="freq">${freqLabel(s)}<span class="unit">${freqUnit(s)}</span></td>
        <td class="call">${esc(s.call)}${!s.live ? `<span class="tag">${esc(s.status)}</span>` : ''}</td>
        <td>${esc(titleCase(s.city))}${s.state ? ', ' + esc(s.state) : ''}${s.country !== 'US' ? ` <span class="flag">${esc(s.country)}</span>` : ''}</td>
        <td class="num">${esc(dist)}</td>
        <td class="num">${esc(power)}</td>
        <td class="svc">${esc(s.service === 'AM' ? (s.class || 'AM') : s.service + (s.class ? ' ' + s.class : ''))}</td>
        <td class="licensee">${esc(titleCase(s.licensee))}</td>
      </tr>`;
    }).join('');
  }

  function table(list, note) {
    if (!list.length) return `<p class="empty">${note || 'Nothing matches.'}</p>`;
    return `<p class="count">${list.length.toLocaleString()} stations</p>
      <div class="scroll"><table>
      <thead><tr><th>Freq</th><th>Call</th><th>City</th><th>Distance</th>
      <th>Power</th><th>Service</th><th>Licensee</th></tr></thead>
      <tbody>${stationRows(list)}</tbody></table></div>`;
  }

  function renderNearby() {
    if (!place) {
      $('nearby-out').innerHTML =
        '<p class="empty">Set a location above to sort by distance.</p>';
      return;
    }
    const list = selected(filters(), true).sort((a, b) => a.km - b.km);
    $('nearby-out').innerHTML = table(list, 'No stations within that radius.');
  }

  function renderDial() {
    const f = filters();
    const list = selected(f, true);
    if (!list.length) {
      $('dial-out').innerHTML = `<p class="empty">${place
        ? 'No stations within that radius.' : 'Set a location above to walk the dial.'}</p>`;
      return;
    }
    // Frequency first, then the strongest or nearest station on it, so the one
    // you would actually hear on that spot of the dial heads its group.
    list.sort((a, b) => a.band === b.band
      ? (a.freq - b.freq) || ((a.km ?? 0) - (b.km ?? 0))
      : (a.band === 'FM' ? -1 : 1));

    let html = '', lastBand = null, lastFreq = null;
    for (const s of list) {
      if (s.band !== lastBand) {
        if (lastBand) html += '</tbody></table></div>';
        html += `<h3>${s.band}</h3><div class="scroll"><table><tbody>`;
        lastBand = s.band; lastFreq = null;
      }
      const newFreq = s.freq !== lastFreq;
      lastFreq = s.freq;
      const dist = s.km == null ? '' :
        `${s.km < 10 ? s.km.toFixed(1) : Math.round(s.km)} km ${bearing(place.lat, place.lon, s.lat, s.lon)}`;
      html += `<tr class="${newFreq ? 'freq-start' : 'freq-more'}">
        <td class="freq">${newFreq ? freqLabel(s) + `<span class="unit">${freqUnit(s)}</span>` : ''}</td>
        <td class="call">${esc(s.call)}</td>
        <td>${esc(titleCase(s.city))}${s.state ? ', ' + esc(s.state) : ''}${s.country !== 'US' ? ` <span class="flag">${esc(s.country)}</span>` : ''}</td>
        <td class="num">${esc(dist)}</td>
        <td class="num">${s.erp === null ? '' : s.erp + ' kW'}</td>
        <td class="svc">${esc(s.service)}</td></tr>`;
    }
    html += '</tbody></table></div>';
    $('dial-out').innerHTML = html;
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
      `Nothing matches “${esc(q)}”.`);
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

  function renderActive() {
    const tab = (location.hash || '#nearby').slice(1);
    if (tab === 'nearby') renderNearby();
    else if (tab === 'dial') renderDial();
    else if (tab === 'search') renderSearch();
    else if (tab === 'changes') renderChanges();
  }

  // --------------------------------------------------------------- location

  function setPlace(lat, lon, label) {
    place = { lat, lon, label: label || `${lat.toFixed(3)}, ${lon.toFixed(3)}` };
    $('lat').value = lat.toFixed(4);
    $('lon').value = lon.toFixed(4);
    $('where').textContent = place.label;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(place)); } catch (e) { /* private mode */ }
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

    for (const id of ['band', 'service', 'radius']) {
      $(id).addEventListener('change', renderActive);
    }
    for (const id of ['live', 'us-only']) {
      $(id).addEventListener('change', renderActive);
    }
    $('q').addEventListener('input', renderSearch);
  }

  function wireTabs() {
    const show = () => {
      const tab = (location.hash || '#nearby').slice(1);
      for (const section of document.querySelectorAll('.tab')) {
        section.style.display = section.id === 'tab-' + tab ? 'block' : 'none';
      }
      for (const link of document.querySelectorAll('#tabs a')) {
        link.classList.toggle('active', link.dataset.tab === tab);
      }
      // The location and filter bar drives Nearby, Dial and Search; it means
      // nothing on the reference tabs, so it goes away rather than sit inert.
      $('controls').style.display =
        ['nearby', 'dial', 'search'].includes(tab) ? 'block' : 'none';
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

    if (changesText) CHANGES = toObjects(parseCSV(changesText));

    if (META) {
      $('meta-line').textContent =
        `${META.stations.toLocaleString()} stations · FCC data of ${META.generated}`;
      $('about-meta').textContent =
        `${META.stations.toLocaleString()} stations from ${META.source}, built ${META.generated}.`;
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
