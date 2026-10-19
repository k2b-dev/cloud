---
id: pulse-data-model
title: Erfasste Daten verstehen
icon: ti ti-stack-2
kind: reference
description: Wähle Metriken, Ereignisse oder Zustände und verstehe Zeitstempel, Korrekturen und Aufbewahrung.
order: 105
---
Wähle den Datentyp passend zu den Angaben deiner Quelle. Jede Base hat eigene Quellen, eigenen Zugriff und eigene Aufbewahrung.

## Wähle einen Datentyp

:::reference
- **Metrik:** Eine Zahl im Zeitverlauf, etwa die Speichernutzung oder ein Zähler abgeschlossener Bestellungen. Zähler dürfen nicht negativ sein.
- **Ereignis:** Etwas ist zu einem bestimmten Zeitpunkt passiert, etwa ein Besuch oder eine abgeschlossene Bestellung.
- **Zustand:** Der aktuelle Wert eines Sachverhalts, etwa der Online-Status oder eine Version. Pulse speichert den Verlauf nur für Anfangswerte und Wertänderungen.
- **Dimension:** Ein wiederverwendbares Merkmal, etwa Region, Routenvorlage oder Kanal. Halte Anfrage-IDs und vollständige URLs aus Metrikdimensionen heraus.
:::

Nutze `attributes` für eindeutige Ereignisdetails, `sensitive` für geschützte Felder mit kürzerer Aufbewahrung und `payload` für verschachtelte Details.
Nutze `actorId`, `sessionId` und `correlationId`, um zusammengehörige Ereignisse zu verbinden.

## Verstehe angenommene Werte

:::reference
- **Zeit:** Ohne Zeitstempel nutzt Pulse die Annahmezeit. Gesendete Zeitstempel dürfen höchstens fünf Minuten in der Zukunft liegen.
- **Metrikalter:** Metrikzeitstempel müssen innerhalb der Rohdatenaufbewahrung liegen. Versiegelte Stunden lehnen weitere Werte ab, auch nach längerer Aufbewahrung.
- **Korrekturen:** Für dieselbe Metrikreihe und denselben Zeitstempel gilt der zuletzt angenommene Wert. Die Korrektur ist sofort sichtbar.
- **Aktuelle Zustände:** Der neuere Zeitstempel gewinnt. Bei gleichem Zeitstempel gewinnt die spätere Annahme; innerhalb eines Batches entscheidet die Eingabereihenfolge.
- **Ältere Zustände:** Ältere Momentaufnahmen ändern nichts. Gleiche Werte aktualisieren den aktuellen Stand ohne zusätzlichen Verlauf.
- **Getrennte Quellen:** Metriken und Zustände unterschiedlicher Quellen bleiben getrennt.
:::

Stundenwerte enthalten Anzahl, Summe, Minimum, Maximum, letzten Wert samt Zeitstempel und Zähleranstieg.
Nach einem Zählerrücksprung zählt der neue Wert als Anstieg. Korrekturen lösen eine Neuberechnung betroffener Stunden aus.

## Verstehe die Aufbewahrung

Die Rohdatenaufbewahrung gilt für detaillierte Messwerte, Ereignisse und Zustandsverläufe.
Stundenwerte und sensible Ereignisfelder haben eigene Fristen. Aktuelle Zustände verfallen nicht.

Abgelaufene Ereignisse, Verläufe, Stundenwerte und sensible Felder werden bei der Speicherbereinigung entfernt.
Rohdatenpartitionen verschwinden nachts erst, wenn ihr ganzer Tag abgelaufen ist und seine erfassten Stunden versiegelt sind.
Die Base-Einstellungen zeigen betroffene Daten, bevor du eine kürzere Frist bestätigst.
