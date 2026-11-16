# Event Horizon Card

Lovelace-kort för Home Assistant som visar familjens dag utifrån kalendrar: nedräkning till nästa aktivitet, vad som behöver förberedas och en tidslinje per person. Korten läser kalendrarna direkt via HA:s REST-API (`/api/calendars/<entity>`), så inga hjälpsensorer behövs.

Filen innehåller tre kort:

| Kort | Visar |
|---|---|
| `custom:family-action-card` | Stor nedräkning per person och stora ikoner för det som behöver förberedas. |
| `custom:family-timeline-card` | Dagens aktiviteter per person som tidslinje. |
| `custom:family-sundial-card` | Dygnet som 24-timmarsurtavla med solens gång och allas aktiviteter. |

## Installation via HACS

1. HACS → menyn uppe till höger → **Custom repositories**.
2. Lägg till `https://github.com/magwe/ha-event-horizon-card` med typen **Dashboard**.
3. Sök upp **Event Horizon Card** i HACS och installera.
4. HACS registrerar resursen `/hacsfiles/ha-event-horizon-card/ha-event-horizon-card.js` automatiskt. Ladda om webbläsaren.

Nya versioner publiceras som releaser här och dyker upp som uppdateringar i HACS.

## Exempel

Kortform, ett kort per person:

```yaml
type: custom:family-action-card
name: Otto
color: tomato
sources:
  - calendar: calendar.otto_skola
```

Flera personer i samma kort:

```yaml
type: custom:family-timeline-card
people:
  - name: Otto
    color: tomato
    sources:
      - calendar: calendar.otto_skola
  - name: Sigrid
    color: teal
    sources:
      - calendar: calendar.sigrid_skola
```

Solurets kort tar också emot sömn per person:

```yaml
type: custom:family-sundial-card
people:
  - name: Otto
    color: tomato
    sleep: { hours: 9, prepare: 30 }
    sources:
      - calendar: calendar.otto_skola
```

Regler, platser, restider och ikoner anges i kortets inställningar (`rules`, `places`, `travel_model` m.fl.) och ligger kvar i dashboarden, inte i den här filen.

### Regel som ersätter en annan påminnelse

`suppress` på en regel döljer andra påminnelser samma dag vars text matchar mönstret. Exempel: när klassens kalender har simning visas "Badkläder" i stället för "Idrottskläder" från schemats idrottslektion.

```yaml
rules:
  - match: simning
    icon: mdi:swim
    notice_text: Badkläder
    suppress: ^Idrottskläder$
```

### Prioritet mellan aktiviteter

`countdown_yield` på en källa eller regel stänger av nedräkningen för aktiviteten när en annan aktivitet vars titel matchar mönstret återstår samma dag. Exempel: schack räknas bara ner de dagar då ingen basket återstår.

```yaml
- calendar: calendar.schack
  label: Schack
  countdown_yield: ^Basket
```
