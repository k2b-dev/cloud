---
id: kit-authoring
title: Apps erstellen und bearbeiten
icon: ti ti-code
description: Apps erstellen und bearbeiten in Kit
order: 101
---

Wähle **Neue App** und beginne mit einem leeren Werkzeug oder der CSV-Werkstatt.
App-Administratoren können **Bearbeiten** öffnen. Jede *.script.js-Datei definiert
ein Werkzeug:

```js
export default kit.script({ name: "Mein Werkzeug", run() { kit.ui.text("Hallo!"); } });
```

Hilfsmodule verwenden .js und relative Imports wie ./utils.js. Externe Pakete,
dynamische Imports und Netzwerkaufrufe sind nicht verfügbar. Die Kit-SDK-Hilfe
beschreibt die aktuellen Methoden. Nutze für Dateiwerkzeuge eine Werkbank mit
Eingaben, Ergebnissen und Fußzeile. run() baut die UI auf; Callbacks verarbeiten
Dateien. Geldbeträge berechnest du mit kit.money.

Dateien und Vorschau haben getrennte Tab-Gruppen. Das Plus fügt Dateien hinzu;
das Dateimenü bietet Umbenennen und Löschen. Umbenennen passt statische Imports
an. Die Vorschau verwendet den Entwurf und startet erst nach deinem Klick.
Änderungen erscheinen nach einem Neustart in der laufenden Vorschau. Die Konsole
zeigt Fehler und Meldungen mit Zeitstempeln.

**Speichern** oder Strg/Cmd+S speichert; **Abbrechen** fragt vor dem Verwerfen nach.
Während des Speicherns neu eingegebene Änderungen bleiben ungespeichert. Bei
einem Revisionskonflikt lade deinen Entwurf herunter, lade den neuesten Stand
und führe die Änderungen zusammen.

## Markdown-Seiten {icon="markdown"}

Wähle **Markdown-Seite hinzufügen** in der Editor-Seitenleiste für eine `.md`-Datei.
Bearbeite sie mit der normalen Markdown-Werkzeugleiste; die Vorschau aktualisiert
sich beim Schreiben. Die erste `# Überschrift` wird zum Navigationstitel,
ansonsten der Dateiname. Nach dem Speichern erscheint die Seite in der App.
Sie öffnet sich direkt ohne Script-Start. Umbenennen und Löschen findest du im
Dateimenü. Mindestens ein Werkzeug oder eine Seite muss bleiben. Seiten nutzen
die Freigaben und Revision der App. CLI und Assistant können sie über dieselben
Dateioperationen lesen und ändern.

## Gemeinsame Daten und Importe {icon="database-import"}

Ein Cloud-Administrator aktiviert rsql global; danach aktiviert ein App-Administrator die Datenbank in den App-Einstellungen. Alle Nutzer mit Use-Zugriff teilen dieselben Datensätze. Schemaänderungen benötigen Admin. Deaktivieren erhält Daten; Zurücksetzen löscht Tabellen und Datensätze. Beim Löschen der App wird auch ihre Server-Datenbank gelöscht. Lokale Dateien bleiben davon getrennt.

Lies vor der Programmierung die SDK-Hilfe zu `kit.db`. `importData` prüft Zeilen und hängt sie in sequenziellen Batches an. Der Fortschritts-Toast kann weitere Arbeit abbrechen, bestätigte Batches bleiben jedoch erhalten. `unknown` bedeutet, dass der letzte Schreibvorgang bereits abgeschlossen sein könnte. Wiederhole ihn nicht ungeprüft: Automatisches Batch-Replay und dauerhafte Wiederaufnahme gibt es noch nicht.

Halte Ein-Personen-Werkzeuge einfach. Ergänze keine Locks, Queues oder Konfliktlogik ohne echten Bedarf. Bei gemeinsamer Bearbeitung helfen Constraints; Lesen und anschließendes Schreiben sind aber keine atomare Transaktion. Nach einem Reset müssen laufende Scripts neu gestartet werden.

## UI aktualisieren und Eingaben abfragen {icon="forms"}

UI-Handles nutzen `set(value)`. Listen und Tabellen bieten zusätzlich
`upsert(items)` und `remove(ids)`. `remove()` ohne Argument leert die Anzeige,
löscht aber keine gespeicherten Daten. Tabellen brauchen für gezielte Änderungen
`rowKey`. Formen und Grenzen stehen in der UI-SDK-Hilfe. Die Alpha-API bietet
keine alten Setter mehr an.

Für eine neue Aufgabe oder ähnliche Einträge öffnest du aus einem Button
`kit.ui.modal.dialog({title, fields})`. Unterstützt werden Text-, Zahlen-,
Select- und Boolean-Felder. Für einzelne Entscheidungen oder Werte gibt es
`kit.ui.modal.confirm`, `.text` und `.number`. Behandle Abbrechen vor jedem
Schreibzugriff. Stoppen schließt den Dialog des Scripts. Titel und
Feldbeschriftungen sind Pflicht; Standardbuttons folgen der Cloud-Sprache.

`kit.ui.chart({kind,...options})` bietet alle 14 stdlib-Diagrammtypen, darunter
Linien, Balken, Donut und Karte. Übergib JSON-Optionen und aktualisiere mit
`.set(options)`. Theme, Größe und Leerzustände übernimmt die gemeinsame UI.
Formatter-Funktionen und eigenes HTML werden nicht unterstützt. Ergänze eine
lesbare Erklärung zum Diagramm.
