# Min P-zone København

Mobilvenlig webapp, der viser Københavns beboerlicenszoner og kan finde brugerens zone via GPS.

## Funktioner

- viser beboerlicenszonerne som polygoner og tydelige zonekoder direkte på kortet
- zonevælger virker uden GPS og zoomer til den valgte zone
- GPS er valgfri og kan aldrig blokere kort/zonevælger
- viser GPS-position og nøjagtighed
- automatisk point-in-polygon bestemmelse af zone
- robust dataload med serverless proxy, officiel WFS-kilde, fallback, timeout og retry
- fejlbeskeder for afvist GPS, timeout, manglende HTTPS, offline-status og datakildefejl
- mobilvenligt design og Vercel-konfiguration

## Datakilde

Københavns Kommunes officielle WFS-lag `k101:p_zoner_kbh` via:

`https://wfs-kbhkort.kk.dk/k101/ows?...`

Appens `/api/zones` proxyer data og cacher dem på Vercel. Som kompatibilitetsfallback anvendes Open Data DK's datastore resource `d362c209-38c8-4465-9a85-b31b31c2e7db`.

## Deploy

Repository'et kan importeres direkte i Vercel med Application Preset `Other`. Ingen environment variables er nødvendige.

## Vigtigt

Appen er vejledende. Kommunens kort/data kan have lokale undtagelser; skiltning og afmærkning på stedet er altid afgørende.
