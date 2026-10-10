---
id: grids-views-reports
title: Ansichten und Berichte
icon: ti ti-filter
description: Speichere wiederkehrende Wege, Datensätze zu finden, anzuordnen und zusammenzufassen.
order: 120
---
Eine Ansicht ist ein benannter Weg, die Daten einer Tabelle zu verwenden. Sie speichert eine GQL-Abfrage und Anzeigeeinstellungen und kopiert die Datensätze nicht. Änderst du einen Datensatz in einer Ansicht, ändert sich derselbe Datensatz überall, wo er erscheint.

Erstelle eine Ansicht, wenn Personen oft dieselbe Teilmenge, Reihenfolge, Spaltenauswahl, dasselbe Kartenboard, denselben Kalender oder denselben gruppierten Bericht brauchen. Nutze beim Erkunden eine ungespeicherte Tabellenabfrage. Speichere sie, sobald das Ergebnis zur regelmäßigen Arbeit gehört.

## Datensätze zusammenstellen {icon="table"}

Die visuellen Steuerelemente und GQL beschreiben dasselbe Ergebnis:

:::reference
- **Suche:** Findet einen Begriff in allen durchsuchbaren angezeigten Werten.
- **Filter:** Behält die Datensätze, die genauen Regeln entsprechen.
- **Sortieren:** Legt ihre Reihenfolge fest.
- **Berechnet:** Fügt eine berechnete Ergebnisspalte hinzu. Der Tabelle fügt sie kein Feld hinzu.
- **Gruppierung:** Fasst Datensätze zu einer Ergebniszeile je Kategorie zusammen.
- **Aggregationen:** Berechnen Werte wie Anzahl, Anzahl eindeutiger Werte, Summe, Durchschnitt, Median, frühesten, spätesten, kleinsten oder größten Wert.
:::

Nutze die Suche zum Erkunden. Nutze einen Filter, wenn die Regel exakt und wiederverwendbar sein muss, etwa Status ist Offen, Betrag ist größer als 1.000 oder Fälligkeitsdatum liegt vor heute.

Füge eine Sortierung hinzu, wenn die Reihenfolge fachliche Bedeutung hat. Haben mehrere Datensätze denselben Wert, ergänzt Grids für die Seitennavigation ein stabiles Entscheidungskriterium. Eine ausdrückliche zweite Sortierung kann die Reihenfolge für Personen trotzdem klarer machen.

## Die Darstellung wählen {icon="layout-list"}

**Tabelle** ist die Vorgabe für dichte Vergleiche und Bearbeitungen. Wähle die sichtbaren Spalten und ihre Reihenfolge für die Aufgabe.

Ein neues Feld erscheint als letzte Tabellenspalte, außer es ist auf **In Tabelle ausblenden** gesetzt. Das gilt auch für ein Feld, das über die CLI oder API entsteht. Auch ein Feld, das du aus dem Papierkorb wiederherstellst, erscheint wieder in der Tabelle. Hat jemand die Tabellenspalten inzwischen geändert, zum Beispiel in einem anderen Tab, lädt Grids sie neu und überschreibt diese Änderung nicht. Wiederhole deine Änderung dann an den aktuellen Spalten.

Um ein ausgeblendetes Feld wieder in der Tabelle anzuzeigen, öffne die Tabelle im **Bearbeitungsmodus** und wähle **Spalte hinzufügen**. Blendest du ein Feld mit der Einstellung **In Tabelle ausblenden** ein, hebt Grids diese Einstellung auf. Verwendet ein ausgeblendetes Feld schon den Namen eines neuen Felds, bietet Grids an, stattdessen dessen Spalte einzublenden.

**Karten** zeigen jeden Datensatz als einzelnen Eintrag mit kurzem Titel, ausgewählten Feldern und einem optionalen Bild.

**Kalender** ordnet Datensätze nach einem Feld vom Typ Datum oder Datum und Uhrzeit an. Nutze ihn für Buchungen, Fälligkeiten, Schichten und geplante Arbeit.

Eine gruppierte oder nur aggregierte Abfrage liefert Ergebniszeilen, keine bearbeitbaren Datensätze. Nutze sie für Berichte, Diagramme, Grids Apps, Dokumente und Exporte.

## Eine nützliche Ansicht speichern {icon="layout-list"}

:::steps
1. Öffne die Quelltabelle.
2. Beschreibe das Ergebnis mit **Abfrage**, **Filter**, **Sortieren** oder **Berechnet**.
3. Prüfe das Ergebnis mit repräsentativen Daten und ohne Daten.
4. Wähle den Anzeigemodus und nur die Spalten, die Personen brauchen.
5. Wähle **Als Ansicht speichern** und gib der Ansicht einen aufgabenbezogenen Namen wie **Offene Rechnungen**.
6. Teile sie nur mit den Personen, die ihr Ergebnis sehen dürfen.
:::

Personen mit Zugriff **Ansehen** auf die Base sehen eine geteilte Ansicht. Eine persönliche Ansicht gehört der Person, die sie erstellt hat. Um ein gespeichertes Ergebnis bereitzustellen, ohne die Base zu öffnen, nimm es in den Capability-Snapshot einer Grids App auf.

## Berichte erstellen und Ergebnisse durchblättern {icon="point"}

Nutze Gruppierungen und Aggregationen für Berichte. Ein monatlicher Umsatzbericht gruppiert Rechnungen zum Beispiel nach Monat und summiert Gesamt. Setze Filter, die vor der Gruppierung gelten, an den Anfang. Nutze `having` in GQL, wenn die Regel für ein aggregiertes Ergebnis gilt.

Lege in den visuellen Steuerelementen die Gruppenreihenfolge an der Gruppierung selbst fest oder sortiere Gruppen nach einem Aggregatwert. Die Sortierung der Datensätze bleibt davon getrennt und bestimmt die Gruppenreihenfolge nicht. Für gespeicherte und föderierte Tabellen gilt dieselbe Regel.

Eine Ansicht ohne ausdrückliches `limit` kannst du über das gesamte passende Ergebnis durchblättern. Ein `limit` begrenzt das logische Ergebnis bewusst über alle Seiten hinweg. Jede Seite ist eine Live-Abfrage. Ein Datensatz, der sich zwischen zwei Seitenaufrufen ändert, kann deshalb seine Position wechseln. Nutze eine stabile Sortierung für eine vorhersehbare Navigation.

## Entscheiden, ob du eine Ansicht speicherst {icon="route"}

Speichere eine Ansicht, wenn Personen mit Zugriff auf die Base sie wiederholt aufrufen oder mehrere Grids Apps sie verwenden. Verwendet nur ein Block einer Grids App die Abfrage, speichere das GQL direkt in diesem Block. So bleiben einmalig genutzte Ansichten aus der Navigation heraus.

:::note GQL für komplexe Abfragen nutzen
Nutze GQL für Joins, genaue Gruppierungen, `having`, gelöschte Datensätze, begrenzte Suchen oder jede Abfrage, die als Text klarer ist als in mehreren Steuerelementen.
:::
