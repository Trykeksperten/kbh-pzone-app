export function normalizeKey(key) {
  return String(key ?? '')
    .toLowerCase()
    .replaceAll('æ', 'ae')
    .replaceAll('ø', 'o')
    .replaceAll('å', 'a')
    .replace(/[^a-z0-9]/g, '');
}

export function firstProp(props, candidates) {
  const entries = Object.entries(props || {});
  for (const candidate of candidates) {
    const wanted = normalizeKey(candidate);
    const match = entries.find(([key]) => normalizeKey(key) === wanted);
    if (match && match[1] !== null && match[1] !== undefined && String(match[1]).trim() !== '') {
      return match[1];
    }
  }
  return '';
}

export function featureType(feature) {
  const props = feature?.properties || {};
  const explicit = firstProp(props, [
    'zonetype', 'zone_type', 'p_zonetype', 'pzonetype', 'type', 'kategori', 'category'
  ]);
  if (explicit) return String(explicit).trim();

  const value = Object.values(props).find(v => /beboerzone|adressebeboerzone|betalingszone|flexzone|prikgade|tidsrestriktion/i.test(String(v ?? '')));
  return value ? String(value).trim() : '';
}

export function featureCode(feature) {
  const props = feature?.properties || {};
  const explicit = firstProp(props, [
    'zonekode', 'zone_kode', 'p_zonekode', 'pzonekode', 'kode', 'licenszone', 'zonecode', 'zone', 'kortnavn'
  ]);
  if (explicit) {
    const value = String(explicit).trim().toUpperCase();
    if (/^[A-ZÆØÅ]{1,4}$/.test(value)) return value;
  }

  const candidates = Object.values(props)
    .map(v => String(v ?? '').trim().toUpperCase())
    .filter(v => /^[A-ZÆØÅ]{2,3}$/.test(v));
  return candidates[0] || '';
}

const RESIDENT_ZONE_NAMES = Object.freeze({
  AN: 'Amager Nord',
  CH: 'Christianshavn',
  IB: 'Indre By',
  IN: 'Indre Nørrebro',
  'IØ': 'Indre Østerbro',
  VA: 'Valby',
  VB: 'Vesterbro',
  YN: 'Ydre Nørrebro',
  'YØ': 'Ydre Østerbro',

  // Licenszoner i områder med tidsbegrænset parkering
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

export function featureName(feature) {
  const code = featureCode(feature);
  if (RESIDENT_ZONE_NAMES[code]) return RESIDENT_ZONE_NAMES[code];

  const props = feature?.properties || {};
  const explicit = firstProp(props, [
    'zonenavn', 'zone_navn', 'p_zonenavn', 'pzonenavn', 'navn', 'name', 'zonename', 'beskrivelse'
  ]);
  const name = explicit ? String(explicit).trim() : '';
  return name && name.toUpperCase() !== code ? name : '';
}

const OFFICIAL_LICENSE_ZONE_CODES = new Set(Object.keys(RESIDENT_ZONE_NAMES));

export function isResidentZone(feature) {
  const type = featureType(feature).toLowerCase();
  const code = featureCode(feature);

  // Adressebeboerzoner er tekniske delområder og skal ikke vises som selvstændige zoner.
  if (type.includes('adressebeboerzone') || type.includes('adresse')) return false;

  // Brug den officielle liste over licenszoner. Det inkluderer både de almindelige
  // beboerlicenszoner og licenszonerne i områder med tidsbegrænset parkering.
  return OFFICIAL_LICENSE_ZONE_CODES.has(code);
}

export function parseMaybeJSON(value) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!(s.startsWith('{') || s.startsWith('['))) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function parseWKT(wkt) {
  if (typeof wkt !== 'string') return null;
  let s = wkt.trim();
  s = s.replace(/^SRID=\d+;/i, '');
  const type = s.slice(0, s.indexOf('(')).trim().toUpperCase();
  if (!['POLYGON', 'MULTIPOLYGON'].includes(type)) return null;

  const body = s.slice(s.indexOf('('));
  let i = 0;
  const skip = () => { while (/\s/.test(body[i] || '')) i += 1; };
  const parseNumber = () => {
    skip();
    const match = body.slice(i).match(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
    if (!match) throw new Error('Invalid number');
    i += match[0].length;
    return Number(match[0]);
  };
  const parsePair = () => {
    const x = parseNumber();
    const y = parseNumber();
    return [x, y];
  };
  const parseGroup = () => {
    skip();
    if (body[i] !== '(') throw new Error('Expected (');
    i += 1;
    const items = [];
    while (i < body.length) {
      skip();
      items.push(body[i] === '(' ? parseGroup() : parsePair());
      skip();
      if (body[i] === ',') { i += 1; continue; }
      if (body[i] === ')') { i += 1; break; }
      throw new Error('Expected separator');
    }
    return items;
  };

  try {
    const coordinates = parseGroup();
    return { type: type === 'POLYGON' ? 'Polygon' : 'MultiPolygon', coordinates };
  } catch {
    return null;
  }
}

export function geometryFromRecord(record) {
  for (const [key, raw] of Object.entries(record || {})) {
    if (!/(geo|geom|shape|wkt)/.test(normalizeKey(key))) continue;
    const parsed = parseMaybeJSON(raw);
    if (parsed?.type === 'Feature') return parsed.geometry;
    if (parsed?.type && parsed?.coordinates) return parsed;
    const wkt = parseWKT(raw);
    if (wkt) return wkt;
  }
  return null;
}

export function recordsToFeatures(payload) {
  const unwrapped = payload?.data || payload;
  if (unwrapped?.type === 'FeatureCollection') return unwrapped.features || [];
  if (Array.isArray(unwrapped?.features)) return unwrapped.features;
  const records = unwrapped?.result?.records || unwrapped?.records || [];
  return records.map(record => {
    const geometry = geometryFromRecord(record);
    return geometry ? { type: 'Feature', properties: record, geometry } : null;
  }).filter(Boolean);
}

export function residentFeatures(payload) {
  return recordsToFeatures(payload)
    .filter(feature => feature?.geometry && ['Polygon', 'MultiPolygon'].includes(feature.geometry.type))
    .filter(isResidentZone);
}

export function timeRestrictionFeatures(payload) {
  return recordsToFeatures(payload)
    .filter(feature => feature?.geometry && ['Polygon', 'MultiPolygon'].includes(feature.geometry.type))
    .filter(feature => featureType(feature).toLowerCase().includes('tidsrestriktion'));
}

function ringContains([lng, lat], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = ((yi > lat) !== (yj > lat)) &&
      (lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (crosses) inside = !inside;
  }
  return inside;
}

function polygonContains(point, polygon) {
  if (!polygon?.length || !ringContains(point, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i += 1) {
    if (ringContains(point, polygon[i])) return false;
  }
  return true;
}

export function geometryContains(point, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return polygonContains(point, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(poly => polygonContains(point, poly));
  return false;
}

export function findZone(features, lat, lng) {
  const point = [lng, lat];
  return (features || []).find(feature => geometryContains(point, feature.geometry)) || null;
}
