---
id: grids-data-exchange
title: Import, Export und externe Identitäten
icon: ti ti-arrows-exchange
description: Bringe Datensätze nach Grids, wiederhole Integrationen sicher und unterscheide Exporte von Sicherungen.
order: 112
---
Wähle den Vorgang nach seinem Zweck:

:::compare
- **Import:** Ein einmaliger Import erstellt neue Datensätze.
- **Upsert mit externer Identität:** Gleicht ein bekanntes Objekt aus einem Quellsystem ab.
- **Abfrageexport:** Lädt ausgewählte Daten herunter.
- **Nachweispaket:** Bewahrt einen prüfbaren Verlauf.
:::

## Neue Datensätze importieren {icon="file-import"}

Erkunde die Zieltabelle mit `cld grids records shape <base> <table> --json`. JSON-Werte verwenden öffentliche Feld-IDs und den echten Typ jedes Felds:

- Auswahlwerte sind Arrays von Options-IDs.
- Zahlen sind exakte Dezimalstrings.
- Relationen verwenden öffentliche Datensatz-IDs.

System- und berechnete Felder kannst du nicht schreiben.

`cld grids records import <base> <table> --body-file records.json` akzeptiert ein Array oder `{"items":[...]}` mit 1–500 einfachen Wertobjekten für Datensätze. Der Import erstellt alle Datensätze in einer Transaktion. Ein Validierungsfehler rollt die ganze Gruppe zurück.

:::warning Ein Import aktualisiert nicht anhand eines Namens
Ein Import erstellt nur Datensätze. Wiederholst du ihn nach einem unklaren Ergebnis, kann er Duplikate erzeugen.
:::

Beispiel, wenn `Name01` die echte ID eines Textfelds ist:

```json
{"items":[{"Name01":"Erster Eintrag"},{"Name01":"Zweiter Eintrag"}]}
```

Pflichtfelder, Eindeutigkeit, Standardwerte, Änderungsrichtlinie und Zugriff auf die Base gelten weiter. Lade Anhänge separat über die Dateivorgänge hoch. Kombinierte Tabellen sind schreibgeschützt und nehmen keine Importe an.

## Ein externes System anbinden {icon="plug"}

Verwende `records upsert-external`, wenn eine Quelle stabile Identitäten liefert:

```sh
cld grids records upsert-external <base> <table> \
  --provider crm --provider-account main --resource-kind contact \
  --external-id contact-42 --idempotency-key contact-42-revision-1 \
  --body-file contact.json
```

`provider`, `providerAccount`, `resourceKind` und `externalId` identifizieren gemeinsam das Quellobjekt. `--body-file` enthält normale schreibbare Feldwerte. Der Idempotenzschlüssel identifiziert diese eine logische Anfrage. Verwende ihn nach einem unklaren Ergebnis unverändert wieder. Verwende ihn nicht für eine neue Änderung.

Eine vorhandene Zuordnung erfordert `--if-version <aktuelle-version>`. Lies den Datensatz nach einem Versionskonflikt erneut und führe bewusst zusammen. Erzwinge kein Überschreiben. Die Identitätszuordnung vergleicht keine Anzeigenamen und öffnet keine gelöschten oder finalisierten Datensätze wieder.

`records upsert-external-batch` akzeptiert `{"items":[...]}` mit bis zu 100 Einträgen. Jeder Eintrag hat `externalRef`, `values`, `idempotencyKey`, optional `ifVersion` und optional `audit`. Die Einträge laufen der Reihe nach und werden unabhängig gespeichert.

:::warning Diese Gruppe ist nicht atomar
Anders als ein normaler Import kann diese Gruppe einige Einträge speichern und andere nicht. Prüfe jedes Ergebnis und das Feld `complete` der Antwort.
:::

Diese APIs planen keine Synchronisation. Sie geben keinen Zugriff auf andere Cloud-Apps. Der Connector ist für den Zugriff auf die Quelle und die Änderungserkennung zuständig. Ein Dateihash allein identifiziert keine Bankbuchung über überlappende Berichte hinweg.

## Die gewünschten Daten exportieren {icon="file-export"}

`records export <base> <table> --format csv|json --out result.csv` exportiert über den Abfragepfad, der den Zugriff prüft. `--body-file` übergibt die vollständige Konfiguration für Abfrage und Export. `--limit` begrenzt das Ergebnis auf höchstens 10.000 Zeilen. Eine Abfrage mit bewusstem Limit ist kein vollständiger Tabellenexport. Die Hilfe des CLI-Befehls beschreibt Trennzeichen, Markdown-Ausgabe und Zeilengrenzen.

Für wiederholbare, unveränderliche Dateien aus mehreren Datensätzen nutze [Workflow-Abfragen und Dokumentausgaben](/app/grids/help/grids-workflows). PDF, freies CSV/JSON/XML, DATEV-CSV und SEPA-XML teilen den Lebenszyklus von Dokumenten. Eine SEPA-Datei überweist kein Geld. Eine DATEV-CSV-Datei importiert sich nicht selbst in eine Buchhaltungssoftware.

:::warning Ein Download ist keine Sicherung
Ein CSV- oder JSON-Download stellt Zugriff, Workflow-Zustand, Vorlagen, Anhänge und unveränderlichen Verlauf nicht wieder her. Verwende [Nachweispakete](/app/grids/help/grids-evidence-exports) für prüfbare aufbewahrte Nachweise. Verwende das Sicherungsverfahren des Betreibers für die Wiederherstellung nach einem Ausfall.
:::
