---
id: grids-views-reports
title: Ansichten und Berichte
icon: ti ti-filter
description: Speichere wiederkehrende Anordnungen, Suchen und Zusammenfassungen von Datensätzen.
order: 120
---
Eine Ansicht ist eine benannte Möglichkeit, die Daten einer Tabelle zu verwenden. Sie speichert eine GQL-Abfrage und Anzeigeeinstellungen, ohne die Datensätze zu kopieren. Ändert sich ein Datensatz in einer Ansicht, ändert sich derselbe Datensatz überall, wo er angezeigt wird.

Erstelle eine Ansicht, wenn Personen wiederholt dieselbe Teilmenge, Sortierung, Spaltenauswahl, dasselbe Kartenboard, denselben Kalender oder gruppierten Bericht benötigen. Nutze beim Erkunden eine ungespeicherte Tabellenabfrage und speichere sie, sobald das Ergebnis zur regelmäßigen Arbeit gehört.

## Datensätze zusammenstellen {icon="table"}

Die visuellen Steuerelemente und GQL beschreiben dasselbe Ergebnis:

- **Suche** findet einen Begriff in allen durchsuchbaren angezeigten Werten.
- **Filter** behält Datensätze, die genau definierten Regeln entsprechen.
- **Sortieren** bestimmt ihre Reihenfolge.
- **Berechnet** fügt eine berechnete Ergebnisspalte hinzu, ohne der Tabelle ein Feld hinzuzufügen.
- **Gruppierung** fasst Datensätze zu einer Ergebniszeile je Kategorie zusammen.
- **Aggregationen** berechnen Werte wie Anzahl, Anzahl eindeutiger Werte, Summe, Durchschnitt, Median, frühesten, spätesten, kleinsten oder größten Wert.

Die Suche eignet sich zum Erkunden. Nutze einen Filter, wenn die Regel wiederverwendbar und exakt sein muss, etwa Status ist Offen, Betrag ist größer als 1.000 oder Fälligkeitsdatum liegt vor heute.

Füge eine Sortierung hinzu, wenn die Reihenfolge fachliche Bedeutung hat. Haben mehrere Datensätze denselben Wert, ergänzt Grids für die Seitennavigation ein stabiles Entscheidungskriterium. Eine ausdrückliche zweite Sortierung kann die Reihenfolge für Personen trotzdem klarer machen.

## Die Darstellung des Ergebnisses wählen {icon="layout-list"}

**Tabelle** ist die Vorgabe für dichte Vergleiche und Bearbeitungen. Wähle nur die Spalten und ihre Reihenfolge aus, die für die Aufgabe benötigt werden.

**Karten** eignen sich, wenn jeder Datensatz als einzelner Eintrag mit kurzem Titel, ausgewählten Feldern und einem optionalen Bild erscheinen soll.

**Kalender** ordnet Datensätze anhand eines Felds vom Typ Datum oder Datum und Uhrzeit an. Nutze ihn für Buchungen, Fälligkeiten, Schichten und geplante Arbeit.

Eine gruppierte oder ausschließlich aggregierte Abfrage liefert Ergebniszeilen statt bearbeitbarer Datensätze. Sie eignet sich für Berichte, Diagramme, Grids Apps, Dokumente und Exporte.

## Eine nützliche Ansicht speichern {icon="layout-list"}

:::steps
1. Öffne die Quelltabelle und beschreibe das Ergebnis mit Abfrage, Filter, Sortierung oder berechneten Spalten.
2. Prüfe das Ergebnis mit repräsentativen Daten und ohne Daten.
3. Wähle den Anzeigemodus und nur die Spalten, die Personen benötigen.
4. Speichere die aktuelle Konfiguration als Ansicht und gib ihr einen aufgabenbezogenen Namen wie **Offene Rechnungen**.
5. Teile sie nur mit den Personen, die das enthaltene Ergebnis sehen dürfen.
:::

Eine geteilte Ansicht ist für Personen mit Lesezugriff auf die Basis sichtbar. Eine persönliche Ansicht gehört ihrer erstellenden Person. Um ein gespeichertes Ergebnis bereitzustellen, ohne die Basis zu öffnen, nimm es in den Capability-Snapshot einer Grids App auf.

## Berichte und Seitennavigation {icon="point"}

Nutze Gruppierungen und Aggregationen für Berichte. Ein monatlicher Umsatzbericht gruppiert Rechnungen beispielsweise nach Monat und summiert Gesamt. Setze Filter vor die Gruppierung. Nutze `having` in GQL, wenn die Regel für ein aggregiertes Ergebnis gilt.

Lege in den visuellen Steuerelementen die Gruppenreihenfolge an der Gruppierung fest oder sortiere Gruppen nach einem Aggregatwert. Die Datensatzsortierung bleibt davon getrennt und bestimmt nicht die Gruppenreihenfolge. Für gespeicherte und föderierte Tabellen gilt dieselbe Regel.

Ansichten ohne ausdrückliches `limit` lassen sich über das gesamte passende Ergebnis durchblättern. Ein `limit` begrenzt das logische Ergebnis bewusst über alle Seiten hinweg. Seiten sind Live-Abfragen, daher können Datensätze, die zwischen Seitenaufrufen geändert werden, ihre Position wechseln. Nutze eine stabile Sortierung für eine vorhersehbare Navigation.

## Wiederverwenden oder lokal halten {icon="route"}

Speichere eine Ansicht, wenn Personen mit Zugriff auf die Basis sie wiederholt aufrufen oder mehrere Grids Apps sie wiederverwenden. Speichere GQL direkt im Block, wenn nur ein Block einer Grids App die Abfrage verwendet, statt die Navigation mit einmalig verwendeten Ansichten zu füllen.

:::note GQL für komplexe Abfragen
Nutze GQL für Joins, genaue Gruppierungen, `having`, gelöschte Datensätze, begrenzte Suchen oder andere Abfragen, die als Text klarer sind als in mehreren Steuerelementen.
:::
