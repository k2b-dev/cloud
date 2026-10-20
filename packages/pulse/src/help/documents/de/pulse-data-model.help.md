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

## Lies Daten mit SQL

SQL sieht nur die gewählte Base. Leseansichten enthalten keine sensiblen Ereignisfelder, Payloads, Zugangsdaten oder internen Tabellen.
Nutze `samples`, `rollups`, `series`, `events`, `states` und `sources`.

:::reference
- **Parameter:** Nutze `:name` und übergib einen Wert. Pulse setzt `:base_tz` aus der Zeitzone der Base.
- **Eingabe:** SQL erlaubt 16 KiB UTF-8-Text, 32 Parameter und 2 KiB pro Wert.
- **Ergebnis:** Jede Abfrage erlaubt 10.000 Zeilen und 4 MiB. Bei 10.000 Zeilen kann es weitere Zeilen geben.
- **Abfragekontingent:** Der Startwert ist 600 zugelassene Fragen und SQL-Abfragen pro Base und voller Stunde.
- **Gespeicherte Abfragen:** Zugriff **Ansehen** erlaubt das Auflisten. Zugriff **Bearbeiten** erlaubt Speichern und Löschen. Änderungen prüfen die gespeicherte Revision.
:::

`increase(metric='name',from=:from,to=:to)` berechnet Zähleranstiege und berücksichtigt Rücksprünge.
`rate` nimmt dieselben Argumente an und teilt den Anstieg durch die beobachteten Sekunden.
Beide Hilfen verbinden Rohdaten mit älteren Stundenwerten. Abgelaufene Rohdaten erfordern Zeitfenster aus vollständigen Stunden.

`histogram_quantile(metric='family',from=:from,to=:to,quantile=0.95)` nutzt die Anstiege der Histogramm-Buckets.
Die Hilfe hält Quellen und Merkmalsgruppen getrennt. Geänderte Bucket-Grenzen ergeben einen Fehler mit Zeitangabe.

Nutze `toStartOfInterval(ts,toIntervalSecond(:bucket),:base_tz)` für feste Zeitintervalle.
Nutze `INTERVAL 1 DAY` für Kalendertage. Ein lokaler Tag kann 23 oder 25 Stunden haben.
