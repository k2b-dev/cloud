---
id: kit-assistant
title: Mit dem Assistant programmieren
icon: ti ti-code
description: Mit dem Assistant programmieren in Kit
order: 102
---

Bitte den Assistant um eine neue Kit-App oder gib ihm die genaue URL oder Referenz einer bestehenden App.
Du brauchst Admin-Rechte, damit er den Code ändern kann. Beschreibe den kompletten
Ablauf mit Eingaben, Ergebnissen, Dateiformaten und Fehlerfällen.

Der Assistant kann die App finden, Revision und Dateien lesen, Änderungen prüfen
und als zusammenhängenden Satz mit Cloud-Bestätigung speichern. Er liest diese
Hilfe über search_help und read_help, einschließlich der SDK-Artikel. Eine
separate SDK-Capability gibt es nicht. Löschen, Datenbank-Zurücksetzen und Freigaben bleiben in Kit.

Die Quelltext-Operationen heißen kit.app.search, kit.app.read, kit.source.read,
kit.source.validate und kit.source.apply. Dateien werden in UTF-16-Abschnitten
gelesen; mit nextOffset bis complete in derselben Revision fortsetzen.
Änderungen enthalten expectedRevision, upsert (vollständige Dateien), delete
(Pfade) und edits (ein Bereich pro Datei: path, offset, deleteCount, content).
Jeder Pfad darf nur in einer Operation vorkommen. Nicht genannte Dateien bleiben
erhalten. Anfragen samt JSON müssen in 256 KiB passen; große Dateien gezielt
ändern. Die Prüfung kontrolliert Syntax, Imports und Einstiegspunkte, führt
aber keinen Code aus. Ungültige Endstände werden nicht gespeichert.

Öffne nach dem Speichern die App und klicke zum Testen auf **Starten**. Der
Assistant kann lokale Browserdateien und Ergebnisse nicht lesen. Stelle bei
Bedarf geeignete Beispiele oder Fehlermeldungen bereit. Eine statische Prüfung
beweist noch nicht, dass die Verarbeitung funktioniert. Bei Konflikten neu lesen
und zusammenführen; bei unklarem Speicherergebnis vor einem erneuten Versuch
Revision und Dateien prüfen.

## Apps anlegen und einstellen {icon="apps"}

`kit.app.create` erstellt eine App mit README-Seite und optionaler gemeinsamer
Datenbank (`databaseEnabled`). `kit.app.update` ändert Name, Beschreibung oder
Datenbank-Aktivierung mit der aktuellen `expectedRevision`. Deaktivieren erhält
die Daten. RSQL muss durch einen Cloud-Administrator aktiviert sein.
Beide liefern die App-ID und den Datenbankstatus. Solange die Datenbank vorbereitet
wird, dieselbe App behalten und `kit.database.status` prüfen.
Für Erstellen und Einstellungen kannst du **Immer erlauben** wählen.
Quelltext- und Datenbankänderungen benötigen weiterhin eine Bestätigung.
Die Berechtigungen werden bei jedem Aufruf geprüft.

[Beginne mit dem vollständigen CRUD-Beispiel](/app/kit/help/kit-crud-example) für kleine gemeinsame Datenbank-Apps. Lies genaue Methodenüberschriften nur beim Anpassen des Beispiels. Leere Zeilenlisten liefern immer `data: []`.
