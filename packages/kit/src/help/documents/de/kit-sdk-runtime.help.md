---
id: kit-sdk-runtime
title: Kit API — hier beginnen
icon: ti ti-code
description: Erstes Script, passende Referenz sowie Effekte und Grenzen verstehen.
order: 190
---

Baue die Oberfläche in `run()` auf und erledige Arbeit in Callbacks. Der Nutzer muss **Starten** anklicken; Scripts starten nicht automatisch. Editor-Vorschauen nutzen den Entwurf. Nach JavaScript-Änderungen die Vorschau neu starten.

## Erstes lauffähiges Script {icon="player-play"}

Lege `main.script.js` an, füge diesen Code ein, speichere und starte:

```js
export default kit.script({
  name: "Namen",
  run() {
    const result = kit.ui.text("Noch kein Name");
    kit.ui.button("Name hinzufügen", async () => {
      const name = await kit.ui.modal.text({
        title: "Name hinzufügen", label: "Name", required: true
      });
      if (name === null) return;
      result.set(name);
    });
  }
});
```

Der Button öffnet einen Dialog. Bestätigen ändert den angezeigten Text, Abbrechen ändert nichts. Dieses Beispiel speichert keine Daten.

## Passende Referenz finden {icon="search"}

| Aufgabe | Referenz |
|---|---|
| Buttons, Eingaben und Layouts zusammensetzen | [UI](/app/kit/help/kit-sdk-ui), [Optionsfelder](/app/kit/help/kit-sdk-ui-types) |
| Listen, Tabellen und Controls aktualisieren | [UI-Handles](/app/kit/help/kit-sdk-handles) |
| Bestätigung oder Formularwerte abfragen | [Modals](/app/kit/help/kit-sdk-modals) |
| Diagramm anzeigen | [Charts mit sämtlichen Feldern](/app/kit/help/kit-sdk-charts) |
| Dateien auswählen/herunterladen und CSV lesen | [Dateien](/app/kit/help/kit-sdk-file), [CSV](/app/kit/help/kit-sdk-sheet) |
| PDF-Text lesen | [PDF](/app/kit/help/kit-sdk-pdf) |
| Geld exakt berechnen | [Money](/app/kit/help/kit-sdk-money) |
| Lokale Werte/Dateien pro Nutzer speichern | [KV](/app/kit/help/kit-sdk-store), [OPFS](/app/kit/help/kit-sdk-opfs) |
| Datensätze mit anderen Nutzern teilen | [Datenbank](/app/kit/help/kit-sdk-db) |

`cld kit sdk` liefert dieselben Referenzdaten einschließlich Argumentdefinitionen und JSON-Schemas. Agenten nutzen `search_help` und `read_help` für diese Artikel. Es gibt keine separate SDK-Capability.

## Werte und Fehler {icon="info-circle"}

Optionale Felder dürfen fehlen oder `undefined` sein. `null` ist nur erlaubt, wenn ausdrücklich aufgeführt. `{}` bedeutet ein Optionsobjekt ohne Überschreibungen, `[]` eine leere Sammlung. `JSON` umfasst Strings, endliche Zahlen, Booleans, null sowie Arrays und Objekte aus JSON-Werten: keine Funktionen, Handles, BigInt oder Zyklen.

UI-Konstruktoren und Handle-Methoden sind synchron. Host-Aufrufe liefern Promises; warte sie in `async run()` oder einem asynchronen Callback mit `await` ab. Gib das Promise aus dem Callback zurück, damit Kit seine Laufzeit verfolgen kann. Solange ein Callback wartet, werden andere Callbacks nicht ausgeführt. Eingabewerte können sich trotzdem ändern. Nutze einen langen asynchronen `onChange` nicht als Warteschlange.

Fange Fehler ab, wenn der Nutzer darauf reagieren kann. Sonst zeigt Kit sie in der Konsole. `console.log`, `info`, `warn` und `error` werden umgeleitet; Logs sind Diagnoseausgaben, keine dauerhaften Datensätze. Callbacks und `run()` erhalten keine versteckten Argumente oder Cloud-Zugangsdaten. Programmatisches `set()` ruft `onChange` nicht auf.

**Stoppen** beendet den Worker und schließt seinen Dialog. Wartende Host-Aufrufe werden verworfen, angenommene Schreibvorgänge können aber fertig werden. Ein Neustart erzeugt neue UI-Handles; gespeicherte Daten bleiben erhalten. Navigation hat dieselbe Abbruchgrenze. Abbruch oder eine fehlende Antwort beweisen nicht, dass ein Datenbankschreibvorgang nicht stattgefunden hat.

## Zuordnung und Speicherung {icon="database"}

Ein UI-Element gehört zu höchstens einem Container. Verwende Listen-Aktionshandles bei Updates wieder; das Entfernen sichtbarer Einträge gibt ihre Handles nicht frei. `remove()` leert nur UI-Daten. `store.delete`, `opfs.delete` und Datenbank-Löschmethoden haben eigene Speichereffekte.

| Speicher | Geteilt mit | Lebensdauer |
|---|---|---|
| Scriptvariablen und UI-Handles | Nur aktueller Durchlauf | Bis Stoppen/Neustart |
| `kit.store`, `kit.opfs` | Seiten dieser App für diesen Nutzer in diesem Browser/Gerät | Bis zum Löschen; abhängig von Browser-Speicherregeln |
| `kit.db` | Allen Nutzern mit Use-Zugriff auf diese App | Bis zum expliziten Zurücksetzen/Löschen |

Lokaler Speicher liegt unter `kit/{appShortId}/{userId}/`, getrennt in `kv` und `files`. Deaktivieren einer gemeinsamen Datenbank erhält ihre Daten. Löschen der App löscht ihre Server-Datenbank; lokale Dateien können nicht aus der Ferne gelöscht werden. Schemaänderungen benötigen App-Admin, Zeilenoperationen Use. Es gibt keine automatischen Zeilenrechte.

Halte Ein-Personen-Apps einfach. Ergänze Nebenläufigkeitskontrollen erst bei einem konkreten Konflikt. Lesen und anschließendes Schreiben sind nicht atomar; sequenzielle Importe sind keine einzelne Transaktion. Nutze bei gemeinsamen Daten Constraints und lade nach Änderungen neu, statt unveränderte Daten anderer Nutzer anzunehmen.

## Grenzen {icon="ruler"}

| Grenze | Limit |
|---|---|
| Projektquelltext / einzelne Datei / Dateien | 2 MiB / 1 MiB / 64 |
| Pro Durchlauf angelegte UI-Knoten | 300 |
| Tabellen-/Listenzeilen / Tabellenspalten / Select-Optionen | 1000 / 64 / 200 |
| UI-Text / gewöhnliche UI-ID | 16000 / 80 Zeichen |
| Lokaler Eintrag / Host-Datenpayload | 16 MiB |
| Gleichzeitig angenommene Host-Aufrufe | 32; sequenzielle Verarbeitung |
| Laufzeitnachrichten | 600 pro Ein-Sekunden-Fenster |
| Vom Host weitergeleitete Konsolenmeldungen | 200 pro Durchlauf |
| Chart-Arrays insgesamt | 1000 Einträge einschließlich verschachtelter Arrays |

Zusätzliche Methodengrenzen gelten weiterhin. Tabellenzellen enthalten Strings, endliche Zahlen, Booleans oder null; verschachtelte Objekte gehören in deine Daten, nicht in Tabellenzellen. Ein Layout mit überschrittenen Grenzen oder ungültiger Zuordnung beendet den Durchlauf. Short-IDs bestehen aus sechs alphanumerischen Zeichen.

## Heute verfügbar {icon="check"}

Die Referenz beschreibt die implementierte API. Externe Paketimports, direkter Worker-Netzwerkzugriff, direkter Origin-Speicher, OCR, beliebiges HTML, Chart-Formatter-Funktionen im Worker und eine Script-i18n-API sind nicht verfügbar. Relative statische Imports zwischen `.js`-Projektdateien werden unterstützt; `.md`-Dateien sind Dokumentationsseiten. Standardcontrols folgen der Cloud-Sprache; Beschriftungen deines Scripts sind dein eigener Text.
