import {
  featureCode,
  featureName,
  featureType,
  residentFeatures,
  timeRestrictionFeatures,
  findZone
} from './zone-core.js';

const DATA_API = '/api/zones';
const DIRECT_WFS = 'https://wfs-kbhkort.kk.dk/k101/ows?outputFormat=application%2Fjson&request=GetFeature&service=WFS&srsname=EPSG%3A4326&typeName=k101%3Ap_zoner_kbh&version=1.0.0';
const COPENHAGEN_CENTER = [55.6761, 12.5683];
const FREDERIKSBERG_GEOJSON = 'https://api.dataforsyningen.dk/kommuner/0147?format=geojson';

const TIME_LIMIT_RULES = Object.freeze({
  GJ: { hours: 3, window: '08–19', days: 'hverdage' },
  HS: { hours: 3, window: '08–19', days: 'hverdage' },
  NV: { hours: 3, window: '08–19', days: 'hverdage' },
  VS: { hours: 3, window: '08–19', days: 'hverdage' },
  HA: { hours: 3, window: '08–19', days: 'hverdage' },

  VL: { hours: 3, window: '08–22', days: 'hverdage' },
  LP: { hours: 3, window: '08–22', days: 'hverdage' },
  AS: { hours: 3, window: '08–22', days: 'hverdage' },
  SV: { hours: 3, window: '08–22', days: 'hverdage' },
  'SØ': { hours: 3, window: '08–22', days: 'hverdage' },
  GD: { hours: 3, window: '08–22', days: 'hverdage' },
  'ÅH': { hours: 3, window: '08–22', days: 'hverdage' },
  BB: { hours: 3, window: '08–22', days: 'hverdage' },
  KE: { hours: 3, window: '08–22', days: 'hverdage' },
  VI: { hours: 3, window: '08–22', days: 'hverdage' },
  RP: { hours: 3, window: '08–22', days: 'hverdage' },
  SJ: { hours: 3, window: '08–22', days: 'hverdage' },

  HK: { hours: 1, window: '08–17', days: 'mandag–lørdag', special: true }
});

function zoneParkingRule(code) {
  if (code === 'FR') {
    return {
      timed: false,
      short: 'Frederiksberg betalingszone',
      detail: 'Områdekode 2000. Betaling hverdage kl. 07–24 og lørdage kl. 07–17. Søndage og kommunens betalingsfri helligdage er gratis. Tjek altid lokal skiltning.'
    };
  }

  const rule = TIME_LIMIT_RULES[code];
  if (!rule) {
    return {
      timed: false,
      short: 'Betalings-/beboerlicenszone',
      detail: 'Tjek altid lokal skiltning og afmærkning, da enkelte gader kan have særlige regler.'
    };
  }

  if (rule.special) {
    return {
      timed: true,
      short: 'Gratis · tidsbegrænset parkering',
      detail: `Maks. ${rule.hours} time ${rule.days} kl. ${rule.window}. Den Hvide Kødby har særlige licensregler. Husk p-skive og tjek skiltningen.`
    };
  }

  return {
    timed: true,
    short: 'Gratis · tidsbegrænset parkering',
    detail: `Maks. ${rule.hours} timer på ${rule.days} kl. ${rule.window}. Husk p-skive. Weekender og helligdage er uden 3-timersbegrænsningen. En gyldig beboerlicens til zonen fritager fra tidsbegrænsningen.`
  };
}

function isTimedLicenseZone(code) {
  return Boolean(TIME_LIMIT_RULES[code]);
}


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
let timeRestrictionFeaturesOnMap = [];
let zoneLayer = null;
let timeRestrictionLayer = null;
let labelLayer = null;
let currentPosition = null;
let currentAccuracy = null;
let userMarker = null;
let accuracyCircle = null;
let activeGpsZoneCode = '';
let pinnedZoneCode = '';
let dataLoadState = 'loading';
let dismissedParkingNoticeKey = '';


function ensureParkingNoticePopup() {
  let popup = document.getElementById('parkingNoticePopup');
  if (popup) return popup;

  const style = document.createElement('style');
  style.textContent = `
    .parking-notice-popup{position:absolute;z-index:950;left:50%;top:54px;width:min(330px,calc(100% - 24px));transform:translateX(-50%);padding:10px 38px 10px 12px;border:1px solid #b9dfc8;border-radius:13px;background:rgba(244,252,247,.98);color:#195f3a;box-shadow:0 10px 28px rgba(16,24,40,.16);backdrop-filter:blur(12px);font-size:11px;line-height:1.35;pointer-events:auto}
    .parking-notice-popup[hidden]{display:none}
    .parking-notice-popup strong{display:block;margin-bottom:2px;color:#14532d;font-size:11.5px}
    .parking-notice-popup button{position:absolute;top:6px;right:7px;width:28px;height:28px;display:grid;place-items:center;border:0;border-radius:8px;background:transparent;color:#357454;font-size:20px;line-height:1;cursor:pointer}
    .parking-notice-popup button:active{background:rgba(20,83,45,.08)}
    @media(max-width:390px){.parking-notice-popup{top:48px;width:calc(100% - 18px);padding:9px 36px 9px 10px;font-size:10.5px}}
  `;
  document.head.appendChild(style);

  popup = document.createElement('div');
  popup.id = 'parkingNoticePopup';
  popup.className = 'parking-notice-popup';
  popup.hidden = true;
  popup.setAttribute('role','status');
  popup.setAttribute('aria-live','polite');
  popup.innerHTML = `<strong id="parkingNoticeTitle">Parkeringsinfo</strong><span id="parkingNoticeText"></span><button type="button" aria-label="Luk parkeringsinfo">×</button>`;

  const mapStage = document.querySelector('.map-stage');
  if (mapStage) mapStage.appendChild(popup);

  popup.querySelector('button').addEventListener('click', event => {
    event.stopPropagation();
    dismissedParkingNoticeKey = popup.dataset.noticeKey || '';
    popup.hidden = true;
  });
  return popup;
}

function showParkingNoticePopup(code, notice) {
  const popup = ensureParkingNoticePopup();
  if (!popup) return;
  if (!notice) {
    popup.hidden = true;
    popup.dataset.noticeKey = '';
    return;
  }

  const key = `${code}|${notice}`;
  if (dismissedParkingNoticeKey === key) return;

  document.getElementById('parkingNoticeTitle').textContent =
    code === 'FR' ? 'Parkeringsinfo · Frederiksberg' : '1. time gratis';
  document.getElementById('parkingNoticeText').textContent = notice;
  popup.dataset.noticeKey = key;
  popup.hidden = false;
}

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

const zonePickerBtn = document.getElementById('zonePickerBtn');
const zonePickerLabel = document.getElementById('zonePickerLabel');
const zonePickerMenu = document.getElementById('zonePickerMenu');

function compactRuleLabel(code) {
  if (code === 'FR') return isFrederiksbergFreeDay() ? 'Gratis i dag' : 'Betaling · 2000';
  const rule = zoneParkingRule(code);
  if (!rule.timed) return isCopenhagenFirstHourFreeNow() ? '1. time gratis*' : 'Betaling';
  const hours = TIME_LIMIT_RULES[code]?.hours;
  return hours ? `Gratis ${hours} t` : 'Gratis';
}

function compactRuleClass(code) {
  return zoneParkingRule(code).timed ? 'is-free' : 'is-paid';
}

function syncZonePickerLabel() {
  const selected = zoneSelect.selectedOptions?.[0];
  const code = selected?.value || '';

  if (!code) {
    zonePickerLabel.textContent = 'Alle beboerzoner';
    return;
  }

  const option = uniqueZoneOptions(zoneFeatures).find(zone => zone.code === code);
  const name = option?.name || code;
  zonePickerLabel.textContent = `${name} (${code}) · ${compactRuleLabel(code)}`;
}

function buildCompactZonePicker(features) {
  zonePickerMenu.replaceChildren();

  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'zone-picker-option is-all';
  all.dataset.value = '';
  all.setAttribute('role', 'option');
  all.innerHTML = '<span class="zone-dot is-all-dot"></span><span class="zone-option-main">Alle beboerzoner</span>';
  zonePickerMenu.appendChild(all);

  for (const zone of uniqueZoneOptions(features)) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'zone-picker-option';
    option.dataset.value = zone.code;
    option.setAttribute('role', 'option');

    const name = zone.name || zone.code;
    option.innerHTML = `
      <span class="zone-dot ${compactRuleClass(zone.code)}"></span>
      <span class="zone-option-main"><strong>${zone.code}</strong><span>${name}</span></span>
      <span class="zone-option-rule">${compactRuleLabel(zone.code)}</span>
    `;
    zonePickerMenu.appendChild(option);
  }

  zonePickerBtn.disabled = false;
  syncZonePickerLabel();
}

zonePickerBtn.addEventListener('click', () => {
  const opening = zonePickerMenu.hidden;
  zonePickerMenu.hidden = !opening;
  zonePickerBtn.setAttribute('aria-expanded', String(opening));
});

zonePickerMenu.addEventListener('click', (event) => {
  const option = event.target.closest('.zone-picker-option');
  if (!option) return;

  zoneSelect.value = option.dataset.value || '';
  closePinnedZoneTooltip();
  zoneSelect.dispatchEvent(new Event('change', { bubbles: true }));
  syncZonePickerLabel();
  zonePickerMenu.hidden = true;
  zonePickerBtn.setAttribute('aria-expanded', 'false');
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#zonePicker') && !zonePickerMenu.hidden) {
    zonePickerMenu.hidden = true;
    zonePickerBtn.setAttribute('aria-expanded', 'false');
  }
});



function easterSunday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

function dateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()+1}-${date.getDate()}`;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function isFrederiksbergFreeDay(now = new Date()) {
  if (now.getDay() === 0) return true;
  const y = now.getFullYear();
  const easter = easterSunday(y);
  const free = [
    new Date(y,0,1), new Date(y,5,5), new Date(y,11,24), new Date(y,11,25), new Date(y,11,26),
    addDays(easter,-3), addDays(easter,-2), easter, addDays(easter,1),
    addDays(easter,39), addDays(easter,49), addDays(easter,50)
  ];
  return free.some(d => dateKey(d) === dateKey(now));
}

function isCopenhagenFirstHourFreeNow(now = new Date()) {
  const day = now.getDay(), hour = now.getHours();
  if ((day === 6 && hour >= 17) || day === 0 || (day === 1 && hour < 8)) return true;

  const y = now.getFullYear();
  const easter = easterSunday(y);
  const specialDays = [
    new Date(y,0,1), new Date(y,5,5), new Date(y,11,24), new Date(y,11,25), new Date(y,11,26),
    addDays(easter,-3), addDays(easter,-2), easter, addDays(easter,1),
    addDays(easter,39), addDays(easter,49), addDays(easter,50)
  ];
  return specialDays.some(d => dateKey(d) === dateKey(now));
}

function currentParkingNotice(code, now = new Date()) {
  if (code === 'FR') {
    if (isFrederiksbergFreeDay(now)) {
      return 'Gratis parkering i dag på Frederiksberg · ingen digital registrering nødvendig. Lokale restriktioner kan stadig gælde.';
    }
    const day = now.getDay(), hour = now.getHours();
    const paymentNow = (day >= 1 && day <= 5 && hour >= 7) || (day === 6 && hour >= 7 && hour < 17);
    return paymentNow
      ? 'Betaling gælder nu · områdekode 2000.'
      : 'Gratis uden for betalingstiden. Lokale restriktioner kan stadig gælde.';
  }

  if (!isTimedLicenseZone(code) && isCopenhagenFirstHourFreeNow(now)) {
    return '1. time gratis · gælder dagens første registrerede parkering · registrering er nødvendig.';
  }

  return '';
}

function normalizeFrederiksbergFeature(payload) {
  const raw = payload?.type === 'FeatureCollection' ? payload.features?.[0]
    : payload?.type === 'Feature' ? payload : null;
  if (!raw?.geometry) return null;
  return {
    type: 'Feature',
    geometry: raw.geometry,
    properties: {
      ...(raw.properties || {}),
      zonekode: 'FR',
      zonenavn: 'Frederiksberg',
      zonetype: 'Frederiksberg Kommune'
    }
  };
}

function pointToSegmentMeters(lat,lng,a,b){const kx=111320*Math.cos(lat*Math.PI/180),ky=110540,ax=(a[0]-lng)*kx,ay=(a[1]-lat)*ky,bx=(b[0]-lng)*kx,by=(b[1]-lat)*ky,dx=bx-ax,dy=by-ay,d=dx*dx+dy*dy,t=d?Math.max(0,Math.min(1,-(ax*dx+ay*dy)/d)):0;return Math.hypot(ax+t*dx,ay+t*dy);}
function geometryBoundaryDistanceMeters(g,lat,lng){if(!g)return Infinity;const ps=g.type==='Polygon'?[g.coordinates]:g.type==='MultiPolygon'?g.coordinates:[];let best=Infinity;for(const p of ps)for(const r of p)for(let i=1;i<r.length;i++)best=Math.min(best,pointToSegmentMeters(lat,lng,r[i-1],r[i]));return best;}
function boundaryWarning(lat,lng,accuracy,currentCode){let edge=Infinity,neighbor=null,nd=Infinity;for(const f of zoneFeatures){const c=featureCode(f);if(!c)continue;const d=geometryBoundaryDistanceMeters(f.geometry,lat,lng);if(c===currentCode)edge=Math.min(edge,d);else if(d<nd){nd=d;neighbor=f;}}const threshold=Math.max(50,Math.min(150,accuracy*2));if(!Number.isFinite(edge)||edge>threshold)return null;return{distance:Math.round(edge),neighbor,uncertain:accuracy>=Math.max(25,edge)};}

function styleForFeature(feature) {
  const selected = zoneSelect.value;
  const code = featureCode(feature);
  const timed = isTimedLicenseZone(code);
  const isSelected = selected && code === selected;
  const isGps = activeGpsZoneCode && code === activeGpsZoneCode;

  const isFrederiksberg = code === 'FR';
  const baseColor = isFrederiksberg ? '#52647a' : (timed ? '#c87912' : '#b52b72');
  const activeColor = isFrederiksberg ? '#34465d' : (timed ? '#a85f08' : '#a31963');
  const fillColor = isFrederiksberg ? '#7890aa' : (timed ? '#f4a62a' : '#d43a86');

  if (isGps) return {color:'#18864b',weight:4.5,opacity:1,fillColor:'#35a765',fillOpacity:0.16};
  if (isSelected) return {color:activeColor,weight:4,opacity:1,fillColor,fillOpacity:0.22};

  // Keep every other zone fully visible even when one zone is active.
  return {
    color: baseColor,
    weight: 2.25,
    opacity: 0.86,
    fillColor,
    fillOpacity: 0.055
  };
}


function drawTimeRestrictionLayer() {
  if (timeRestrictionLayer) map.removeLayer(timeRestrictionLayer);
  timeRestrictionLayer = null;

  if (!zonesToggle.checked || !timeRestrictionFeaturesOnMap.length) return;

  timeRestrictionLayer = L.geoJSON(
    { type: 'FeatureCollection', features: timeRestrictionFeaturesOnMap },
    {
      style: {
        color: '#e09a27',
        weight: 2.2,
        opacity: 0.82,
        dashArray: '7 6',
        fillColor: '#f6c453',
        fillOpacity: 0.035
      },
      onEachFeature(feature, layer) {
        const name = featureName(feature);
        layer.bindTooltip(
          `<strong>Tidsbegrænset parkering</strong>${name ? `<br>${name}` : ''}<br><span>Se skiltning for den konkrete regel</span>`,
          { sticky: true, direction: 'top', opacity: 0.96 }
        );
      }
    }
  ).addTo(map);

  if (timeRestrictionLayer.bringToBack) timeRestrictionLayer.bringToBack();
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


function closePinnedZoneTooltip() {
  if (!zoneLayer || !pinnedZoneCode) {
    pinnedZoneCode = '';
    return;
  }

  zoneLayer.eachLayer(layer => {
    if (featureCode(layer.feature) === pinnedZoneCode && layer.closeTooltip) {
      layer.closeTooltip();
    }
  });
  pinnedZoneCode = '';
}

function refreshZonePresentation() {
  if (!zoneLayer) return;

  zoneLayer.eachLayer(layer => {
    if (layer.setStyle) layer.setStyle(styleForFeature(layer.feature));
  });

  addZoneLabels();
}

function updateSelectedZoneStatus(code) {
  if (!code) {
    showParkingNoticePopup('', '');
    setMapStatus('Alle beboerlicenszoner vises på kortet.');
    return;
  }

  const option = zoneSelect.options[zoneSelect.selectedIndex];
  const rule = zoneParkingRule(code);
  showParkingNoticePopup(code, currentParkingNotice(code));
  const parkingNotice = currentParkingNotice(code);
    showParkingNoticePopup(code, parkingNotice);
  const base = `${option?.text || code}: ${rule.short}. ${rule.detail}`;
  setMapStatus(
    parkingNotice ? `${parkingNotice} ${base}` : base,
    parkingNotice || rule.timed ? 'warning' : 'success'
  );
}

function redrawZones() {
  if (zoneLayer) map.removeLayer(zoneLayer);
  if (timeRestrictionLayer) map.removeLayer(timeRestrictionLayer);
  if (labelLayer) map.removeLayer(labelLayer);
  zoneLayer = null;
  timeRestrictionLayer = null;
  labelLayer = null;

  if (!zonesToggle.checked || !zoneFeatures.length) return;

  drawTimeRestrictionLayer();

  zoneLayer = L.geoJSON({ type: 'FeatureCollection', features: zoneFeatures }, {
    style: styleForFeature,
    onEachFeature(feature, layer) {
      const code = featureCode(feature) || 'Ukendt zone';
      const name = featureName(feature);
      const rule = zoneParkingRule(code);
      layer.bindTooltip(
        `<strong>${name ? `${name} (${code})` : code}</strong><br>${rule.short}${rule.timed ? `<br><span>${compactRuleLabel(code)}</span>` : ''}`,
        {
          sticky: false,
          permanent: false,
          interactive: true,
          direction: 'top',
          opacity: 0.96
        }
      );

      layer.on('click', event => {
        const wasPinned = pinnedZoneCode === code;

        // Luk en eventuel tidligere fast infoboks uden at genopbygge kortlaget.
        closePinnedZoneTooltip();

        // Hold "Se zone" synkroniseret med det, brugeren trykker på.
        zoneSelect.value = code;
        syncZonePickerLabel();

        if (!wasPinned) {
          pinnedZoneCode = code;
          layer.openTooltip(event.latlng);
        }

        // Opdater kun styles/labels. Selve polygonlaget bliver stående urørt.
        refreshZonePresentation();
        updateSelectedZoneStatus(code);
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
  syncZonePickerLabel();

  // Manuelt valg i zonevælgeren lukker en evt. fast kort-infoboks.
  closePinnedZoneTooltip();
  refreshZonePresentation();
  updateSelectedZoneStatus(code);

  if (!code) {
    if (zoom && zoneLayer) map.fitBounds(zoneLayer.getBounds(), { padding: [18, 18], maxZoom: 13 });
    return;
  }

  const bounds = boundsForCode(code);
  if (zoom && bounds) map.fitBounds(bounds, { padding: [26, 26], maxZoom: 15 });
}

function updateZoneMessage(lat, lng, accuracy = currentAccuracy) {
  if (!zoneFeatures.length) {
    setLocationCopy('Din position er fundet', 'Zonedata indlæses stadig. Din zone vises automatisk, så snart data er klar.');
    return;
  }

  const zone = findZone(zoneFeatures, lat, lng);
  activeGpsZoneCode = zone ? featureCode(zone) : '';
  refreshZonePresentation();

  if (zone) {
    const code = activeGpsZoneCode || 'ukendt';
    const name = featureName(zone);
    const rule = zoneParkingRule(code);
    const safeAccuracy = Number.isFinite(accuracy) ? accuracy : 50;
    const edge = boundaryWarning(lat, lng, safeAccuracy, code);
    const parkingNotice = currentParkingNotice(code);
    setLocationCopy(
      name ? `${name} (${code})` : `${code}`,
      parkingNotice
        ? `${parkingNotice} ${rule.short}. ${rule.detail}`
        : `${rule.short}. ${rule.detail}`
    );

    if (edge) {
      const nc=edge.neighbor?featureCode(edge.neighbor):'', nn=edge.neighbor?featureName(edge.neighbor):'';
      const neighbor=nc?`${nn?`${nn} `:''}(${nc})`:'en anden zone';
      const edgeText = `${edge.uncertain?'GPS-positionen ligger tæt på en zonegrænse':'Tæt på zonegrænse'}: ca. ${edge.distance} m til ${neighbor}. GPS ± ${Math.round(safeAccuracy)} m. Tjek placering og skiltning.`;
      setMapStatus(parkingNotice ? `${parkingNotice} ${edgeText}` : edgeText, 'warning');
    } else {
      const zoneText = name ? `${name} (${code}): ${rule.short}.` : `${code}: ${rule.short}.`;
      setMapStatus(parkingNotice ? `${parkingNotice} ${zoneText}` : zoneText, parkingNotice || rule.timed ? 'warning' : 'success');
    }
  } else {
    showParkingNoticePopup('', '');
    setLocationCopy('Du er uden for en beboerzone', 'Din GPS-position ligger ikke i en registreret beboerlicenszone i kommunens datasæt.');
    setMapStatus('GPS-positionen ligger uden for de viste beboerlicenszoner.', 'neutral');
  }
}

function setUserPosition(position, recenter = true) {
  const { latitude, longitude, accuracy } = position.coords;
  currentPosition = [latitude, longitude];
  currentAccuracy = accuracy;
  accuracyText.textContent = `GPS ± ${Math.round(accuracy)} m`;
  accuracyText.dataset.state = accuracy <= 30 ? 'good' : accuracy <= 80 ? 'ok' : 'weak';
  locateBtn.disabled = false;
  locateBtn.textContent = 'Opdater GPS';

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
      color: '#ff7a00',
      fillColor: '#ff7a00',
      fillOpacity: 0.07
    }).addTo(map);
  } else {
    userMarker.setLatLng(currentPosition);
    accuracyCircle.setLatLng(currentPosition).setRadius(accuracy);
  }

  recenterBtn.disabled = false;
  if (recenter) map.setView(currentPosition, Math.max(map.getZoom(), 16), { animate: true });
  updateZoneMessage(latitude, longitude, accuracy);
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

  // Hvis vi allerede har en gyldig GPS-position, må en efterfølgende timeout/
  // midlertidig fejl ikke få appen til at påstå, at GPS ikke er tilgængelig.
  if (currentPosition) {
    locateBtn.textContent = 'Opdater GPS';
    setMapStatus('Din senest fundne GPS-position vises stadig på kortet.', 'neutral');
    console.warn('GPS update failed, keeping last valid position', {
      code: error?.code,
      message: error?.message
    });
    return;
  }

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
  locateBtn.textContent = 'Finder GPS…';
  accuracyText.textContent = 'GPS søger…';
  accuracyText.dataset.state = 'loading';

  try {
    const position = await getPositionRobustly();
    setUserPosition(position, true);
    locateBtn.disabled = false;
    locateBtn.textContent = 'Opdater GPS';
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
      const restrictions = timeRestrictionFeatures(payload);
      if (!features.length) throw new Error('Ingen beboerzoner i svaret');

      let frederiksbergFeature = null;
      try {
        const frPayload = await fetchJsonWithTimeout(FREDERIKSBERG_GEOJSON, 10000);
        frederiksbergFeature = normalizeFrederiksbergFeature(frPayload);
      } catch (frError) {
        console.warn('Frederiksberg kommunegrænse kunne ikke hentes:', frError);
      }

      zoneFeatures = frederiksbergFeature ? [...features, frederiksbergFeature] : features;
      timeRestrictionFeaturesOnMap = restrictions;
      populateZoneSelect(features);
      buildCompactZonePicker(zoneFeatures);
      setDataState('ready', `${uniqueZoneOptions(zoneFeatures).length} zoner klar`);
      redrawZones();

      if (fit && zoneLayer) map.fitBounds(zoneLayer.getBounds(), { padding: [12, 12], maxZoom: 12 });
      setMapStatus('Zonekortet er klar. Orange zoner er gratis, men tidsbegrænsede. Tjek altid skiltningen.', 'success');
      if (currentPosition) updateZoneMessage(...currentPosition, currentAccuracy);
      return true;
    } catch (error) {
      lastError = error;
      console.warn('Zone endpoint failed:', endpoint, error);
    }
  }

  console.error('Kunne ikke indlæse zoner:', lastError);
  zoneFeatures = [];
  timeRestrictionFeaturesOnMap = [];
  setDataState('error', 'Zonedata fejlede');
  setMapStatus('Kunne ikke hente kommunens zonedata. Tryk “Prøv zonedata igen”.', 'error');
  return false;
}


function openParkingApp(appUrl, fallbackUrl) {
  let leftPage = false;
  let fallbackTimer = null;

  const cancelFallback = () => {
    leftPage = true;
    if (fallbackTimer) clearTimeout(fallbackTimer);
  };

  const onVisibility = () => {
    if (document.hidden) cancelFallback();
  };

  document.addEventListener('visibilitychange', onVisibility, { once: true });
  window.addEventListener('pagehide', cancelFallback, { once: true });

  // Give iOS a moment to hand the custom URL scheme to the installed app.
  window.location.href = appUrl;

  fallbackTimer = setTimeout(() => {
    if (!leftPage && !document.hidden) {
      window.location.href = fallbackUrl;
    }
  }, 1200);
}

document.querySelectorAll('.payment-app-link').forEach(button => {
  button.addEventListener('click', () => {
    const appUrl = button.dataset.appUrl;
    const fallbackUrl = button.dataset.fallbackUrl;
    if (!appUrl || !fallbackUrl) return;
    openParkingApp(appUrl, fallbackUrl);
  });
});


map.on('tooltipopen', event => {
  const tooltip = event.tooltip;
  const source = tooltip?._source;
  if (!source?.feature) return;

  const code = featureCode(source.feature);
  const element = tooltip.getElement?.();
  if (!element || !code || pinnedZoneCode !== code) return;

  element.onclick = clickEvent => {
    clickEvent.stopPropagation();
    if (pinnedZoneCode !== code) return;
    source.closeTooltip();
    pinnedZoneCode = '';
    refreshZonePresentation();
  };
});

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
