---
id: grids-core-model
title: Kernmodell
icon: ti ti-stack-2
description: Verstehe, wie Basen, Tabellen, Datensätze, Felder und Ressourcen zusammenhängen.
order: 105
---
Das Grids-Modell trennt gespeicherte Fakten von den Möglichkeiten, sie einzugeben, zu prüfen, darzustellen und zu bearbeiten. Diese Trennung verhindert doppelte Daten und macht Zugriffsrechte nachvollziehbarer.

## Von der Basis zum Wert {icon="point"}

Eine **Basis** bildet die Grenze um einen Arbeitsbereich. Sie enthält Tabellen und die darauf aufgebauten Ressourcen. Getrennte Basen sind sinnvoll, wenn Themen unterschiedliche Verantwortliche, Berechtigungen oder Arbeitsregeln haben.

Eine **Tabelle** speichert eine bestimmte Art von Einträgen. Kunden und Rechnungen gehören in unterschiedliche Tabellen, weil sie unterschiedliche Felder und Lebenszyklen haben. Eine Tabelle ist kein Seitenlayout: Mehrere Ansichten und Grids Apps können dieselbe Tabelle darstellen.

Ein **Datensatz** ist ein gespeicherter Eintrag in einer Tabelle. In einer Tabelle für Kunden ist jeder Kunde ein Datensatz. Datensätze können geändert, in den Papierkorb verschoben, wiederhergestellt und über ihren Verlauf geprüft werden.

Ein **Feld** speichert eine Information zu jedem Datensatz dieser Tabelle. Name, Status, Betrag, Fälligkeitsdatum, Anhang und verantwortliche Person sind Felder. Der Feldtyp bestimmt, wie ein Wert eingegeben, validiert, durchsucht, gefiltert, dargestellt und exportiert wird.

## Datensätze verbinden, statt Text zu kopieren {icon="table"}

Eine **Relation** verknüpft einen Datensatz mit Datensätzen in einer anderen Tabelle. Eine Rechnung kann mit einem Kunden, eine Ausleihe mit mehreren Gegenständen verknüpft sein. Die verknüpfte Tabelle bestimmt eine kurze **Datensatzbezeichnung**, damit Personen „Studiokamera“ statt einer internen ID sehen.

Nutze eine Relation, wenn das verknüpfte Objekt eigene Details oder einen eigenen Lebenszyklus hat. Nutze ein normales Feld, wenn der Wert nur zum aktuellen Datensatz gehört. Ein Lookup kann einen Wert aus einem verknüpften Datensatz anzeigen, ohne ihn zu kopieren. Ein Rollup kann verknüpfte Werte zusammenfassen.

## Ressourcen erfüllen verschiedene Aufgaben {icon="point"}

Die Navigation rund um Tabellen enthält Ressourcen, die die gespeicherten Daten verwenden:

- Eine **Ansicht** speichert eine Abfrage und einen Anzeigemodus für wiederkehrende Arbeit.
- Ein **Formular** erstellt Datensätze über eine geführte Gruppe von Eingaben.
- Eine **Grids App** ordnet Daten und Aktionen für eine Rolle oder einen Prozess an.
- Eine **Dokumentvorlage** definiert eine Familie erzeugter PDF-Dateien für Datensätze in einer Tabelle.
- Ein **Workflow** definiert wiederholbare Aktionen und den Weg der Eingaben durch diese Aktionen.

Der Zugriff auf eine Basis öffnet den vollständigen Arbeitsbereich mit Rohdaten. Eine veröffentlichte Grids App bildet eine separate, feinere Grenze: Sie stellt nur ihre kompilierten Daten und Aktionen bereit, ohne Zugriff auf die vollständige Basis zu gewähren.

## Eine hilfreiche Entscheidungshilfe {icon="route"}

Frage dich, wo etwas hingehört:

- Ist es eine Information zu einem einzelnen Datensatz? Füge ein Feld hinzu.
- Ist es ein eigenständiges Objekt mit eigenen Feldern? Füge eine Tabelle und eine Relation hinzu.
- Sind es dieselben Datensätze für eine bestimmte Aufgabe? Füge eine Ansicht hinzu.
- Ist es eine gezielte Möglichkeit, Datensätze zu erstellen? Füge ein Formular hinzu.
- Ist es eine Arbeitsseite für eine Rolle? Füge eine Grids App hinzu.
- Ist es eine Druckausgabe? Füge eine Dokumentvorlage hinzu.
- Ist es ein wiederholbarer Vorgang? Füge einen Workflow hinzu.

:::note Eine maßgebliche Datenquelle
Speichere Geschäftsdaten in Tabellen. Ansichten, Formulare, Grids Apps, Dokumente und Workflows sollten diese Daten verwenden, statt konkurrierende Kopien zu verwalten.
:::
