---
id: grids-data-exchange
title: Import, Export und externe Identitäten
icon: ti ti-arrows-exchange
description: Datensätze übernehmen, Integrationen sicher wiederholen und Exporte von Sicherungen unterscheiden.
order: 112
---
Wähle nach dem Zweck: Ein einmaliger Import erstellt neue Datensätze. Ein Upsert mit externer Identität gleicht ein bekanntes Quellobjekt ab. Ein Abfrageexport lädt ausgewählte Daten herunter. Ein Evidence-Export bewahrt prüfbare Nachweise.

## Neue Datensätze importieren

Erkunde das Ziel mit `cld grids records shape <base> <table> --json`. JSON verwendet öffentliche Feld-IDs und die echten Typen: Auswahlwerte als Arrays von Options-IDs, Zahlen als exakte Dezimalstrings und Relationen mit öffentlichen Datensatz-IDs. System- und berechnete Felder sind nicht schreibbar.

`cld grids records import <base> <table> --body-file records.json` akzeptiert ein Array oder `{"items":[...]}` mit 1–500 einfachen Datensatz-Wertobjekten. Der Import erstellt alle Datensätze in einer Transaktion. Bei einem Validierungsfehler wird die gesamte Gruppe zurückgerollt. Er aktualisiert nicht anhand eines Namens. Ein wiederholter Import nach unklarem Erfolg kann Duplikate erzeugen.

Wenn `Name01` die tatsächliche Textfeld-ID ist:

```json
{"items":[{"Name01":"Erster Eintrag"},{"Name01":"Zweiter Eintrag"}]}
```

Pflichtfelder, Eindeutigkeit, Standardwerte, Änderungsrichtlinie und Base-Rechte gelten weiter. Anhänge werden separat über Datei-Aktionen hochgeladen. Kombinierte Tabellen sind nur lesbar und können keine Importe aufnehmen.

## Externes System anbinden

Verwende `records upsert-external`, wenn die Quelle stabile Identitäten liefert:

```sh
cld grids records upsert-external <base> <table> \
  --provider crm --provider-account main --resource-kind contact \
  --external-id contact-42 --idempotency-key contact-42-revision-1 \
  --body-file contact.json
```

`provider`, `providerAccount`, `resourceKind` und `externalId` identifizieren gemeinsam das Quellobjekt. `--body-file` enthält normale schreibbare Feldwerte. Der Idempotenzschlüssel benennt diese eine logische Anfrage: Bei unklarem Ergebnis unverändert wiederverwenden, nicht für eine neue Änderung.

Eine vorhandene Zuordnung erfordert `--if-version <aktuelle-version>`. Bei einem Versionskonflikt erneut lesen und bewusst zusammenführen, nicht überschreiben. Identitätszuordnung vergleicht keine Anzeigenamen und öffnet keine gelöschten oder finalisierten Datensätze wieder.

`records upsert-external-batch` nimmt `{"items":[...]}` mit bis zu 100 Einträgen an. Jeder hat `externalRef`, `values`, `idempotencyKey`, optional `ifVersion` und optional `audit`. Einträge laufen der Reihe nach und werden unabhängig gespeichert. Prüfe jedes Ergebnis sowie `complete` in der Antwort. Anders als beim normalen Import ist diese Gruppe nicht atomar.

Diese APIs planen keine Synchronisation und gewähren keine Rechte auf andere Cloud-Anwendungen. Zugriff auf die Quelle und Änderungserkennung gehören zum Connector. Ein Dateihash allein identifiziert keine Bankbuchung über überlappende Berichte hinweg.

## Die gewünschten Daten exportieren

`records export <base> <table> --format csv|json --out result.csv` nutzt den berechtigungsgeprüften Abfragepfad. `--body-file` übergibt die vollständige Abfrage-/Exportkonfiguration; `--limit` begrenzt auf höchstens 10.000 Zeilen. Eine absichtlich begrenzte Abfrage ist kein vollständiger Tabellenexport. Die CLI-Befehlshilfe erklärt Trennzeichen, Markdown-Ausgabe und Zeilengrenzen.

Für wiederholbare, unveränderliche Dateien aus mehreren Datensätzen nutze [Workflow-Abfragen und Dokumentausgaben](/app/grids/help/grids-workflows). PDF, freies CSV/JSON/XML, DATEV-CSV und SEPA-XML teilen den Dokumentlebenszyklus. Eine SEPA-Datei überweist kein Geld; DATEV-CSV wird nicht automatisch in die Buchhaltungssoftware importiert.


Ein CSV-/JSON-Download ist keine vollständige Sicherung: Berechtigungen, Workflow-Zustand, Vorlagen, Anhänge und unveränderliche Historie werden dadurch nicht wiederhergestellt. Verwende [Evidence-Exporte](/app/grids/help/grids-evidence-exports) für prüfbare Nachweise und die Sicherungsprozedur des Betreibers für die Wiederherstellung nach einem Ausfall.
