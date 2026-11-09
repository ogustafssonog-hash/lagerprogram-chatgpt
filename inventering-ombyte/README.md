# Inventering: avrapporterade paket och ombyte på order

## Vad ändringen gör
När ett paket skannas vid inventering som är **avrapporterat på en order** (datumUt satt) men ändå står kvar,
klassas det inte längre som "Okänd". Skärmen visar i stället vilken order det sitter på
(t.ex. "Hyvelorder 123") och låter dig välja **vilket paket du plockade i stället**.
Ett klick på "Byt mot …" rättar allt i en transaktion:

- paket A (hittat) läggs tillbaka i lager och räknas som hittat
- paket B (det som plockades) avrapporteras med ordens datum och typ
- ordens paketrad byts från A till B (pris per m³ följer med)
- lagerhistorik skrivs för båda paketen
- B loggas som "Avrapporterat" bland omgångens saknade (granskningslogg, påverkar inga siffror)

Förslagen rankas på samma mått, om paketet saknas i facket, samma fack, profil, kvalitet och längd. Det går också att söka.
Sitter paketet inte på någon order finns i stället "Återinför i lager".

Övriga förbättringar på skanningssidan:
- "N kvar att hitta" är nu klickbar och visar listan över paket som ännu inte skannats i facket
- kort vibration på mobil vid avvikelse eller fel
- sökrutan märker avrapporterade paket med "Avrapporterat"

## Nya API-anrop (artifacts/api-server/src/routes/inventering.ts)
- `POST /api/inventering/:id/skanna` svarar nu `avrapporterad: true` (status 200, ingen skanning sparas) för avrapporterade paket
- `GET  /api/inventering/:id/byte-kandidater?pktNr=A`
- `POST /api/inventering/:id/byt-paket` `{ pktNr, ersattAvPktNr, metod }`
- `POST /api/inventering/:id/aterinfor-avrapporterat` `{ pktNr, metod }`
- `GET  /api/inventering/sok-paket` får fältet `avrapporterad`

Ingen databasändring behövs.

## Tester
Nytt: `inventeringAvrapporterat.test.ts` (4 tester). Ett gammalt test i `inventeringsomgangar.test.ts`
krävde att ett utlevererat paket skulle bli "okänd"; det är ändrat till nya beteendet. Körda mot lokal Postgres: 37/37 inventeringstester gröna.

## Så lägger du in det
Mappen `filer/` har de ändrade filerna med samma sökvägar som i projektet. Antingen kopiera dem rakt över, eller kör i projektroten:

    git apply inventering-ombyte/inventering-ombyte.patch

Patchen bygger på källkodskopian i den här repon (lagerprogram-chatgpt, snapshot 2026-09-16). Har du ändrat
`inventering.ts` eller `InventeringSkanningPage.tsx` sedan dess kan `git apply` kräva manuell sammanslagning.
