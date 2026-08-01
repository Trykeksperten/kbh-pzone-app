const WFS_URLS = [
  'https://wfs-kbhkort.kk.dk/k101/ows?outputFormat=application%2Fjson&request=GetFeature&service=WFS&srsname=EPSG%3A4326&typeName=k101%3Ap_zoner_kbh&version=1.0.0',
  'https://wfs-kbhkort.kk.dk/k101/wfs?outputFormat=application%2Fjson&request=GetFeature&service=WFS&srsname=EPSG%3A4326&typeName=k101%3Ap_zoner_kbh&version=1.0.0'
];

const LEGACY_DATA_API = 'https://admin.opendata.dk/api/3/action/datastore_search?resource_id=d362c209-38c8-4465-9a85-b31b31c2e7db&limit=5000';

async function fetchJson(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'kbh-pzone-app/2.0'
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function validGeoJson(payload) {
  return payload?.type === 'FeatureCollection' && Array.isArray(payload.features) && payload.features.length > 0;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Kun GET er understøttet' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=86400');

  const errors = [];
  for (const url of WFS_URLS) {
    try {
      const data = await fetchJson(url);
      if (!validGeoJson(data)) throw new Error('Ugyldigt GeoJSON-svar');
      return res.status(200).json({
        ok: true,
        source: 'Københavns Kommune WFS',
        fetchedAt: new Date().toISOString(),
        data
      });
    } catch (error) {
      errors.push(String(error?.message || error));
    }
  }

  // Compatibility fallback to Open Data DK's datastore endpoint.
  try {
    const data = await fetchJson(LEGACY_DATA_API);
    if (!Array.isArray(data?.result?.records) || !data.result.records.length) throw new Error('Tomt datastore-svar');
    return res.status(200).json({
      ok: true,
      source: 'Open Data DK datastore fallback',
      fetchedAt: new Date().toISOString(),
      data
    });
  } catch (error) {
    errors.push(String(error?.message || error));
  }

  return res.status(502).json({
    ok: false,
    error: 'Kunne ikke hente parkeringszoner fra de officielle datakilder',
    attempts: errors.length
  });
}
