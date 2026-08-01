const SOURCE = 'https://admin.opendata.dk/api/3/action/datastore_search?resource_id=d362c209-38c8-4465-9a85-b31b31c2e7db&limit=5000';

export default async function handler(req, res) {
  try {
    const response = await fetch(SOURCE, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Open Data DK svarede ${response.status}`);
    const data = await response.json();
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.status(200).json(data);
  } catch (error) {
    return res.status(502).json({ ok: false, error: 'Kunne ikke hente parkeringszoner', detail: String(error?.message || error) });
  }
}
