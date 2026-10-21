# PULSE

PULSE är en gratis social kartapp där du kan se var dina vänner är, men bara när de själva har valt att dela sin position.

> Status: etapp 5 (platsdelning). Appen är en webbapp (PWA) som kan installeras på hemskärmen.
>
> - Fungerar på riktigt: kartan (OpenStreetMap-data via OpenFreeMap), knappen "min position" (mobilens GPS), navigering, installation på hemskärmen, konton, profil, vänner (vänkod, förfrågningar, blockering) och platsdelning med utvalda vänner (pausa, osynligt läge, live/inaktuell med tid) när Supabase är inställt i `config.js`.
> - Ingen testdata längre: personerna på kartan är dina riktiga vänner som delar sin position med dig.

## Filer

| Fil | Vad den gör |
|---|---|
| `index.html` | Själva sidan: logga, karta, vänlista, profil och bottenmeny |
| `style.css` | Utseendet (mörkt tema, färger, layout) |
| `app.js` | Logiken: byta vy, karta, vänner på kartan, hämta din position |
| `account.js` | Konton och profil (Supabase) |
| `friends.js` | Vänner: vänkod, förfrågningar, blockering (Supabase) |
| `location.js` | Platsdelning: vem får se dig, skicka position, pausa, osynligt läge, vännernas positioner (Supabase) |
| `config.js` | Supabase-adress och publik nyckel. Bara offentliga värden, aldrig secret/service_role |
| `supabase/etapp3-profiler.sql` | Databasen för profiler med Row Level Security. Körs en gång i Supabase SQL Editor |
| `supabase/etapp4-vanner.sql` | Vänkoder, förfrågningar, vänskaper och blockeringar. Körs en gång efter etapp 3-filen |
| `supabase/etapp5-platsdelning.sql` | Platsdelning med behörighetskontroll. Körs en gång efter etapp 4-filen |
| `manifest.json` | Gör att appen kan installeras på hemskärmen |
| `sw.js` | Service worker som gör appen installerbar och laddar om senaste versionen |
| `icons/` | Appikoner |
| `vendor/maplibre-gl/` | Kartbiblioteket MapLibre GL JS 5.24.0 (BSD-3-licens, se `LICENSE.txt`). Ändra inte de här filerna. |
| `vendor/supabase/` | Supabase JS 2.117.3 (MIT-licens, se `LICENSE.txt`). Ändra inte de här filerna. |

## Vad appen ska kunna

1. Visa din egen position på en karta.
2. Lägga till vänner med en unik användarkod.
3. Dela din position med utvalda vänner.
4. Visa vänners positioner när de aktivt delar dem.
5. Pausa platsdelning eller slå på osynligt läge.
6. Sätta enkla statusar, till exempel "Ute", "Hemma" och "Vill hitta på något".
7. Skapa en aktivitet som vänner kan ansluta till.

Kärnfunktionerna ska alltid vara gratis.

## Integritet först

- Ingen position delas offentligt, och delning är avstängd som standard.
- Bara godkända vänner kan se din position.
- Du kan när som helst pausa delningen eller bli osynlig.
- Gamla positioner visas aldrig som om de vore live.
- Ingen onödig platshistorik sparas.

## Plan

| Etapp | Innehåll |
|---|---|
| 1 | Första prototypen: logotyp, kartvy, navigation och vänlista med testdata |
| 2 | Riktig karta med gratis kartdata |
| 3 | Användarkonton: registrering, inloggning och profiler |
| 4 | Vänner: koder, förfrågningar, blockering |
| 5 | Säker platsdelning mellan godkända vänner |
| 6 | Statusar och aktiviteter |
| 7 | Testning |
| 8 | Publicering |

## Teknik

Projektet byggs helt från mobilen och med 0 kr i budget.

- Webbapp (PWA) i ren HTML, CSS och JavaScript, publicerad gratis med GitHub Pages.
- Karta: [MapLibre GL JS](https://maplibre.org/) ritar kartan och [OpenFreeMap](https://openfreemap.org/) levererar kartdata från OpenStreetMap. OpenFreeMap är gratis, kräver inget konto eller API-nyckel och tillåter kommersiell användning. Källhänvisningen nere till vänster på kartan krävs och får inte tas bort.
- Konton: [Supabase](https://supabase.com/) Free. Gratis utan kort, men projektet pausas efter en veckas inaktivitet (starta det igen i Supabase) och den inbyggda e-posten kan bara skicka 2 mejl i timmen.

## Vad som sparas (etapp 3)

- I Supabase Auth: e-post, krypterat lösenord och inloggningstider.
- I tabellen `profiles`: visningsnamn, valfritt användarnamn, avatarfärg och när profilen skapades/ändrades.
- Ingen position sparas. Varje användare kan bara läsa och ändra sin egen profil (Row Level Security), och kan radera sitt konto själv.

## Vad som sparas (etapp 4)

- `profiles.friend_code`: din vänkod (8 tecken, slumpad, går att byta).
- `friend_requests`, `friendships`, `blocks`: vem som har skickat förfrågan till vem, vilka som är vänner och vem som har blockerat vem, med tidpunkt.
- `friend_code_attempts`: bara tidpunkten när någon skrivit in en kod (max 20 försök i timmen, mot kodgissning). Raderas efter en timme.
- Tabellerna kan inte läsas direkt från appen. Allt går via databasfunktioner som kontrollerar vem du är. Du ser bara namn, användarnamn och färg för dina vänner, dina förfrågningar och dem du blockerat. Andras vänkoder visas aldrig, och den som blockerat dig syns inte.
- Raderar du ditt konto försvinner även dina vänskaper, förfrågningar och blockeringar.

## Innan offentlig lansering

- Slå på "Confirm email" i Supabase igen och koppla en egen gratis e-posttjänst (SMTP), annars räcker 2 mejl i timmen inte.
- Integritetspolicy och användarvillkor (GDPR) och rapportering av användare (blockering finns sedan etapp 4).

## Vad som sparas (etapp 5)

- `location_shares`: vilka vänner du har valt ska få se dig. Ingen är vald från början.
- `location_settings`: om du har pausat (och till när) och om osynligt läge är på.
- `locations`: bara din **senaste** position (latitud, longitud, noggrannhet, tid). En rad per person som skrivs över. Ingen historik.
- Positionen raderas direkt när du pausar, slår på osynligt läge, slutar dela med alla, loggar ut, tar bort eller blockerar den sista vännen du delar med, och automatiskt efter 24 timmar.
- En vän får bara dina koordinater om ni är vänner, ingen av er har blockerat den andra, du har valt just den vännen och du inte har pausat eller är osynlig. Tabellerna kan inte läsas direkt från appen (Row Level Security utan regler), allt går via databasfunktioner.
- Vännens ålder på positionen räknas av servern. En position äldre än 2 minuter visas grå med tid ("Senast 14:32 · 12 min sedan"), aldrig som live.

## Begränsningar med webbapp (PWA)

- Positionen skickas bara medan PULSE är öppen och syns på skärmen. Låser du mobilen, byter app eller stänger appen slutar uppdateringarna.
- På iPhone stoppar Safari webbappar i bakgrunden direkt, även när de är installerade på hemskärmen. På Android kan Chrome fortsätta en kort stund, men inte pålitligt.
- Vännerna ser då din senaste position som grå med tid, aldrig som live.
- Kontinuerlig delning i bakgrunden (som Zenly) kräver en riktig app (native, t.ex. React Native/Expo) med bakgrundsbehörighet för plats.
