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
const PAYMENT_WFS = 'https://wfs-kbhkort.kk.dk/k101/ows?outputFormat=application%2Fjson&request=GetFeature&service=WFS&srsname=EPSG%3A4326&typeName=k101%3Abetalingszone&version=1.0.0';
const COPENHAGEN_CENTER = [55.6761, 12.5683];
const FREDERIKSBERG_GEOJSON = 'https://api.dataforsyningen.dk/kommuner/0147?format=geojson';


const PAYMENT_TARIFFS_2026 = Object.freeze({
  red:    { da: 'Rød',   color: '#d92d20', day: 45, evening: 18, night: 6 },
  green:  { da: 'Grøn',  color: '#299764', day: 45, evening: 18, night: 6 },
  blue:   { da: 'Blå',   color: '#2878c8', day: 26, evening: 18, night: 6 },
  yellow: { da: 'Gul',   color: '#d7a900', day: 17, evening: 18, night: 6 }
});

function paymentZoneKey(feature) {
  const values = Object.entries(feature?.properties || {}).map(([key, value]) => ({
    key: String(key ?? '').toLowerCase(),
    value: String(value ?? '').toLowerCase()
  }));
  const text = values.map(item => `${item.key} ${item.value}`).join(' ');

  // Direct colour/name matching.
  if (/\brød\b|\broed\b|\bred\b|rød zone|roed zone|red zone/.test(text)) return 'red';
  if (/\bgrøn\b|\bgroen\b|\bgreen\b|grøn zone|groen zone|green zone/.test(text)) return 'green';
  if (/\bblå\b|\bblaa\b|\bbla\b|\bblue\b|blå zone|blaa zone|blue zone|blã¥/.test(text)) return 'blue';
  if (/\bgul\b|\byellow\b|gul zone|yellow zone/.test(text)) return 'yellow';

  // Some GIS records expose the tariff rather than a colour name.
  // 26 kr/t uniquely identifies the blue daytime zone; 17 identifies yellow.
  const numericValues = values
    .map(item => Number(String(item.value).replace(',', '.')))
    .filter(Number.isFinite);

  if (numericValues.includes(26)) return 'blue';
  if (numericValues.includes(17)) return 'yellow';

  // Common descriptive aliases sometimes used in parking/GIS datasets.
  if (/mellemzone|mellem zone|medium zone/.test(text)) return 'blue';
  if (/yderzone|ydre zone|outer zone/.test(text)) return 'yellow';

  return '';
}

function currentTariffPeriod(now = new Date()) {
  const h = now.getHours();
  if (h >= 8 && h < 18) return 'day';
  if (h >= 18 && h < 23) return 'evening';
  return 'night';
}

function paymentTariffText(key, now = new Date()) {
  const tariff = PAYMENT_TARIFFS_2026[key];
  if (!tariff) return '';
  const period = currentTariffPeriod(now);
  const label = period === 'day' ? 'kl. 08–18' : period === 'evening' ? 'kl. 18–23' : 'kl. 23–08';
  return `${tariff.da} betalingszone · ${tariff[period]} kr./t nu (${label})`;
}


function tariffKeyAtLatLng(latlng) {
  if (!latlng || !paymentZoneFeatures.length) return '';
  const feature = paymentZoneFeatures.find(payment =>
    payment?.geometry && pointInGeometry(latlng.lng, latlng.lat, payment.geometry)
  );
  return feature ? paymentZoneKey(feature) : '';
}


function ensureCompactTooltipStyle() {
  if (document.getElementById('compactTooltipStyle')) return;
  const style = document.createElement('style');
  style.id = 'compactTooltipStyle';
  style.textContent = `
    .leaflet-tooltip {
      max-width: 245px !important;
      white-space: normal !important;
      line-height: 1.28 !important;
      font-size: 10.5px !important;
      overflow: visible !important;
      padding: 7px 9px !important;
    }
    .leaflet-tooltip strong {
      font-size: 11px;
    }
  `;
  document.head.appendChild(style);
}
ensureCompactTooltipStyle();

function timedZoneTooltipHtml(code, name) {
  const rule = TIME_LIMIT_RULES[code];
  const title = name ? `${name} (${code})` : code;

  if (!rule) {
    return [
      `<strong>${title}</strong>`,
      `<strong>Gratis · tidsbegrænset</strong>`,
      `<span>Tjek skiltningen</span>`
    ].join('<br>');
  }

  const hoursText = rule.hours === 1 ? '1 time' : `${rule.hours} timer`;
  const timeText = `${rule.days || 'hverdage'}${rule.window ? ` · ${rule.window}` : ''}`;

  const endTime = rule.window && rule.window.includes('–')
    ? rule.window.split('–').pop().trim()
    : '';

  return [
    `<strong>${title}</strong>`,
    `<strong>Gratis · maks. ${hoursText}</strong>`,
    `<span>${timeText}</span>`,
    `<span>Efter ${hoursText}: bilen skal flyttes</span>`,
    endTime ? `<strong>Efter kl. ${endTime}: gratis uden tidsbegrænsning</strong>` : '',
    `<span>Kan ikke forlænges mod betaling · tjek skiltning</span>`
  ].filter(Boolean).join('<br>');
}

function tariffScheduleHtml(key) {
  const tariff = PAYMENT_TARIFFS_2026[key];
  if (!tariff) return '';
  return [
    `<strong>${tariff.da} betalingszone</strong>`,
    `08–18: <strong>${tariff.day} kr./t</strong>`,
    `18–23: <strong>${tariff.evening} kr./t</strong>`,
    `23–08: <strong>${tariff.night} kr./t</strong>`
  ].join('<br>');
}

function featureCenterLatLng(feature) {
  try {
    const layer = L.geoJSON(feature);
    const bounds = layer.getBounds();
    return bounds.isValid() ? bounds.getCenter() : null;
  } catch {
    return null;
  }
}

function tariffKeyForResidentFeature(feature) {
  const center = featureCenterLatLng(feature);
  if (!center) return '';
  const paymentFeature = paymentZoneFeatures.find(payment =>
    payment?.geometry && pointInGeometry(center.lng, center.lat, payment.geometry)
  );
  return paymentFeature ? paymentZoneKey(paymentFeature) : '';
}




const OFFICIAL_LICENSE_ZONES = Object.freeze({
  AN: 'Amager Nord',
  CH: 'Christianshavn',
  IB: 'Indre By',
  IN: 'Indre Nørrebro',
  'IØ': 'Indre Østerbro',
  VA: 'Valby',
  VB: 'Vesterbro',
  YN: 'Ydre Nørrebro',
  'YØ': 'Ydre Østerbro',
  GJ: 'Grønjord',
  HS: 'Hellerup Station',
  VL: 'Vanløse Station',
  NV: 'Nordvest',
  VS: 'Valby Syd',
  HA: 'Havnestad',
  LP: 'Lergravsparken',
  AS: 'Amager Strand',
  SV: 'Sundbyvester',
  'SØ': 'Sundbyøster',
  GD: 'Grøndal',
  'ÅH': 'Ålholm',
  BB: 'Bispebjerg',
  KE: 'Kongens Enghave',
  VI: 'Vigerslev Allé',
  RP: 'Ryparken',
  SJ: 'Strandvejen',
  HK: 'Den Hvide Kødby'
});

const EXPECTED_LICENSE_CODES = Object.freeze(Object.keys(OFFICIAL_LICENSE_ZONES));

function normalizeZoneText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replaceAll('æ', 'ae')
    .replaceAll('ø', 'o')
    .replaceAll('å', 'a')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function inferOfficialZoneCode(feature) {
  const props = feature?.properties || {};
  const entries = Object.entries(props);
  const relevant = entries.filter(([key]) =>
    /zone|kode|code|navn|name|licens|beboer|park/i.test(String(key))
  );
  const candidates = relevant.length ? relevant : entries;

  for (const [, raw] of candidates) {
    const value = String(raw ?? '').trim().toUpperCase();
    if (EXPECTED_LICENSE_CODES.includes(value)) return value;

    for (const code of EXPECTED_LICENSE_CODES) {
      const escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const token = new RegExp(`(^|[^A-ZÆØÅ])${escaped}([^A-ZÆØÅ]|$)`, 'u');
      if (token.test(value)) return code;
    }
  }

  const joined = normalizeZoneText(candidates.map(([, value]) => value).join(' '));
  for (const [code, name] of Object.entries(OFFICIAL_LICENSE_ZONES)) {
    const normalizedName = normalizeZoneText(name);
    if (normalizedName && joined.includes(normalizedName)) return code;
  }

  return '';
}

function normalizeOfficialFeatureCollection(payload) {
  if (!payload || !Array.isArray(payload.features)) return payload;

  return {
    ...payload,
    features: payload.features.map(feature => {
      if (!feature?.geometry) return feature;
      const code = inferOfficialZoneCode(feature);
      if (!code) return feature;

      return {
        ...feature,
        properties: {
          ...(feature.properties || {}),
          zonekode: code,
          zonenavn: OFFICIAL_LICENSE_ZONES[code]
        }
      };
    })
  };
}

function mergeUniqueFeatures(featureGroups) {
  const seen = new Set();
  const merged = [];

  for (const features of featureGroups) {
    for (const feature of features || []) {
      if (!feature?.geometry) continue;
      const code = featureCode(feature) || inferOfficialZoneCode(feature);
      const key = `${code}|${JSON.stringify(feature.geometry)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(feature);
    }
  }
  return merged;
}

function missingOfficialZoneCodes(features) {
  const found = new Set((features || []).map(feature => featureCode(feature)).filter(Boolean));
  return EXPECTED_LICENSE_CODES.filter(code => !found.has(code));
}

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
let paymentZoneFeatures = [];
let paymentZoneLayer = null;
let activeLicenseZoneLayer = null;
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
  const publicHolidays = [
    new Date(y, 0, 1),
    addDays(easter, -3),
    addDays(easter, -2),
    easter,
    addDays(easter, 1),
    addDays(easter, 39),
    addDays(easter, 49),
    addDays(easter, 50),
    new Date(y, 11, 25),
    new Date(y, 11, 26)
  ];

  return publicHolidays.some(d => dateKey(d) === dateKey(now));
}

function isCopenhagenFirstHourFreeNow(now = new Date()) {
  const day = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();

  // Official weekend rule: Saturday 17:00 through Monday 08:00.
  if (day === 6 && minutes >= 17 * 60) return true;
  if (day === 0) return true;
  if (day === 1 && minutes < 8 * 60) return true;

  const y = now.getFullYear();
  const easter = easterSunday(y);
  const publicHolidays = [
    new Date(y, 0, 1),       // Nytårsdag
    addDays(easter, -3),     // Skærtorsdag
    addDays(easter, -2),     // Langfredag
    easter,                  // Påskedag
    addDays(easter, 1),      // 2. påskedag
    addDays(easter, 39),     // Kristi Himmelfartsdag
    addDays(easter, 49),     // Pinsedag
    addDays(easter, 50),     // 2. pinsedag
    new Date(y, 11, 25),     // Juledag
    new Date(y, 11, 26)      // 2. juledag
  ];

  return publicHolidays.some(d => dateKey(d) === dateKey(now));
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
  const isSelected = Boolean(selected && code === selected);
  const isGps = Boolean(activeGpsZoneCode && code === activeGpsZoneCode);
  const isFrederiksberg = code === 'FR';

  // The official tariff layer is the primary visual language for paid Copenhagen areas.
  // Resident-zone geometry must therefore not cover it with magenta outlines/fills.
  if (isGps) {
    return {
      color: '#667085',
      weight: 0.8,
      opacity: 0.18,
      fillOpacity: 0
    };
  }

  if (isSelected) {
    return {
      color: '#ffffff',
      weight: 2.5,
      opacity: 0.82,
      fillOpacity: 0
    };
  }

  if (timed) {
    return {
      color: '#c87912',
      weight: 2.1,
      opacity: 0.88,
      fillColor: '#f4a62a',
      fillOpacity: 0.055
    };
  }

  if (isFrederiksberg) {
    return {
      color: '#667085',
      weight: 1.5,
      opacity: 0.6,
      fillColor: '#7890aa',
      fillOpacity: 0.035
    };
  }

  // Paid Copenhagen resident zones: very subtle neutral boundary only.
  return {
    color: '#667085',
    weight: 0.45,
    opacity: 0.09,
    fillOpacity: 0
  };
}


function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInGeometry(lng, lat, geometry) {
  if (!geometry) return false;
  const inPolygon = polygon => {
    if (!polygon?.length || !pointInRing(lng, lat, polygon[0])) return false;
    for (let i = 1; i < polygon.length; i++) {
      if (pointInRing(lng, lat, polygon[i])) return false;
    }
    return true;
  };
  if (geometry.type === 'Polygon') return inPolygon(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(inPolygon);
  return false;
}


function highlightCurrentLicenseZone(lat, lng) {
  if (activeLicenseZoneLayer) {
    map.removeLayer(activeLicenseZoneLayer);
    activeLicenseZoneLayer = null;
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !zoneFeatures.length) return;

  const licenseFeature = findZone(zoneFeatures, lat, lng);
  if (!licenseFeature) return;

  // Find the tariff colour at the GPS position.
  const paymentFeature = paymentZoneFeatures.find(feature =>
    feature?.geometry && pointInGeometry(lng, lat, feature.geometry)
  );
  const tariffKey = paymentFeature ? paymentZoneKey(paymentFeature) : '';
  const tariff = PAYMENT_TARIFFS_2026[tariffKey];

  // Use the same visual language as the tariff zone, but ONLY on the current licence zone.
  const color = tariff?.color || '#667085';

  activeLicenseZoneLayer = L.geoJSON(licenseFeature, {
    interactive: false,
    style: {
      color,
      weight: 3.6,
      opacity: 1,
      fillColor: color,
      fillOpacity: 0.22
    }
  }).addTo(map);

  activeLicenseZoneLayer.bringToFront?.();
}

function drawPaymentZoneLayer() {
  if (paymentZoneLayer) map.removeLayer(paymentZoneLayer);
  paymentZoneLayer = null;
  if (!paymentZoneFeatures.length) return;

  paymentZoneLayer = L.geoJSON(
    { type: 'FeatureCollection', features: paymentZoneFeatures },
    {
      style(feature) {
        const key = paymentZoneKey(feature);
        const tariff = PAYMENT_TARIFFS_2026[key];
        const color = tariff?.color || '#667085';
        return {
          color,
          weight: 2.5,
          opacity: 0.9,
          fillColor: color,
          fillOpacity: 0.16
        };
      },
      onEachFeature(feature, layer) {
        const key = paymentZoneKey(feature);
        if (!key) return;
        const tariff = PAYMENT_TARIFFS_2026[key];
        layer.bindTooltip(
          tariffScheduleHtml(key),
          { sticky: true, direction: 'top', opacity: 0.97 }
        );
      }
    }
  ).addTo(map);

  if (paymentZoneLayer.bringToBack) paymentZoneLayer.bringToBack();
}

function ensureTariffLegend() {
  const mapStage = document.querySelector('.map-stage');
  if (!mapStage || document.getElementById('tariffLegend')) return;

  const legend = document.createElement('div');
  legend.id = 'tariffLegend';
  legend.style.cssText = [
    'position:absolute',
    'z-index:520',
    'top:8px',
    'left:74px',
    'display:flex',
    'align-items:center',
    'gap:7px',
    'padding:5px 8px',
    'border:1px solid rgba(208,213,221,.88)',
    'border-radius:999px',
    'background:rgba(255,255,255,.96)',
    'box-shadow:0 4px 12px rgba(16,24,40,.08)',
    'font-size:9px',
    'font-weight:800',
    'color:#344054',
    'pointer-events:none',
    'white-space:nowrap'
  ].join(';');

  for (const key of ['red', 'green', 'blue', 'yellow']) {
    const t = PAYMENT_TARIFFS_2026[key];
    const item = document.createElement('span');
    item.style.cssText = 'display:inline-flex;align-items:center;gap:3px';
    item.innerHTML = `<i style="width:7px;height:7px;border-radius:50%;background:${t.color};display:inline-block"></i>${t.day}`;
    legend.appendChild(item);
  }

  mapStage.appendChild(legend);
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
        html: `<span class="zone-label${isSelected || isGps ? ' is-active' : ''}"${isSelected || isGps ? ' style="background:#ffffff;color:#1f2937;border-color:#1f2937;box-shadow:0 3px 10px rgba(16,24,40,.14)"' : ''}>${code}</span>`,         iconSize: [48, 28],
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
  const parkingNotice = currentParkingNotice(code);
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

  drawPaymentZoneLayer();
  drawTimeRestrictionLayer();

  zoneLayer = L.geoJSON({ type: 'FeatureCollection', features: zoneFeatures }, {
    style: styleForFeature,
    onEachFeature(feature, layer) {
      const code = featureCode(feature) || 'Ukendt zone';
      const name = featureName(feature);
      const rule = zoneParkingRule(code);
      const initialTooltipHtml = rule.timed
        ? timedZoneTooltipHtml(code, name)
        : `<strong>${name ? `${name} (${code})` : code}</strong><br>${rule.short}`;

      layer.bindTooltip(
        initialTooltipHtml,
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

        closePinnedZoneTooltip();

        zoneSelect.value = code;
        syncZonePickerLabel();

        if (!wasPinned) {
          let html;

          if (rule.timed) {
            html = timedZoneTooltipHtml(code, name);
          } else if (code === 'FR') {
            html = `<strong>Frederiksberg</strong><br>${zoneParkingRule('FR').detail}`;
          } else {
            const exactTariffKey = tariffKeyAtLatLng(event.latlng);
            html = exactTariffKey
              ? `<strong>${name ? `${name} (${code})` : code}</strong><br>${tariffScheduleHtml(exactTariffKey)}`
              : `<strong>${name ? `${name} (${code})` : code}</strong><br>${rule.short}<br><span>Priszone kunne ikke bestemmes på dette punkt. Tjek skiltningen.</span>`;
          }

          layer.setTooltipContent(html);
          pinnedZoneCode = code;
          layer.openTooltip(event.latlng);
        }

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
  highlightCurrentLicenseZone(latitude, longitude);
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
  setMapStatus('Henter de officielle licenszoner…');

  try {
    const zoneResults = await Promise.allSettled([
      fetchJsonWithTimeout(DATA_API, 12000),
      fetchJsonWithTimeout(DIRECT_WFS, 16000)
    ]);

    const residentGroups = [];
    const restrictionGroups = [];

    zoneResults.forEach((result, index) => {
      if (result.status !== 'fulfilled') {
        console.warn('Zonedatakilde fejlede:', index === 0 ? DATA_API : DIRECT_WFS, result.reason);
        return;
      }

      const normalizedPayload = normalizeOfficialFeatureCollection(result.value);
      residentGroups.push(residentFeatures(normalizedPayload));
      restrictionGroups.push(timeRestrictionFeatures(normalizedPayload));
    });

    const features = mergeUniqueFeatures(residentGroups);
    const restrictions = mergeUniqueFeatures(restrictionGroups);

    if (!features.length) {
      throw new Error('Ingen licenszoner kunne hentes fra de officielle datakilder');
    }

    try {
      const paymentPayload = await fetchJsonWithTimeout(PAYMENT_WFS, 12000);
      paymentZoneFeatures = (paymentPayload?.features || []).filter(feature =>
        feature?.geometry &&
        ['Polygon', 'MultiPolygon'].includes(feature.geometry.type) &&
        paymentZoneKey(feature)
      );
    } catch (paymentError) {
      paymentZoneFeatures = [];
      console.warn('Betalingszoner kunne ikke hentes:', paymentError);
    }

    let frederiksbergFeature = null;
    try {
      const frPayload = await fetchJsonWithTimeout(FREDERIKSBERG_GEOJSON, 10000);
      frederiksbergFeature = normalizeFrederiksbergFeature(frPayload);
    } catch (frError) {
      console.warn('Frederiksberg kommunegrænse kunne ikke hentes:', frError);
    }

    zoneFeatures = frederiksbergFeature ? [...features, frederiksbergFeature] : features;
    timeRestrictionFeaturesOnMap = restrictions;

    const missing = missingOfficialZoneCodes(features);
    if (missing.length) {
      console.warn('Officielle licenszoner mangler i kommunens aktuelle datasvar:', missing);
    }

    populateZoneSelect(zoneFeatures);
    buildCompactZonePicker(zoneFeatures);
    setDataState('ready', `${uniqueZoneOptions(zoneFeatures).length} zoner klar`);

    redrawZones();
    ensureTariffLegend();

    if (currentPosition) {
      highlightCurrentLicenseZone(currentPosition[0], currentPosition[1]);
    }

    if (fit && zoneLayer) {
      map.fitBounds(zoneLayer.getBounds(), { padding: [12, 12], maxZoom: 12 });
    }

    if (missing.length) {
      setMapStatus(
        `Zonekortet er indlæst, men kommunens datasvar mangler: ${missing.join(', ')}. Kortet viser kun verificerede geometrier.`,
        'warning'
      );
    } else {
      setMapStatus(
        'Alle officielle københavnske licenszoner er indlæst. Orange zoner er gratis, men tidsbegrænsede. Tjek altid skiltningen.',
        'success'
      );
    }

    if (currentPosition) {
      updateZoneMessage(...currentPosition, currentAccuracy);
    }

    return true;
  } catch (error) {
    console.error('Kunne ikke indlæse zoner:', error);
    zoneFeatures = [];
    timeRestrictionFeaturesOnMap = [];
    setDataState('error', 'Zonedata fejlede');
    setMapStatus('Kunne ikke hente kommunens zonedata. Tryk “Prøv zonedata igen”.', 'error');
    return false;
  }
} = {}) {
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

      try {
        const paymentPayload = await fetchJsonWithTimeout(PAYMENT_WFS, 12000);
        paymentZoneFeatures = (paymentPayload?.features || []).filter(feature =>
          feature?.geometry &&
          ['Polygon', 'MultiPolygon'].includes(feature.geometry.type) &&
          paymentZoneKey(feature)
        );
      } catch (paymentError) {
        paymentZoneFeatures = [];
        console.warn('Betalingszoner kunne ikke hentes:', paymentError);
      }

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
      ensureTariffLegend();
      if (currentPosition) {
        highlightCurrentLicenseZone(currentPosition[0], currentPosition[1]);
      }

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



function updatePaymentMenuInfo() {
  const menu = document.querySelector('.payment-apps-menu');
  if (!menu) return;

  let info = document.getElementById('paymentRuleInfo');
  if (!info) {
    info = document.createElement('div');
    info.id = 'paymentRuleInfo';
    info.style.cssText = 'margin:2px 3px 5px;padding:8px 8px;border-radius:9px;background:#f4f7f5;color:#344054;font-size:9.5px;line-height:1.35;border:1px solid #e1e8e4;';
    menu.prepend(info);
  }

  const code = activeGpsZoneCode || zoneSelect.value || '';
  if (!code) {
    info.innerHTML = '<strong style="display:block;margin-bottom:2px">Parkeringsinfo</strong>Find din position eller vælg en zone for at se de aktuelle regler.';
    return;
  }

  const name = uniqueZoneOptions(zoneFeatures).find(z => z.code === code)?.name || code;
  const notice = currentParkingNotice(code);
  const rule = zoneParkingRule(code);

  let headline = `${name}${code === 'FR' ? '' : ` (${code})`}`;
  let text = notice || `${rule.short}. ${rule.detail}`;

  if (!notice && code !== 'FR' && currentPosition) {
    const paymentFeature = paymentZoneFeatures.find(feature =>
      feature?.geometry && pointInGeometry(currentPosition[1], currentPosition[0], feature.geometry)
    );
    const tariffKey = paymentFeature ? paymentZoneKey(paymentFeature) : '';
    const tariffText = tariffKey ? paymentTariffText(tariffKey) : '';
    if (tariffText) text = `${tariffText}. ${rule.short}.`;
  }

  info.innerHTML = `<strong style="display:block;margin-bottom:2px;color:#1d2939">${headline}</strong>${text}`;
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


const paymentDetails = document.querySelector('.payment-apps');
if (paymentDetails) {
  paymentDetails.addEventListener('toggle', () => {
    if (paymentDetails.open) updatePaymentMenuInfo();
  });
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
