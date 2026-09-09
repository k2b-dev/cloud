---
id: kit-start
title: Browser-Werkzeuge
icon: ti ti-code
description: Kleine Werkzeuge erstellen, benutzen und teilen, die Dateien auf deinem Gerät verarbeiten.
order: 100
---

Eine neue App startet mit einem CSV-Konverter und einer Verlaufsseite.
**App benutzen** öffnet die Ausführung, **Bearbeiten** den JavaScript-Editor.
Nur Administratoren der App können sie bearbeiten und teilen.

## App benutzen

Das Werkzeug öffnet sich automatisch. Wähle eine CSV-Datei aus; rechts siehst du
die Vorschau. Links stellst du Trennzeichen und Spalten ein, unten exportierst du
das Ergebnis. Unter **Vergangene Exporte** kannst du frühere Dateien erneut
herunterladen.
Ausgewählte Dateien bleiben im Browser; Kit lädt sie nicht hoch und verändert
die Originale nicht. Downloads erscheinen unter den Ergebnissen.
**Stoppen** beendet das laufende Skript.

Eine App kann mehrere Werkzeuge enthalten. Wähle sie in der linken Navigation.
Bei aktiviertem lokalem Speicher teilen sie ihre Ergebnisse auf diesem Gerät.
Andere Benutzer und Browserprofile haben getrennte Daten. Eine Freigabe teilt
Code und Einstellungen, aber keine lokalen Dateien. Beim Löschen der
Browserdaten gehen auch lokal gespeicherte Ergebnisse verloren.

## Bearbeiten und teilen

Jede Datei mit der Endung `*.script.js` definiert ein Werkzeug:
`export default kit.script({ name: "Mein Werkzeug", run() { kit.ui.text("Hallo"); } })`.
Hilfsfunktionen können in weiteren `.js`-Dateien stehen und über relative
Pfade importiert werden. Der Editor zeigt Syntaxfarben ohne Autovervollständigung.
Dateien und Vorschau sind als Tabs geöffnet. Über das Drei-Punkte-Menü einer
Datei kannst du sie umbenennen oder löschen. **Abbrechen** verwirft Änderungen
nach einer Rückfrage.
Speichere per Schaltfläche oder Strg/Cmd+S. Die Vorschau verwendet den aktuellen
Editorinhalt, der Benutzungsmodus die gespeicherte Version.

Unten in der linken Navigation findest du **Bearbeiten** und **Einstellungen**.
Unter **Einstellungen → Teilen** vergibst du Zugriff auf Metadaten, Benutzung oder Bearbeitung
und Freigaben. Wer die App benutzen kann, kann auch ihren JavaScript-Code
lesen. Hinterlege daher keine Geheimnisse im Quelltext.

Hat jemand zwischenzeitlich gespeichert, lade die App vor dem nächsten
Speichern neu. Sichere vorher deine eigenen Änderungen.
