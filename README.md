# Min P-zone København

Mobilvenlig MVP, som:

- spørger om telefonens GPS-position
- viser positionen på OpenStreetMap
- henter Københavns Kommunes parkeringszonedata via Open Data DK
- finder den beboerlicenszone, GPS-punktet ligger i
- viser fx “Du er i VB-zonen”
- lader brugeren vise/skjule og fremhæve zonegrænser

## Kom online på Vercel

1. Opret en gratis konto på Vercel.
2. Læg denne mappe i et GitHub-repository (eller upload/importér projektet til Vercel).
3. Vælg **New Project** i Vercel og importér projektet.
4. Der kræves ingen environment variables og ingen database.
5. Deploy. Vercel giver automatisk en HTTPS-adresse, fx `dit-projekt.vercel.app`.
6. Åbn adressen på mobilen og tillad placering/GPS.

GPS i browseren kræver HTTPS i normal drift; det får du automatisk på Vercel.

## Data

Datasættet er “Parkeringszoner information” fra Københavns Kommune/Open Data DK. Appens serverless endpoint `/api/zones` videresender Open Data DK's CKAN Data API og cacher svaret. Det reducerer risikoen for browser-CORS-problemer.

Data API resource id:
`d362c209-38c8-4465-9a85-b31b31c2e7db`

## Vigtigt

Appen er vejledende. Københavns Kommune oplyser, at kort ikke nødvendigvis viser alle afvigelser, og at lokal skiltning/særlige forhold kan gælde. Brug derfor ikke MVP'en som garanti for, at parkering er lovlig på en konkret plads.
