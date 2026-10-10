---
id: grids-core-model
title: Das Kernmodell verstehen
icon: ti ti-stack-2
description: Verstehe, wie Bases, Tabellen, Datensätze, Felder und Ressourcen zusammenhängen.
order: 105
---
Grids trennt gespeicherte Fakten von den Wegen, auf denen Personen sie eingeben, prüfen, darstellen und bearbeiten. Diese Trennung verhindert doppelte Daten und macht den Zugriff leichter nachvollziehbar.

## Von der Base zum Wert {icon="point"}

Eine **Base** ist die Grenze um einen Arbeitsbereich. Sie enthält Tabellen und die darauf aufgebauten Ressourcen. Nutze getrennte Bases, wenn Themen unterschiedliche Verantwortliche, unterschiedlichen Zugriff oder unterschiedliche Arbeitsregeln haben.

Eine **Tabelle** speichert eine Art von Einträgen. Kunden und Rechnungen gehören in unterschiedliche Tabellen, weil sie unterschiedliche Felder und Lebenszyklen haben. Eine Tabelle ist kein Seitenlayout: Mehrere Ansichten und Grids Apps können dieselbe Tabelle darstellen.

Ein **Datensatz** ist ein gespeicherter Eintrag in einer Tabelle. In einer Tabelle für Kunden ist jeder Kunde ein Datensatz. Du kannst einen Datensatz ändern, in den Papierkorb verschieben, wiederherstellen und über seinen Verlauf prüfen.

Ein **Feld** speichert eine Information zu jedem Datensatz seiner Tabelle. Name, Status, Betrag, Fälligkeitsdatum, Anhang und verantwortliche Person sind Felder. Der Feldtyp bestimmt, wie Personen einen Wert eingeben, validieren, durchsuchen, filtern, darstellen und exportieren.

## Datensätze verbinden, statt Text zu kopieren {icon="table"}

Eine **Relation** verknüpft einen Datensatz mit Datensätzen in einer anderen Tabelle. Eine Rechnung kann mit einem Kunden verknüpft sein. Eine Ausleihe kann mit mehreren Gegenständen verknüpft sein. Die verknüpfte Tabelle bestimmt eine kurze **Datensatzbezeichnung**, damit Personen „Studiokamera“ statt einer internen ID sehen.

Nutze eine Relation, wenn das verknüpfte Objekt eigene Details oder einen eigenen Lebenszyklus hat. Nutze ein normales Feld, wenn der Wert nur zum aktuellen Datensatz gehört. Ein Lookup zeigt einen Wert aus einem verknüpften Datensatz an, ohne ihn zu kopieren. Ein Rollup fasst verknüpfte Werte zusammen.

## Die passende Ressource wählen {icon="point"}

Die Navigation rund um Tabellen enthält Ressourcen, die die gespeicherten Daten verwenden:

- Eine **Ansicht** speichert eine Abfrage und einen Anzeigemodus für wiederkehrende Arbeit.
- Ein **Formular** erstellt Datensätze über eine geführte Gruppe von Eingaben.
- Eine **Grids App** ordnet Daten und Aktionen für eine Rolle oder einen Prozess an.
- Eine **Dokumentvorlage** definiert eine Familie erzeugter PDF-Dateien für die Datensätze einer Tabelle.
- Ein **Workflow** definiert wiederholbare Aktionen und den Weg der Eingaben durch diese Aktionen.

Zugriff auf eine Base öffnet den vollständigen Arbeitsbereich mit Rohdaten. Eine veröffentlichte Grids App ist eine separate, feinere Grenze. Sie zeigt nur ihre kompilierten Daten und Aktionen und gibt keinen Zugriff auf die Rohdaten der Base.

## Entscheiden, wo etwas hingehört {icon="route"}

Stelle dir diese Fragen:

- Ist es eine Information zu einem Datensatz? Füge ein Feld hinzu.
- Ist es ein eigenes Objekt mit eigenen Feldern? Füge eine Tabelle und eine Relation hinzu.
- Sind es dieselben Datensätze für eine bestimmte Aufgabe? Füge eine Ansicht hinzu.
- Ist es ein gezielter Weg, Datensätze zu erstellen? Füge ein Formular hinzu.
- Ist es eine Arbeitsseite für eine Rolle? Füge eine Grids App hinzu.
- Ist es eine Druckausgabe? Füge eine Dokumentvorlage hinzu.
- Ist es ein wiederholbarer Vorgang? Füge einen Workflow hinzu.

:::note Eine maßgebliche Datenquelle behalten
Speichere Geschäftsdaten in Tabellen. Lass Ansichten, Formulare, Grids Apps, Dokumente und Workflows diese Daten verwenden, statt konkurrierende Kopien zu führen.
:::
