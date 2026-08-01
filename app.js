import {
  featureCode,
  featureName,
  residentFeatures,
  findZone
} from './zone-core.js';

const DATA_API = '/api/zones';
const DIRECT_WFS = 'https://wfs-kbhkort.kk.dk/k101/ows?outputFormat=application%2Fjson&request=GetFeature&service=WFS&srsname=EPSG%3A4326&typeName=k101%3Ap_zoner_kbh&version=1.0.0';
const COPENHAGEN_CENTER = [55.6761, 12.5683];

const map = L.map('map', {
  zoomControl: true,
  preferCanvas: true,
  minZoom: 10,
  maxZoom: 20
}).setView(COPENHAGEN_CENTER, 12);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '&copy; OpenStreetMap-bidragsydere'
}).addTo(map);

const el = id => document.getElementById(id);
const zoneTitle = el('zoneTitle');
const zoneText = el('zoneText');
const accuracyText = el('accuracyText');
const dataStatus = el('dataStatus');
const locateBtn = el('locateBtn');
const recenterBtn = el('recenterBtn');
const zonesToggle = el('zonesToggle');
const zoneSelect = el('zoneSelect');
const retryDataBtn = el('retryDataBtn');
const mapStatus = el('mapStatus');

let zoneFeatures = [];
let zoneLayer = null;
let labelLayer = null;
let currentPosition = null;
let userMarker = null;
let accuracyCircle = null;
let activeGpsZoneCode = '';
let dataLoadState = 'loading';

function setDataState(state, message) {
  dataLoadState = state;
  dataStatus.textContent = message;
  dataStatus.dataset.state = state;
  retryDataBtn.hidden = state !== 'error';
  zoneSelect.disabled = state !== 'ready';
  zonesToggle.disabled = state !== 'ready';
}

function setLocationCopy(title, text) {
  zoneTitle.textContent = title;
  zoneText.textContent = text;
}

function setMapStatus(message, tone = 'neutral') {
  mapStatus.textContent = message;
  mapStatus.dataset.tone = tone;
  mapStatus.hidden = !message;
}

function uniqueZoneOptions(features) {
  const byCode = new Map();
  for (const feature of features) {
    const code = featureCode(feature);
    if (!code || byCode.has(code)) continue;
    byCode.set(code, { code, name: featureName(feature) });
  }
  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code, 'da'));
}

function populateZoneSelect(features) {
  const previous = zoneSelect.value;
  zoneSelect.replaceChildren(new Option('Alle beboerzoner', ''));
  for (const zone of uniqueZoneOptions(features)) {
    zoneSelect.add(new Option(zone.name ? `${zone.name} (${zone.code})` : zone.code, zone.code));
  }
  if ([...zoneSelect.options].some(option => option.value === previous)) zoneSelect.value = previous;
}

function styleForFeature(feature) {
  const selected = zoneSelect.value;
  const code = featureCode(feature);
  const isSelected = selected && code === selected;
  const isGps = activeGpsZoneCode && code === activeGpsZoneCode;
  const dimmed = selected && !isSelected;

  if (isSelected || isGps) {
    return {
      color: '#a31963',
      weight: 4,
      opacity: 1,
      fillColor: '#d43a86',
      fillOpacity: isSelected ? 0.22 : 0.14
    };
  }
  return {
    color: '#b52b72',
    weight: 2.25,
    opacity: dimmed ? 0.28 : 0.86,
    fillColor: '#d43a86',
    fillOpacity: dimmed ? 0.015 : 0.055
  };
}

function addZoneLabels() {
  if (labelLayer) map.removeLayer(labelLayer);
  labelLayer = L.layerGroup().addTo(map);
  if (!zonesToggle.checked || !zoneLayer) return;

  const boundsByCode = new Map();
  zoneLayer.eachLayer(layer => {
    const feature = layer.feature;
    const code = featureCode(feature);
    if (!code || !layer.getBounds) return;
    if (!boundsByCode.has(code)) boundsByCode.set(code, L.latLngBounds([]));
    boundsByCode.get(code).extend(layer.getBounds());
  });

  for (const [code, bounds] of boundsByCode) {
    if (!bounds.isValid()) continue;
    const isSelected = zoneSelect.value === code;
    const isGps = activeGpsZoneCode === code;
    L.marker(bounds.getCenter(), {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: 'zone-label-wrap',
        html: `<span class="zone-label${isSelected || isGps ? ' is-active' : ''}">${code}</span>`,
        iconSize: [48, 28],
        iconAnchor: [24, 14]
      })
    }).addTo(labelLayer);
  }
}

function redrawZones() {
  if (zoneLayer) map.removeLayer(zoneLayer);
  if (labelLayer) map.removeLayer(labelLayer);
  zoneLayer = null;
  labelLayer = null;

  if (!zonesToggle.checked || !zoneFeatures.length) return;

  zoneLayer = L.geoJSON({ type: 'FeatureCollection', features: zoneFeatures }, {
    style: styleForFeature,
    onEachFeature(feature, layer) {
      const code = featureCode(feature) || 'Ukendt zone';
      const name = featureName(feature);
      layer.bindTooltip(name ? `<strong>${code}</strong><br>${name}` : `<strong>${code}</strong>`, {
        sticky: true,
        direction: 'top',
        opacity: 0.96
      });
      layer.on('click', () => {
        zoneSelect.value = code;
        handleZoneSelection(true);
      });
    }
  }).addTo(map);

  addZoneLabels();
}

function boundsForCode(code) {
  if (!code) return null;
  const matching = zoneFeatures.filter(feature => featureCode(feature) === code);
  if (!matching.length) return null;
  const temp = L.geoJSON({ type: 'FeatureCollection', features: matching });
  const bounds = temp.getBounds();
  return bounds.isValid() ? bounds : null;
}

function handleZoneSelection(zoom = true) {
  const code = zoneSelect.value;
  redrawZones();
  if (!code) {
    setMapStatus('Alle beboerlicenszoner vises på kortet.');
    if (zoom && zoneLayer) map.fitBounds(zoneLayer.getBounds(), { padding: [18, 18], maxZoom: 13 });
    return;
  }

  const option = zoneSelect.options[zoneSelect.selectedIndex];
  setMapStatus(`${option.text} er fremhævet. GPS er ikke nødvendig for at vælge en zone.`, 'success');
  const bounds = boundsForCode(code);
  if (zoom && bounds) map.fitBounds(bounds, { padding: [26, 26], maxZoom: 15 });
}

function updateZoneMessage(lat, lng) {
  if (!zoneFeatures.length) {
    setLocationCopy('Din position er fundet', 'Zonedata indlæses stadig. Din zone vises automatisk, så snart data er klar.');
    return;
  }

  const zone = findZone(zoneFeatures, lat, lng);
  activeGpsZoneCode = zone ? featureCode(zone) : '';
  redrawZones();

  if (zone) {
    const code = activeGpsZoneCode || 'ukendt';
    const name = featureName(zone);
    setLocationCopy(
      name ? `Du er i ${name} (${code}) Zonen` : `Du er i ${code} Zonen`,
      'Din GPS-position ligger inden for denne beboerlicenszone.'
    );
    setMapStatus(name ? `${name} (${code}) er din aktuelle zone.` : `${code} er din aktuelle zone.`, 'success');
  } else {
    setLocationCopy('Du er uden for en beboerzone', 'Din GPS-position ligger ikke i en registreret beboerlicenszone i kommunens datasæt.');
    setMapStatus('GPS-positionen ligger uden for de viste beboerlicenszoner.', 'neutral');
  }
}

function setUserPosition(position, recenter = true) {
  const { latitude, longitude, accuracy } = position.coords;
  currentPosition = [latitude, longitude];
  accuracyText.textContent = `GPS ± ${Math.round(accuracy)} m`;
  accuracyText.dataset.state = accuracy <= 30 ? 'good' : accuracy <= 80 ? 'ok' : 'weak';

  if (!userMarker) {
    const icon = L.divIcon({
      className: '',
      html: '<div class="user-dot" aria-hidden="true"></div>',
      iconSize: [22, 22],
      iconAnchor: [11, 11]
    });
    userMarker = L.marker(currentPosition, { icon, zIndexOffset: 1000 }).addTo(map);
    accuracyCircle = L.circle(currentPosition, {
      radius: accuracy,
      weight: 1,
      color: '#1769e0',
      fillColor: '#1769e0',
      fillOpacity: 0.07
    }).addTo(map);
  } else {
    userMarker.setLatLng(currentPosition);
    accuracyCircle.setLatLng(currentPosition).setRadius(accuracy);
  }

  recenterBtn.disabled = false;
  if (recenter) map.setView(currentPosition, Math.max(map.getZoom(), 16), { animate: true });
  updateZoneMessage(latitude, longitude);
}

function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

async function getGeolocationPermissionState() {
  if (!navigator.permissions?.query) return 'unknown';
  try {
    const permission = await navigator.permissions.query({ name: 'geolocation' });
    return permission?.state || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getPosition(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(resolve, reject, options);
  });
}

async function getPositionRobustly() {
  try {
    return await getPosition({
      enableHighAccuracy: false,
      timeout: 15000,
      maximumAge: 30000
    });
  } catch (firstError) {
    if (firstError?.code === 1) throw firstError;
    return await getPosition({
      enableHighAccuracy: true,
      timeout: 25000,
      maximumAge: 0
    });
  }
}

async function gpsErrorDetails(error) {
  const permission = await getGeolocationPermissionState();
  const ios = isIOS();

  if (!window.isSecureContext) {
    return {
      title: 'GPS kræver HTTPS',
      text: 'Åbn appens Vercel-link direkte via https:// i Safari eller Chrome.',
      status: 'GPS er blokeret, fordi forbindelsen ikke er sikker.'
    };
  }

  if (error?.code === 1) {
    if (ios) {
      return {
        title: 'iPhone blokerer GPS-adgangen',
        text: 'Safari-webstedet kan godt stå til “Tillad”, mens iOS stadig blokerer selve GPS-tjenesten. Gå til Indstillinger → Anonymitet & sikkerhed → Lokalitetstjenester. Sørg for at Lokalitetstjenester er slået til. Find derefter Safari-websteder, vælg “Ved brug af appen”, og slå “Præcis lokalitet” til. Åbn derefter appen igen.',
        status: permission === 'granted'
          ? 'Safari melder tilladelse, men iOS afviser stadig positionen. Tjek Lokalitetstjenester → Safari-websteder.'
          : 'iOS afviser positionen. Tjek både Lokalitetstjenester og Safari-websteder.'
      };
    }
    return {
      title: 'GPS-adgang er blokeret',
      text: 'Browseren eller enhedens lokalitetsindstillinger afviser GPS. Tillad placering både for browseren og for dette websted, og prøv igen.',
      status: 'GPS-adgang blev afvist af browseren eller enheden.'
    };
  }

  if (error?.code === 2) {
    return {
      title: 'Position kunne ikke bestemmes',
      text: 'Telefonen kunne ikke finde en stabil position. Kontroller at Lokalitetstjenester er slået til, og prøv igen — gerne tættere på et vindue eller udendørs.',
      status: 'GPS-signalet kunne ikke give en position. Zonekortet virker stadig.'
    };
  }

  if (error?.code === 3) {
    return {
      title: 'GPS tog for lang tid',
      text: 'Telefonen nåede ikke at finde din position. Prøv igen — gerne tættere på et vindue eller udendørs.',
      status: 'GPS-forsøget fik timeout. Zonekortet virker stadig.'
    };
  }

  return {
    title: 'GPS kunne ikke hentes',
    text: `Der opstod en ukendt GPS-fejl${error?.message ? `: ${error.message}` : '.'}`,
    status: 'GPS fejlede, men zonekortet virker stadig uden GPS.'
  };
}

async function geolocationError(error) {
  const details = await gpsErrorDetails(error);
  locateBtn.disabled = false;
  locateBtn.textContent = 'Prøv GPS igen';
  accuracyText.textContent = error?.code === 1 ? 'GPS adgang afvist' : 'GPS ikke tilgængelig';
  accuracyText.dataset.state = 'error';
  setLocationCopy(details.title, details.text);
  setMapStatus(details.status, 'warning');
  console.warn('GPS diagnostic', {
    code: error?.code,
    message: error?.message,
    secureContext: window.isSecureContext,
    ios: isIOS(),
    userAgent: navigator.userAgent
  });
}

async function permissionHint() {
  const state = await getGeolocationPermissionState();
  if (state === 'denied') {
    setMapStatus('Placering er blokeret i browseren. Zonekortet virker stadig uden GPS.', 'warning');
  }
}

async function locate() {
  if (!navigator.geolocation) {
    setLocationCopy('GPS understøttes ikke', 'Din browser tilbyder ikke GPS-adgang. Zonekortet og zonevælgeren kan stadig bruges.');
    setMapStatus('Prøv Safari eller Chrome på en nyere telefon for GPS.', 'warning');
    return;
  }
  if (!window.isSecureContext) {
    await geolocationError({ code: 0 });
    return;
  }

  locateBtn.disabled = true;
  locateBtn.textContent = 'Finder din position…';
  accuracyText.textContent = 'GPS søger…';
  accuracyText.dataset.state = 'loading';

  try {
    const position = await getPositionRobustly();
    setUserPosition(position, true);
    locateBtn.disabled = false;
    locateBtn.textContent = 'Opdater min position';
  } catch (error) {
    await geolocationError(error);
  }
}

async function fetchJsonWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadZones({ fit = true } = {}) {
  setDataState('loading', 'Henter zoner…');
  setMapStatus('Henter de officielle beboerlicenszoner…');

  const endpoints = [DATA_API, DIRECT_WFS];
  let lastError = null;

  for (const endpoint of endpoints) {
    try {
      const payload = await fetchJsonWithTimeout(endpoint);
      const features = residentFeatures(payload);
      if (!features.length) throw new Error('Ingen beboerzoner i svaret');

      zoneFeatures = features;
      populateZoneSelect(features);
      setDataState('ready', `${uniqueZoneOptions(features).length} zoner klar`);
      redrawZones();

      if (fit && zoneLayer) map.fitBounds(zoneLayer.getBounds(), { padding: [12, 12], maxZoom: 12 });
      setMapStatus('Zonekortet er klar. Vælg en zone eller brug GPS.', 'success');
      if (currentPosition) updateZoneMessage(...currentPosition);
      return true;
    } catch (error) {
      lastError = error;
      console.warn('Zone endpoint failed:', endpoint, error);
    }
  }

  console.error('Kunne ikke indlæse zoner:', lastError);
  zoneFeatures = [];
  setDataState('error', 'Zonedata fejlede');
  setMapStatus('Kunne ikke hente kommunens zonedata. Tryk “Prøv zonedata igen”.', 'error');
  return false;
}

locateBtn.addEventListener('click', locate);
recenterBtn.addEventListener('click', () => {
  if (currentPosition) map.setView(currentPosition, 16, { animate: true });
  else locate();
});
zonesToggle.addEventListener('change', () => {
  redrawZones();
  setMapStatus(zonesToggle.checked ? 'Zonegrænser vises.' : 'Zonegrænser er skjult.');
});
zoneSelect.addEventListener('change', () => handleZoneSelection(true));
retryDataBtn.addEventListener('click', () => loadZones({ fit: false }));

window.addEventListener('online', () => {
  if (dataLoadState === 'error') loadZones({ fit: false });
});
window.addEventListener('offline', () => setMapStatus('Du er offline. Kortfliser og friske zonedata kan være utilgængelige.', 'warning'));

recenterBtn.disabled = true;
permissionHint();
loadZones();
