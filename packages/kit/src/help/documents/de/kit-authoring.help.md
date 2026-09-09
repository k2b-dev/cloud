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
