const DATA_API = '/api/zones';
const DIRECT_DATA_API = 'https://admin.opendata.dk/api/3/action/datastore_search?resource_id=d362c209-38c8-4465-9a85-b31b31c2e7db&limit=5000';

const map = L.map('map', { zoomControl: true }).setView([55.6761, 12.5683], 12);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap-bidragsydere'
}).addTo(map);

const zoneTitle = document.getElementById('zoneTitle');
const zoneText = document.getElementById('zoneText');
const accuracyText = document.getElementById('accuracyText');
const dataStatus = document.getElementById('dataStatus');
const locateBtn = document.getElementById('locateBtn');
const recenterBtn = document.getElementById('recenterBtn');
const zonesToggle = document.getElementById('zonesToggle');
const zoneSelect = document.getElementById('zoneSelect');

let zoneFeatureCollection = { type: 'FeatureCollection', features: [] };
let zoneLayer = null;
let currentPosition = null;
let userMarker = null;
let accuracyCircle = null;

function normalizeKey(key) {
  return String(key).toLowerCase().replaceAll('æ','ae').replaceAll('ø','o').replaceAll('å','a').replace(/[^a-z0-9]/g, '');
}

function firstProp(props, candidates) {
  const entries = Object.entries(props || {});
  for (const candidate of candidates) {
    const wanted = normalizeKey(candidate);
    const match = entries.find(([k]) => normalizeKey(k) === wanted);
    if (match && match[1] !== null && match[1] !== '') return match[1];
  }
  return '';
}

function featureCode(feature) {
  return String(firstProp(feature.properties, ['zonekode','zone_kode','kode','licenszone','zonecode','zone'])).trim().toUpperCase();
}

function featureName(feature) {
  return String(firstProp(feature.properties, ['zonenavn','zone_navn','navn','name','zonename'])).trim();
}

function featureType(feature) {
  return String(firstProp(feature.properties, ['zonetype','zone_type','type','kategori','category'])).trim();
}

function isResidentZone(feature) {
  const t = featureType(feature).toLowerCase();
  if (t) return t.includes('beboerzone') && !t.includes('adresse');
  const code = featureCode(feature);
  return /^[A-ZÆØÅ]{2,3}$/.test(code);
}

function parseMaybeJSON(value) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function parseWKT(wkt) {
  if (typeof wkt !== 'string') return null;
  const s = wkt.trim();
  const type = s.split('(')[0].trim().toUpperCase().replace(/^SRID=\d+;/, '');
  if (!['POLYGON','MULTIPOLYGON'].includes(type)) return null;

  // Small WKT parser for Polygon/MultiPolygon. Coordinates are expected as x y = lon lat.
  const body = s.slice(s.indexOf('('));
  let i = 0;
  function skip() { while (/\s/.test(body[i] || '')) i++; }
  function parseNumber() {
    skip();
    const m = body.slice(i).match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!m) throw new Error('number');
    i += m[0].length;
    return Number(m[0]);
  }
  function parsePair() {
    const x = parseNumber(); skip(); const y = parseNumber();
    while (true) { const save=i; try { skip(); if (/[0-9+\-.]/.test(body[i]||'')) parseNumber(); else break; } catch { i=save; break; } }
    return [x,y];
  }
  function parseGroup(depth=0) {
    skip(); if (body[i] !== '(') throw new Error('('); i++;
    const arr=[]; skip();
    while (i < body.length) {
      skip();
      if (body[i] === '(') arr.push(parseGroup(depth+1));
      else arr.push(parsePair());
      skip();
      if (body[i] === ',') { i++; continue; }
      if (body[i] === ')') { i++; break; }
      throw new Error('separator');
    }
    return arr;
  }
  try {
    const coords = parseGroup();
    return { type: type === 'POLYGON' ? 'Polygon' : 'MultiPolygon', coordinates: coords };
  } catch { return null; }
}

function geometryFromRecord(record) {
  for (const [key, raw] of Object.entries(record || {})) {
    const nk = normalizeKey(key);
    if (!/(geo|geom|shape|wkt)/.test(nk)) continue;
    const parsed = parseMaybeJSON(raw);
    if (parsed?.type === 'Feature') return parsed.geometry;
    if (parsed?.type && parsed?.coordinates) return parsed;
    const wkt = parseWKT(raw);
    if (wkt) return wkt;
  }
  return null;
}

function recordsToFeatures(payload) {
  if (payload?.type === 'FeatureCollection') return payload.features || [];
  if (Array.isArray(payload?.features)) return payload.features;
  const records = payload?.result?.records || payload?.records || [];
  return records.map(record => {
    const geometry = geometryFromRecord(record);
    if (!geometry) return null;
    return { type: 'Feature', properties: record, geometry };
  }).filter(Boolean);
}

function ringContains([lng, lat], ring) {
  let inside = false;
  for (let i=0, j=ring.length-1; i<ring.length; j=i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj-xi) * (lat-yi) / ((yj-yi) || Number.EPSILON) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonContains(point, polygon) {
  if (!polygon?.length || !ringContains(point, polygon[0])) return false;
  for (let i=1; i<polygon.length; i++) if (ringContains(point, polygon[i])) return false;
  return true;
}

function geometryContains(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return polygonContains(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(poly => polygonContains(point, poly));
  return false;
}

function findZone(lat, lng) {
  const point = [lng, lat];
  return zoneFeatureCollection.features.find(f => geometryContains(point, f.geometry)) || null;
}

function styleForFeature(feature) {
  const chosen = zoneSelect.value;
  const code = featureCode(feature);
  const dimmed = chosen && chosen !== code;
  return {
    color: dimmed ? '#8b8b8b' : '#b52b72',
    weight: dimmed ? 1 : 3,
    opacity: dimmed ? .25 : .9,
    fillColor: '#b52b72',
    fillOpacity: dimmed ? .01 : .05
  };
}

function redrawZones() {
  if (zoneLayer) map.removeLayer(zoneLayer);
  if (!zonesToggle.checked || !zoneFeatureCollection.features.length) return;
  zoneLayer = L.geoJSON(zoneFeatureCollection, {
    style: styleForFeature,
    onEachFeature(feature, layer) {
      const code = featureCode(feature) || 'Ukendt';
      const name = featureName(feature);
      layer.bindTooltip(name ? `${code} · ${name}` : code, { sticky: true });
    }
  }).addTo(map);
}

function updateZoneMessage(lat, lng) {
  if (!zoneFeatureCollection.features.length) {
    zoneTitle.textContent = 'Position fundet';
    zoneText.textContent = 'Zonedata er ikke klar endnu. Prøv igen om et øjeblik.';
    return;
  }
  const zone = findZone(lat, lng);
  if (zone) {
    const code = featureCode(zone) || 'ukendt';
    const name = featureName(zone);
    zoneTitle.textContent = `Du er i ${code}-zonen`;
    zoneText.textContent = name ? `${name} · Din GPS-position ligger inden for denne beboerlicenszone.` : 'Din GPS-position ligger inden for denne beboerlicenszone.';
  } else {
    zoneTitle.textContent = 'Ingen beboerzone fundet';
    zoneText.textContent = 'Din GPS-position ligger ikke inden for en registreret beboerlicenszone i datasættet.';
  }
}

function setUserPosition(position, recenter=true) {
  const { latitude, longitude, accuracy } = position.coords;
  currentPosition = [latitude, longitude];
  accuracyText.textContent = `GPS ± ${Math.round(accuracy)} m`;

  if (!userMarker) {
    const icon = L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [20,20], iconAnchor: [10,10] });
    userMarker = L.marker(currentPosition, { icon, zIndexOffset: 1000 }).addTo(map);
    accuracyCircle = L.circle(currentPosition, { radius: accuracy, weight: 1, fillOpacity: .06 }).addTo(map);
  } else {
    userMarker.setLatLng(currentPosition);
    accuracyCircle.setLatLng(currentPosition).setRadius(accuracy);
  }

  if (recenter) map.setView(currentPosition, Math.max(map.getZoom(), 16));
  updateZoneMessage(latitude, longitude);
}

function geolocationError(error) {
  locateBtn.disabled = false;
  const messages = {
    1: 'GPS-adgang blev afvist. Tillad placering i browserens indstillinger og prøv igen.',
    2: 'Din position kunne ikke bestemmes lige nu.',
    3: 'GPS-søgningen tog for lang tid. Prøv igen.'
  };
  zoneTitle.textContent = 'Kunne ikke hente GPS';
  zoneText.textContent = messages[error.code] || 'Der opstod en fejl med GPS-positionen.';
}

function locate() {
  if (!navigator.geolocation) {
    zoneTitle.textContent = 'GPS understøttes ikke';
    zoneText.textContent = 'Åbn siden i en moderne mobilbrowser.';
    return;
  }
  locateBtn.disabled = true;
  locateBtn.textContent = 'Finder position…';
  navigator.geolocation.getCurrentPosition(
    p => { setUserPosition(p, true); locateBtn.disabled=false; locateBtn.textContent='📍 Opdater min position'; },
    geolocationError,
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
  );
}

async function loadZones() {
  const endpoints = [DATA_API, DIRECT_DATA_API];
  let lastError;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json();
      const features = recordsToFeatures(payload).filter(isResidentZone);
      if (!features.length) throw new Error('Ingen beboerzone-geometrier fundet');
      zoneFeatureCollection = { type:'FeatureCollection', features };
      dataStatus.textContent = `${features.length} zoner indlæst`;

      const options = [...features]
        .map(f => ({ code: featureCode(f), name: featureName(f) }))
        .filter(x => x.code)
        .filter((x, i, arr) => arr.findIndex(y => y.code === x.code) === i)
        .sort((a,b) => a.code.localeCompare(b.code, 'da'));
      for (const o of options) {
        const el = document.createElement('option');
        el.value = o.code;
        el.textContent = o.name ? `${o.code} · ${o.name}` : o.code;
        zoneSelect.appendChild(el);
      }
      redrawZones();
      if (currentPosition) updateZoneMessage(...currentPosition);
      return;
    } catch (err) { lastError = err; }
  }
  console.error(lastError);
  dataStatus.textContent = 'Zonedata kunne ikke indlæses';
  zoneText.textContent = 'Appen er klar til GPS, men kommunens zonedata kunne ikke hentes. Prøv at genindlæse siden.';
}

locateBtn.addEventListener('click', locate);
recenterBtn.addEventListener('click', () => currentPosition ? map.setView(currentPosition, 16) : locate());
zonesToggle.addEventListener('change', redrawZones);
zoneSelect.addEventListener('change', redrawZones);

loadZones();
