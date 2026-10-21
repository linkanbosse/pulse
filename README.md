# PULSE

PULSE är en gratis social kartapp där du kan se var dina vänner är, men bara när de själva har valt att dela sin position.

> Status: etapp 1 (prototyp). Appen är en webbapp (PWA) som kan installeras på hemskärmen.
>
> - Fungerar på riktigt: navigering, knappen "min position" (mobilens GPS, sparas inte), installation på hemskärmen.
> - Testdata: kartan är en ritad exempelkarta och alla vänner är påhittade.

## Filer

| Fil | Vad den gör |
|---|---|
| `index.html` | Själva sidan: logga, karta, vänlista, profil och bottenmeny |
| `style.css` | Utseendet (mörkt tema, färger, layout) |
| `app.js` | Logiken: byta vy, testvänner, hämta din position |
| `manifest.json` | Gör att appen kan installeras på hemskärmen |
| `sw.js` | Service worker som gör appen installerbar och laddar om senaste versionen |
| `icons/` | Appikoner |

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

## Teknik (planerad)

Projektet byggs helt från mobilen och med 0 kr i budget. Planen är att använda gratisnivåer av verktyg som Expo Snack (React Native), Supabase och öppen kartdata. Valet bekräftas i varje etapp.
