---
id: grids-workflows
title: Workflows
icon: ti ti-route
description: Wiederholbare Arbeit mit typisierten Eingaben, sicheren Aktionen und beobachtbaren Ausführungen automatisieren.
order: 140
---
Workflows führen Datensatzänderungen, Dokumente, E-Mails und HTTP-Schritte aus. Läufe behalten ihre veröffentlichte Revision und Ergebnisse; Änderungen beeinflussen keine aktiven Läufe.

Verwende Formeln für Werte, Formulare zur Erstellung und Workflows für Mehrschritt-Abläufe. Gib jedem Workflow ein klares Ergebnis.

Agents nutzen `workflow.record-actions` und `workflow.record-action` für bestätigte Korrekturentwürfe; `workflow.run.read` verfolgt den Abschluss. Weitere Workflow-Erstellung und Bedienung laufen über die CLI.

## Ersten Workflow erstellen und testen {icon="route"}

**Neuer Workflow → Datei aus einer Abfrage erstellen:** GQL prüfen, CSV/JSON/PDF/XML wählen, deaktivierten Entwurf prüfen. **Eingaben beim Start** bindet `@params.name`; Vorschauwerte werden nicht gespeichert. Die Erfassung erfolgt beim Ausführen.

DATEV-Starter benötigen ausgestellte Summen und Kontierung; SEPA-Starter finalisierte Erstattungen mit verpflichtenden eindeutigen Nummern. Ziel einrichten und Datumswerte prüfen. Dateien sind keine importierten Buchungen oder ausgeführten Zahlungen.

Name und Beschreibung erklären den Workflow. YAML definiert Eingaben, optionale Trigger und Schritte.

Dieser Workflow fragt nach einem Datensatz aus Items und ändert seinen Status:

**Einen Datensatz aktualisieren**

```yaml
inputs:
  item:
    type: record
    table: Items
steps:
  - updateRecord:
      record: inputs.item
      set:
        Status: Checked
```

:::steps
1. Öffne **Workflows** im Bearbeitungsmodus und erstelle einen Workflow.
2. Gib Name und Beschreibung außerhalb von YAML ein.
3. Ergänze die kleinste Eingabe- und Schrittdefinition, die das gewünschte Ergebnis erzeugt.
4. Speichere, bis YAML und Grids-Referenzen erfolgreich validiert werden.
5. Führe einen **dryRun** mit einer repräsentativen Eingabe aus und prüfe jede vorhergesagte Auswirkung. Ein gelb dargestellter Schritt konnte nicht geplant werden. Behebe das vor der Ausführung.
6. Führe **execute** aus und prüfe anschließend die erfolgreiche Ausführung und den geänderten Datensatz.
7. Ergänze einen automatischen Trigger oder eine Ausführungsoption erst, nachdem die direkte Ausführung korrekt funktioniert.
:::

## YAML-Vertrag verstehen {icon="code"}

Workflow-YAML ist bewusst strikt. Die Wurzelebene akzeptiert nur `inputs`, `triggers` und `steps`. Eingaben und Trigger sind optional. `steps` ist erforderlich und muss mindestens einen Schritt enthalten. Lasse einen ungenutzten Abschnitt weg, statt einen leeren Block `triggers: {}` zu schreiben.

Eingabenamen, `saveAs`-Namen, `setVariable.name` und `forEach.as`-Aliasse sind Bezeichner: Sie beginnen mit einem Buchstaben oder Unterstrich und enthalten anschließend nur Buchstaben, Ziffern und Unterstriche. Bei Namen wird Groß- und Kleinschreibung unterschieden. Ein gespeicherter Name darf weder eine Eingabe, einen anderen gespeicherten Wert oder Schleifenalias noch die reservierten Wurzeln `inputs`, `trigger`, `bindings` und `context` wiederverwenden.

Jeder Aktionsschritt enthält genau eine Aktion. Kontrollflussschritte verwenden ihre dokumentierten Schlüssel, zum Beispiel `if` mit `then` und optionalem `else`. Unbekannte Wurzelschlüssel, Eingabe-, Trigger- und Aktionseigenschaften sowie Kontrollflussschlüssel sind Fehler. Der Editor meldet sie mit Zeile und Spalte, statt sie zu ignorieren.

YAML-Maps dürfen keinen Schlüssel wiederholen. Einrückung definiert die Verschachtelung. Nutze deshalb konsistent Leerzeichen und richte benachbarte Eigenschaften gleich aus. Setze einen Wert in Anführungszeichen, wenn er Text bleiben muss, aber wie `true`, `false`, `null` oder eine Zahl aussieht. Setze Cron-Ausdrücke in Anführungszeichen, damit Leerzeichen und `*`-Zeichen zusammen einen eindeutigen Wert bilden.

## Wie Ausführungen starten {icon="square-plus"}

Execute-Läufe starten durch direkte UI-/API-/CLI-Aufrufe, gespeicherte Ausführungsoptionen (Scanner, Bulk, Datensatz oder Grids App), `schedule` oder `recordEvent`. Direkte Aufrufe und Ausführungsoptionen benötigen keinen YAML-Trigger. Automatische Trigger müssen deklariert und veröffentlicht sein. Deaktivierte Workflows lehnen Ausführungen ab; unbehandelte Ereignisse erzeugen keinen Lauf.

Ein **Testlauf ist kein Ereignis**: Er plant die neueste veröffentlichte Revision ohne Triggerprüfung, auch bei deaktiviertem Workflow.

Ausführungsoptionen stehen außerhalb des YAML. Scanner ordnen gescannten Text oder einen aufgelösten Datensatz einer Eingabe zu; weitere Eingaben können fest sein, einmalig oder nach jedem Scan abgefragt werden. Bulk liefert eine Datensatzliste. Datensatzoptionen verwenden den geöffneten Datensatz. Grids-App-Optionen verwenden feste Werte oder fragen deklarierte Eingaben ab.

## Eine Ausführung verstehen {icon="layout-grid"}

:::reference
- **Eingaben:** Typisierte Werte eines direkten Aufrufs, einer Ausführungsoption oder eines automatischen Triggers. Datensatzeingaben werden vor der Ausführung der Schritte aufgelöst.
- **Revision:** Eine Ausführung schreibt ihre Startrevision fest und führt diesen Plan bis zum Ende aus. Bearbeiten, Wiederherstellen oder Deaktivieren des Workflows verändert eine bereits laufende Ausführung nicht.
- **Schritte:** Aktionen und Kontrollfluss werden der Reihe nach ausgeführt. Ein fehlgeschlagener Schritt stoppt die Ausführung und schreibt Meldung und Fehlercode in den Ausführungsverlauf.
- **Beobachtung:** Jede Ausführung bewahrt Revision, Modus, Kanal, Eingaben, Status, Zeiten, Schrittergebnisse, Ergebnis oder Fehler und generierte Dokumente auf.
:::

Eine **Ausführung** ist erfolgreich; ein **Schritt** wird abgeschlossen. Die unterschiedlichen Begriffe sind beabsichtigt: Ein vollständig ausgeführter Schritt heißt `completed` und niemals `succeeded`. Ein Schritt, den ein Testlauf nur beschrieben hat, heißt `planned`. Lies den Status eines Schritts als Aussage über diesen Schritt, nicht als Urteil über die Ausführung.

Ein Idempotenzschlüssel identifiziert einen logischen Aufruf. Eine Wiederholung mit demselben Schlüssel verwendet ihn wieder; die Wiederverwendung für andere Eingaben wird abgelehnt. So erstellt eine unsichere Wiederholung eines Clients nicht unbemerkt eine zweite logische Ausführung. Schlüssel für tatsächliche Ausführung und Testlauf sind getrennt; derselbe Schlüssel kann einmal pro Modus verwendet werden.

### Lebenszyklus der Ausführung verfolgen

Das Starten eines Workflows erstellt sofort eine Ausführung. Öffne sie, um aktuellen Status, Fortschrittsmeldung, Eingaben, auslösende Stelle, Ausführungsoption und einzelne Schritte zu verfolgen. Eine Ausführung kann auf externe Arbeit warten, ohne als fehlgeschlagen zu erscheinen. Ihre Details benennen, worauf sie wartet.

Du kannst eine eingereihte, laufende oder wartende Ausführung abbrechen. Der Abbruch ist eine Anfrage: Der ausführende Worker bemerkt sie und wickelt seinen aktuellen Zustand ab, statt die Ausführung unter ihm zu löschen. Spätere Schritte werden gestoppt. Bereits abgeschlossene Datensatzänderungen, Dokumente, E-Mails oder HTTP-Anfragen werden nicht rückgängig gemacht. Behandle diese Auswirkungen bei Bedarf ausdrücklich.

**Erneut ausführen** öffnet den Eingabedialog mit den Eingaben der ausgewählten Ausführung und startet anschließend die aktuelle Revision des Workflows im Modus der ursprünglichen Ausführung. Prüfe die Eingaben vor dem Start, weil sich der Workflow inzwischen geändert haben kann. Öffne in den Ausführungsdetails die verknüpfte Revision, um genau zu prüfen, was eine ältere Ausführung ausgeführt hat.

Die Veröffentlichung von neuem YAML erstellt eine unveränderliche Revision. Die Revisionsnummer zählt deshalb veröffentlichte Pläne und keine Bearbeitungen. Das Umbenennen eines Workflows oder Ändern seiner Beschreibung erzeugt keine Revision. Die Wiederherstellung einer älteren Revision löscht keinen Verlauf, sondern veröffentlicht diese Definition als neue aktuelle Revision. Das Aktivieren eines Workflows mit Zeitplan- oder Datensatzereignis-Trigger erfordert eine Bestätigung, weil dadurch Arbeit ohne weiteren Klick starten kann.

## Eingabereferenz {icon="book-2"}

Jede Eingabe besitzt `type`. Optionale Texte `label` und `description` erscheinen in generierten Steuerelementen. `required: true` lehnt einen fehlenden Wert ab. Ohne `required` ist die Eingabe optional.

| Typ | Ausführungswert | Zusätzliche Deklaration |
| --- | --- | --- |
| `record` | Eine öffentliche Datensatz-ID | Erforderlicher exakter Tabellenname oder öffentliche ID unter `table` |
| `recordList` | Geordnete Liste öffentlicher Datensatz-IDs, höchstens 10.000 | Erforderlicher exakter Tabellenname oder öffentliche ID unter `table` |
| `text` | Zeichenfolge | Keine |
| `number` | Endliche Zahl | Keine |
| `boolean` | `true` oder `false` | Keine |
| `date` | Datum im Format `YYYY-MM-DD` | Keine |
| `dateTime` | ISO-Datum mit Uhrzeit | Keine |
| `select` | Zeichenfolge, die einer konfigurierten Option entspricht | Erforderliche Liste `options` mit 1 bis 200 Werten |

Datensatzeingaben werden vor der Schrittausführung gegen die gebundene Tabelle und aktuelle Leseberechtigung geprüft. Unbekannte Eingaben, fehlende Datensätze, unzugängliche Tabellen, falsche Werttypen und Werte außerhalb der Optionen einer Auswahl lehnen den Aufruf ab.

**Eingabedeklarationen (Ausschnitt)**

```yaml
inputs:
  item:
    type: record
    table: Items
    label: Item
    required: true
  labels:
    type: recordList
    table: Items
  note:
    type: text
  priority:
    type: select
    options:
      - Low
      - Normal
      - High
```

## Workflow direkt aufrufen {icon="terminal-2"}

:::reference
- **Anfrageform:** Workflow-Seite, authentifizierte API und CLI rufen denselben Workflow mit einem Eingabeobjekt, dem Modus `execute` oder `dryRun` und einem Idempotenzschlüssel auf.
- **Erwartete Revision:** Eine aufrufende Stelle kann die geladene Revision angeben. Wenn der Workflow inzwischen erneut veröffentlicht wurde, wird der Aufruf abgelehnt, statt einen der aufrufenden Stelle unbekannten Plan auszuführen.
- **Deduplizierung:** Derselbe Idempotenzschlüssel gibt die erste Ausführung zurück. Derselbe Schlüssel mit anderen Eingaben, anderem Modus, Kanal oder Akteur wird als Konflikt abgelehnt.
- **Deaktivierte Workflows:** Der tatsächliche Aufruf eines deaktivierten Workflows wird verweigert. Ein Testlauf bleibt erlaubt.
:::

Nur `schedule` und `recordEvent` gehören unter `triggers` in YAML. Ein Workflow benötigt keinen YAML-Trigger. Wenn er ausschließlich direkt oder über eine Ausführungsoption aufgerufen wird, lässt er den Block vollständig weg.

## Referenz automatischer Trigger {icon="route"}

:::reference
- **schedule:** Startet zukünftige Ausführungen über einen Cron-Ausdruck mit fünf Feldern. `timezone` ist eine optionale IANA-Zeitzone und verwendet standardmäßig UTC. Derselbe geplante Zeitpunkt erstellt höchstens eine Ausführung. Wenn ein Zeitpunkt verstreicht, während Grids nicht verfügbar ist, wird die verpasste Ausführung später nicht erstellt.
- **recordEvent:** Wird ausgeführt, wenn ein Datensatz erstellt, aktualisiert, gelöscht oder kommentiert wird. Ergänze optional eine Tabellenbeschränkung und einen Filter, der vor dem Workflow-Start passen muss.
- **Aktivierungszeitraum:** Ein Datensatzereignis startet nur dann eine Ausführung, wenn es nach der Aktivierung des Triggers stattgefunden hat. Das Aktivieren des Workflows oder Veröffentlichen eines geänderten Datensatzereignis-Triggers startet den Zeitraum neu. Frühere Änderungen werden nicht erneut eingespielt.
- **Bindungen mit with:** Ordne Triggerwerte deklarierten Workflow-Eingaben zu. Jede erforderliche Eingabe muss einen kompatiblen Wert erhalten, bevor die automatische Ausführung starten kann.
- **Triggerwerte:** Zeitpläne stellen `occurredAt` und `slot` bereit. Datensatzereignisse stellen `record`, `event` und `occurredAt` über die Wurzel `trigger` bereit.
:::

Ein Workflow darf beide Triggerarten deklarieren. Triggerbindungen dürfen nur Werte unter `trigger.*` lesen. Sie können keine Ausführungseingaben oder von Schritten erzeugten Werte lesen. Wenn ein automatischer Trigger nicht jede erforderliche Eingabe binden kann, scheitert die Validierung. Halte rein interaktive Workflows triggerfrei und starte sie direkt oder über eine Ausführungsoption.

Ein Cron-Ausdruck besitzt genau fünf Felder in dieser Reihenfolge: `minute hour day-of-month month day-of-week`. Werte verwenden Zahlen, `*`, kommagetrennte Listen, Bereiche und `/step`. Namen von Monaten und Wochentagen werden nicht akzeptiert. Minute liegt zwischen 0 und 59, Stunde zwischen 0 und 23, Monatstag zwischen 1 und 31, Monat zwischen 1 und 12 und Wochentag zwischen 0 und 7, wobei 0 und 7 beide Sonntag bedeuten. `'0 9 * * 1-5'` bedeutet zum Beispiel 09:00 Uhr von Montag bis Freitag in der gewählten Zeitzone.

**Geplanter Workflow**

```yaml
inputs:
  requestedAt:
    type: dateTime
    required: true
triggers:
  schedule:
    cron: '0 9 * * 1-5'
    timezone: Europe/Berlin
    with:
      requestedAt: ${{ trigger.slot }}
steps:
  - succeed:
      message: "Scheduled for ${{ inputs.requestedAt }}."
```

**Workflow für Datensatzereignis**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
  eventAt:
    type: dateTime
    required: true
triggers:
  recordEvent:
    event: updated
    table: Items
    filter:
      fieldId: Name
      op: contains
      value: ready
      caseInsensitive: true
    with:
      item: ${{ trigger.record }}
      eventAt: ${{ trigger.occurredAt }}
steps:
  - updateRecord:
      record: inputs.item
      set:
        Reviewed at: ${{ inputs.eventAt }}
```

:::reference
- **Filterform:** Ein Blatt verwendet `fieldId`, `op` und `value`; `fieldId` akzeptiert einen exakten Feldnamen oder eine öffentliche ID. Textblätter können zusätzlich `caseInsensitive` setzen. Kombiniere Blätter mit einer Gruppe aus `op: AND` oder `op: OR` und einer Liste `filters`. `isEmpty`, `isNotEmpty`, `today`, `thisWeek` und `thisMonth` lassen `value` weg.
- **Textoperatoren:** `equals`, `notEquals`, `contains`, `notContains`, `startsWith`, `endsWith`, `regex`, `isEmpty`, `isNotEmpty`.
- **Zahlenoperatoren:** `=`, `!=`, `<`, `<=`, `>`, `>=`, `between`, `isEmpty`, `isNotEmpty`. `between` erwartet eine Liste aus zwei Zahlen `[from, to]`.
- **Datumsoperatoren:** `=`, `notEquals`, `before`, `after`, `onOrBefore`, `onOrAfter`, `between`, `today`, `thisWeek`, `thisMonth`, `lastNDays`, `isEmpty`, `isNotEmpty`. `between` erwartet eine Liste aus zwei Werten `[from, to]`. Nutze ISO-Datumswerte, ISO-Datum-Uhrzeit-Werte mit Zeitzone für Felder mit Zeit und eine nicht negative ganze Zahl für `lastNDays`.
- **Operatoren für Boolean, Auswahl und Relation:** Boolean-Felder verwenden `=`, `isEmpty`, `isNotEmpty`. Auswahlfelder verwenden `is`, `isNot`, `isAnyOf`, `isNoneOf`, `isEmpty`, `isNotEmpty`; Listenoperatoren erwarten Arrays von Options-IDs. Relationsfelder verwenden `containsAny`, `notContainsAny`, `isEmpty`, `isNotEmpty`; Listenoperatoren erwarten nicht leere Arrays öffentlicher Datensatz-IDs.
:::

:::note Erforderliche Eingaben
Direkt aufrufende Stellen können jede deklarierte Eingabe bereitstellen. Ausführungsoptionen akzeptieren nur die Eingaben, die ihre gespeicherte Konfiguration der Person zuweist. Jeder automatische Trigger muss mit `with` alle erforderlichen Eingaben aus kompatiblen Triggerwerten bereitstellen.
:::

## Referenz für Ausführungsoptionen {icon="book-2"}

:::reference
- **Scanner:** Ordnet genau eine Text- oder Datensatzeingabe dem Scan zu. Datensatzscans werden über einen generierten Scan-Code oder ein konfiguriertes eindeutiges Feld aufgelöst. Jede weitere Workflow-Eingabe kann einmal vor dem Scannen, nach jedem Scan oder als fester Wert der Ausführungsoption abgefragt werden.
- **Bulk:** Bindet eine `recordList`-Eingabe aus ausdrücklichen Datensatz-IDs oder einer zeilenförmigen Tabellenabfrage mit höchstens 10.000 Datensätzen pro Ausführung. Der Starter **Ausgewählte Datensätze schließen** installiert ein geschütztes Profil für die exakte Auswahl. Gewöhnliche Bulk-Optionen behalten ihr normales Abfrageverhalten.
- **Datensatz:** Bindet den derzeit geöffneten Datensatz. Der Starter für einen verknüpften Folgeentwurf stellt nur auf finalisierten Datensätzen eine klar benannte Korrektur- oder Stornoaktion bereit und akzeptiert nur seinen einen Plan für verknüpfte Entwürfe.
- **Grids App:** Stellt den Workflow als Aktion in einer Grids App bereit und kann Eingabebindungen wie einen festen Berichtszeitraum speichern.
- **Lebenszyklus:** Jede Option besitzt eigenen Namen, Aktivierungsstatus, validierte Workflow-Revision und Diagnosen. Änderungen an Quellen können eine Option nicht verfügbar machen, bis sie erneut geprüft und gespeichert wird.
:::

:::note Außerhalb von YAML
Ausführungsoptionen werden getrennt von der Workflow-Quelle konfiguriert. Ein Workflow kann deshalb mehrere benannte Scanner-, Bulk-, Datensatz- oder Grids-App-Aktionen unterstützen, ohne sein YAML zu ändern. Geschützte Profile können die Darstellung an den Workflow-Vertrag binden: Eine Ausführungsoption für einen verknüpften Folgeentwurf muss dieselbe Korrektur- oder Stornoabsicht wie ihre Aktion verwenden.
:::

## Schrittreferenz {icon="book-2"}

| Schritt | Erforderliche Felder | Optionale Felder und Standardwerte | Testlauf |
| --- | --- | --- | --- |
| `query` | GQL unter `source` | Typisierte `parameters`, `saveAs` | Prüft Schema und Zugriff, erfasst keine Zeilen |
| `closeRecord` | `record` | `expectedMode`, `expectedPolicyRevision` | Sagt direkte Finalisierung oder Vier-Augen-Anfrage aus der aktuellen Tabellenrichtlinie vorher |
| `createCorrectionDraft` | `original`, `typeField`, `typeValue`, `originalField` | `intent` (Standard `correction`), `copyFields` | Validiert das finalisierte Original und sagt einen verknüpften Entwurf vorher |
| `finalizeRecord` | `record` | Keine | Validiert Schreibzugriff und sagt eine dauerhafte Finalisierung vorher |
| `updateRecord` | `record`, nicht leeres `set` | Nach UUID der Audit-Frage indizierte `audit`-Antworten | Validiert die Datensatzaktualisierung und sagt sie vorher |
| `createRecord` | `table`, nicht leere `values` | `saveAs` | Validiert den neuen Datensatz und sagt ihn vorher |
| `atomicRecords` | 1–100 `locks`, 1–50 `checks`, 1–50 `changes` | `message` der Prüfung; `ifVersion` und `audit` der Aktualisierung | Wertet aktuelle Prüfungen aus und sagt begrenzte Datensatzänderungen ohne Sperren oder Schreiben vorher |
| `generateDocument` | `template` + `record` oder `data` + `output` | `filename`, bis zu 20 `tags`, `associatedData`, `saveAs` | Validiert Zugriff und Werte; generiert nichts |
| `createDocumentLink` | Ausgabereferenz `document` | `expiresIn` (`1d`, `7d`, `30d`, `90d`; Standard `30d`), `comment`, `saveAs` | Validiert Dokument und Zugriff; erstellt keinen Link |
| `sendEmail` | `template`, 1–50 Empfänger unter `to` | `data` mit bis zu 200 Schlüsseln, `saveAs` | Validiert Vorlage, Empfänger, Daten und Zugriff; sendet nichts |
| `httpRequest` | Absolute HTTP- oder HTTPS-`url` | `method` (Standard `POST`), `headers`, `json`, `timeoutMs` (Standard 15.000; Bereich 1.000–60.000), `saveAs` | Löst das Ziel auf und prüft es; sendet nichts |
| `setVariable` | `name`, `value` | Keine | Speichert den geplanten Wert im aktuellen Bereich |
| `succeed` | `message` | Keine | Beendet die Planung mit einem erfolgreichen Endergebnis |
| `fail` | `message` | Keine | Beendet die Planung mit dem Fehler, den die Ausführung erzeugen würde |

`query` erfasst höchstens 10.000 Zeilen/5 MiB oder scheitert ohne Teilergebnis; GQL-`limit` wählt eine Teilmenge. Parameter: `{type, value}` über `@params.name`; Typen: text, number, decimal (exakte Zeichenkette), boolean, date, dateTime, record, recordList. Datensätze nutzen Workflow-Referenzen. Leeres `oneof(record.id, @params.selected)` ergibt keine Treffer. Testläufe akzeptieren geplante Datensätze, erfassen aber nichts. `saveAs` liefert Metadaten für `generateDocument.data`, keine Zeilen.

Alle Quellerfassungen teilen sich 5 MiB pro Lauf, auch in Schleifen. Wiederverwendung zählt nicht doppelt. Reduziere Zeilen/Felder oder verteile größere Exporte auf mehrere Läufe.

Spaltenumsortierung macht eine veröffentlichte Abfrage nicht ungültig. Geänderte Berechnungstypen können sie ungültig machen: Prüfe die Abfrage und veröffentliche eine neue Workflow-Revision, bevor du eine neue Ausführung startest. Ein Upgrade von nicht unterstützten Alpha-Speicherständen benötigt vor dem Deployment eine Prüfung durch den Betreiber; erneutes Veröffentlichen repariert keine Anwendung, die nicht startet.

### Dateien aus einer Abfrage erstellen

Für eine Datei aus Joins oder Gruppen verweist `associatedData: auswahl` auf
eine vorherige einfache Tabellenabfrage mit `saveAs: auswahl`. Deren eingefrorene
Datensatz-Identitäten bestimmen, bei welchen Datensätzen die Datei erscheint.
Ohne diese Angabe wird die Zuordnung nur aus eindeutigen Zeilenquellen abgeleitet.
Sie verfolgt keine Relations und ersetzt nicht die finanzielle Aktualitätsprüfung
mit `sourceVersions`. Dokumentdetails unterscheiden Datensätze und Ergebniszeilen.

Bei `generateDocument.data` schlägt der Editor vorherige Abfrageergebnisse im aktuellen Bereich vor. Nutze denselben Namen für mehrere Dateien.

Gespeicherte Werte: `data: { documents: [DOC001], columns: [{ key: number, type: text, path: [number] }] }` liest `id`, `number`, `createdAt`, `data`, `profile`, `output`. Rechnungen speichern `[output, grossAmount]` als exakte Dezimalsumme. Fehlende Pfade scheitern, auch bei alten Dokumenten ohne Output. Manuelle Snapshots: `snapshots: [SNP001]`, Pfad `[root, data, FLD001]`. Eine Zeile je ID, keine Live-Werte/Array-Auflösung. Relationsziele nach Leserecht redigiert. Grenze: 5 MiB.

Für Workflow-Werte statt GQL: `data: { columns: [{ key: amount, type: decimal }], rows: [{ amount: "12.30" }] }`.
Spalten haben feste `key`, optionale `label` und `type`; Zeilen erlauben Workflow-Ausdrücke. Typen: text, decimal (Dezimalstring), boolean, date, dateTime, json. Schlüssel und Beschriftungen müssen eindeutig sein; jede Zeile muss genau diese Schlüssel enthalten. Null ist erlaubt, fehlende Zellen nicht. Die Erfassung erhält Typen, umfasst höchstens 10.000 Zeilen/5 MiB und bleibt bei Wiederholung unverändert. Sie impliziert keinen Datensatzbezug.

Nach einer Abfrage mit `saveAs: report`:

```yaml
steps:
  - query:
      source: from table Items select Name
      saveAs: report
  - generateDocument:
      data: report
      output: { kind: csv }
      filename: report.csv
      saveAs: reportDocument
```

`data`/`output` darf nicht mit `template`/`record` kombiniert werden. Mehrere Dateischritte können dasselbe erfasste Ergebnis verwenden; eine Wiederholung eines Schritts liefert sein bestehendes Dokument. Die Erzeugung prüft Ausführungsrecht, Base-Schreibrecht und Zugriff auf die Quelltabellen erneut. Die Datei erscheint unter **Alle Dokumente** und im Workflow-Lauf. Testläufe rendern keine Dateien.

- **CSV:** UTF-8, CRLF, geordnete Aliase als Überschriften. `delimiter` erlaubt Komma (Standard), Semikolon, Tabulator (`"\t"`) oder Pipe. Null wird leer; verschachtelte Werte benötigen `nestedValues: json`. Standard `textProtection: spreadsheet` setzt vor riskante Texte, auch Telefonnummern mit `+`/`-`, ein Apostroph; der Bericht zählt Änderungen. `raw` nur verwenden, wenn der Empfänger unveränderte Texte sicher verarbeitet.
- **CSV-Spaltenauswahl:** Optional wählt und sortiert `columns: [{ source: Betrag, label: Gesamt }, { source: Name }]` exakte GQL-Aliase. Ohne `label` bleibt der Alias als Überschrift erhalten. Unbekannte oder wiederholte Quellen, eine leere Auswahl und doppelte Überschriften werden abgelehnt. Verwende Aliase, keine internen Spaltenschlüssel.
- **JSON:** `output: { kind: json }` erzeugt Zeilenobjekte mit eindeutigen Aliasen. Exakte Dezimalzahlen bleiben Zeichenketten; Arrays, Wahrheitswerte und null behalten ihren Typ.
- **JSON-Wrapper:** Optional ergänzt `wrapper: { rowsKey: items, values: { approved: "${{ inputs.approved }}" } }` typisierte Wurzelfelder neben dem Zeilenarray. `values` ist standardmäßig `{}` und darf `rowsKey` nicht enthalten. Der Feldname ist fest; Werte nutzen Workflow-Ausdrücke. Die gesamte Ausgabe darf 5 MiB nicht überschreiten.
- **PDF:** `output.kind: pdf` benötigt einen Liquid-`body`; `header`, `footer` und `css` sind optional. Der Body erlaubt 200.000 Zeichen, jeder weitere Teil 50.000. Verfügbar sind `rows`, `columns` und `document.number`/`document.createdAt`. Zellen über `row[column.key]` lesen; `column.label` ist die Überschrift. Schleifen können mehrere Zeilen samt Objektlisten-Positionen in einem PDF darstellen. Es gibt keine Live-Abfrage oder impliziten Record in diesem Kontext. Der Betreiber muss den PDF-Dienst konfigurieren.

- **XML:** `output.kind: xml` benötigt einen Liquid-`body` (bis 200.000 Zeichen) mit denselben Datenwurzeln wie PDF. Die Ausgabe ist UTF-8 XML 1.0 mit einem Wurzelelement. Werte dürfen in Text und gequoteten Attributen stehen; Namen und Namespaces müssen statisch bleiben. DTDs, CDATA, Raw-/Capture-/Comment-Blöcke in Liquid und dynamisches Markup werden abgelehnt. Statische XML-Kommentare und eine optionale statische XML-Deklaration sind erlaubt. Für das gerenderte Ergebnis gilt die gemeinsame Vorlagengrenze von 300.000 Bytes. Fehlerhaftes XML, unbekannte Entities, ungültige Namespaces oder Zeichen lassen den Schritt scheitern.

Öffentliche Download-Links unterstützen nur PDF. Freies XML prüft kein Finanzformat.

**Einen Finanzexport prüfen**

IBANs sind maskiert; **Bankdaten anzeigen** blendet sie zur Prüfung ein.

`generateDocument` akzeptiert auch `output: { kind: datev-csv, version: 1, header: ..., mapping: ... }`
oder `kind: sepa-xml`. Diese erzeugen EUR-Buchungs- oder Zahlungsdateien, keine importierten Buchungen oder ausgeführten Zahlungen.
Das DATEV-Profil verwendet 700/13, SEPA SCT pain.001.001.09 (DK GBIC 5). Die Annahme durch das Zielsystem wird nicht garantiert.
Die SEPA-Vorschau warnt vor vergangenen Daten und erweiterten Zeichen. Werte bleiben unverändert; zum Korrigieren abbrechen und neu starten.

Starte manuell; automatische Trigger dürfen keine Finanzexporte erstellen. Wähle **Export prüfen** im Lauf, der Custom-App-Aktion oder
Scanner-Protokollzeile. Prüfe Ziel, Datum, Zeilen, Summen und Abfragelimit. Bestätigungen verfallen nicht automatisch; brich unerwünschte Läufe ab.
Optional neben `data`: `sourceVersions: [{tableId: TBL001, recordId: REC001, version: 3}]` bindet gewählte Datensatzversionen.
`sourceVersions: data` übernimmt Versionen eindeutiger Zeilen einer neuen Ein-Quellen-Abfrage. Joins/fehlende Metadaten scheitern.
Änderungen verhindern Bestätigung und Ausstellung. Unterdatensätze/Lookups sind nicht rekursiv geschützt; sonst gelten erfasste Werte.

Ordne exakte GQL-Aliase den folgenden Feldern zu; Grenzen stehen in der Workflow-Referenz. Datum: `YYYY-MM-DD`; Cent-Bruchteile scheitern.
Halte `header.destinationKey` je Buchungsziel/Konto und `businessId` je Vorgang stabil: Zusammen verhindern sie Doppelexporte.
Lade das bestehende Dokument erneut herunter; umgehe die Prüfung nicht durch andere IDs. Autoren verantworten Abfragen, Joins,
Kontierung und Freigaben. Grids prüft aktuelle Rechte vor der Erzeugung erneut.

| Profil | Erforderlicher Header | Erforderliches Mapping | Optionales Mapping |
| --- | --- | --- | --- |
| `datev-csv`, `version: 1` | `destinationKey`, `consultantNumber`, `clientNumber`, `fiscalYearStart`, `accountLength`, `periodStart`, `periodEnd`, `label`, `finalize` | `businessId`, `entryId`, `amount`, `direction`, `account`, `counterAccount`, `documentDate`, `documentNumber` | `text`, `taxKey`, `costCenter1`, `costCenter2` |
| `sepa-xml`, `version: 1` | `destinationKey`, `debtorName`, `debtorIban`, `executionDate`; optional `debtorBic` | `businessId`, `endToEndId`, `amount`, `creditorName`, `creditorIban`, `remittance` | `creditorBic` |

`closeRecord` folgt dem Tabellenmodus: Direkt finalisiert; Vier-Augen fordert eine andere berechtigte Person zur Freigabe auf. Erwarteter Modus und Richtlinienrevision können eine Prüfung festschreiben. **Ausgewählte Datensätze schließen** prüft bis zu 100 exakte Datensätze. Das geschützte Profil behält bestätigte IDs statt eine Ansicht oder Abfrage neu auszuwerten. Geänderte Richtlinien oder geänderte/unvollständige Datensätze stoppen spätere Schritte; betroffene Datensätze bleiben bearbeitbar. Der Lauf zeigt abgeschlossene Schritte und Fehler.

`createCorrectionDraft` erstellt einen bearbeitbaren Datensatz derselben Tabelle, verknüpft das unveränderte finalisierte Original durch eine einzelne Selbstrelation und setzt einen vorhandenen Auswahlwert. `copyFields` kopiert bis zu 100 Wertefelder samt Leerwerten und Objektlisten-Eingaben; nur sonst gelten Standardwerte. Eindeutige Felder, generierte IDs, Dateien, andere Relationen, Berechnungen und Dokumente bleiben ausgeschlossen. Berechnete Spalten nutzen aktuelle Formeln. Nummernkreise, Mutationsrichtlinie, Zugriff, Durable History und Finalisierung gelten weiterhin. Wiederholung liefert denselben Entwurf.

Der Starter beschriftet die Aktion als **Korrektur** oder **Storno**; die Ausführungsoption muss dazu passen. Der gewählte Auswahlwert speichert diese Bedeutung. Beides erstellt verknüpfte Entwürfe zum Vervollständigen, ohne Beträge, Steuern oder Buchungen umzukehren oder Dokumente zu erzeugen.

`finalizeRecord` verwendet den allgemeinen Finalisierungsvertrag der Tabelle: Der Schritt validiert den vollständigen Datensatz, weist endgültige IDs zu, speichert die finale Durable-History-Version und sperrt den Datensatz atomar und dauerhaft. Eine Wiederholung desselben Workflow-Schritts ist sicher. Feldschlüssel unter `updateRecord` und `createRecord` akzeptieren exakte Feldnamen oder öffentliche IDs. Wenn eine Tabelle Änderungskontext verlangt, muss `updateRecord.audit` die zutreffenden Fragen anhand ihrer Frage-UUID beantworten. `generateDocument.template` und `sendEmail.template` akzeptieren den exakten Namen oder die öffentliche ID einer aktivierten Vorlage. Mehrdeutige und unzugängliche Referenzen werden bei der Validierung abgelehnt.

`finalizeRecord` umgeht keine **Vier-Augen-Finalisierung**: Fordere sie am Datensatz an; ein anderes aktuelles Mitglied der Freigabegruppe genehmigt. Der Modus Direkt erlaubt dagegen Schreibberechtigten die Finalisierung über Workflows, API, CLI und Datensatzaktionen.

### Zusammengehörige Datensatzänderungen gemeinsam festschreiben

Nutze `atomicRecords`, wenn eine aktuelle Grids-Bedingung und mehrere Schreibvorgänge an Datensätzen gemeinsam erfolgreich sein müssen. Der Schritt akzeptiert ausschließlich Grids-Datensatzarbeit. Er kann keine E-Mail senden, HTTP aufrufen, Dokumente generieren, einen anderen Workflow ausführen oder Kontrollfluss enthalten.

:::reference
- **locks:** Vorhandene Datensatzreferenzen, die in stabiler Reihenfolge gesperrt werden, bevor eine Prüfung läuft. Jeder konkurrierende Workflow muss denselben Koordinationsdatensatz für dieselbe fachliche Entscheidung sperren.
- **checks:** Jede Prüfung wählt eine gebundene Tabelle und 1 bis 20 gebundene Feldprädikate unter `where`. Prädikate verwenden `field`, `op`, optional `value` und optional `caseInsensitive` und werden mit AND kombiniert. `assert` ist `empty` oder `notEmpty`; eine optionale `message` ersetzt den Standardfehlertext.
- **changes:** Geordnete Liste aus Einträgen `createRecord` oder `updateRecord`. Erstellen verwendet `table` und nicht leere `values`. Aktualisieren verwendet `record`, nicht leeres `set`, optional `ifVersion` und optionale `audit`-Antworten.
- **transaction:** Grids prüft aktuelle Berechtigungen und Zeilenbereich erneut, sperrt jeden Koordinations- und Aktualisierungsdatensatz, wertet jede Prüfung aus und schreibt anschließend Datensätze, Relationen, Audit-Einträge, Ereignis-Outbox-Zeilen und Workflow-Ergebnis gemeinsam fest. Eine fehlgeschlagene Prüfung oder Änderung setzt alles zurück.
:::

Eine leere Abfrage besitzt keine eigene Zeile zum Sperren. Sperre bei einer Reservierung das gemeinsam verwendete Element oder einen anderen stabilen Koordinationsdatensatz und prüfe anschließend, dass keine aktive Reservierung darauf verweist. Wenn konkurrierende Workflows unterschiedliche Datensätze sperren, kann die Transaktion diese fachliche Entscheidung nicht für sie serialisieren.

Atomare Prüfungen unterstützen gespeicherte Felder, keine Formelfelder oder Aggregatberechnungen. Prüfe die zugrunde liegenden gespeicherten Werte unter derselben Sperre. Relationswerte in `createRecord` und `updateRecord` sowie Werte für Relationsfilter verwenden öffentliche Datensatz-IDs wie `${{ inputs.item.recordId }}`. Übergib keine internen UUIDs, Labels oder vollständigen Referenzobjekte als Relationswert. Datensatzziele und Sperren verwenden dagegen die Referenz selbst, etwa `inputs.item`. Verknüpfte Datensätze müssen in der konfigurierten Zieltabelle und Basis lesbar bleiben; auch der Testlauf prüft diese Grenze.

**Ein verfügbares Element atomar reservieren**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
steps:
  - atomicRecords:
      locks:
        - inputs.item
      checks:
        - table: Movements
          where:
            - field: Item
              op: containsAny
              value:
                - ${{ inputs.item.recordId }}
            - field: Type
              op: equals
              value: Active loan
          assert: empty
          message: This item is already reserved.
      changes:
        - updateRecord:
            record: inputs.item
            set:
              Status: Loaned
        - createRecord:
            table: Movements
            values:
              Item: ${{ inputs.item }}
              Type: Active loan
```

Ein Testlauf wertet die Prüfungen aus und validiert jedes Ziel, ohne Datensätze zu sperren oder zu verändern. Sein Ergebnis ist ein Hinweis: Die tatsächliche Ausführung wiederholt die Prüfungen, während die deklarierten Datensätze gesperrt sind.

Jedes Element unter `sendEmail.to` enthält genau einen Empfänger: `email` wird zu einer E-Mail-Adresse aufgelöst, `user` zu einer Cloud-Benutzer-UUID. `httpRequest.headers` akzeptiert höchstens 100 Einträge mit jeweils bis zu 1.000 Zeichen. Die URL ist auf 4.000 Zeichen begrenzt. JSON-Anfrageinhalt und Text-Antwortinhalt sind jeweils auf 64 KiB begrenzt.

`httpRequest.method` akzeptiert `GET`, `POST`, `PUT`, `PATCH` oder `DELETE` und verwendet standardmäßig `POST`. Anfragen übertragen ausschließlich JSON. Nutze `json` für einen optionalen strukturierten Inhalt, statt Formulardaten oder beliebige Binärdaten zu kodieren. Grids sendet einen aus Ausführung und Schritt abgeleiteten Header `Idempotency-Key`. Ein Empfänger, der ihn berücksichtigt, kann einen wiederholten Versuch erkennen.

**Aktionen**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
  priority:
    type: select
    options:
      - Low
      - Normal
      - High
  recipientEmail:
    type: text
    required: true
steps:
  - updateRecord:
      record: inputs.item
      set:
        Status: Available
        Last scanned at: ${{ now() }}
  - createRecord:
      table: Movements
      values:
        Item: ${{ inputs.item }}
        Type: Check-in
      saveAs: movement
  - generateDocument:
      template: Item label
      record: inputs.item
      filename: ${{ inputs.item.Name }}
      tags:
        - label
        - ${{ inputs.priority }}
      saveAs: labelRun
  - createDocumentLink:
      document: labelRun
      expiresIn: 30d
      comment: Workflow email link
      saveAs: labelLink
  - sendEmail:
      template: Label ready email
      to:
        - email: ${{ inputs.recipientEmail }}
      data:
        link: ${{ labelLink }}
        document: ${{ labelRun }}
      saveAs: emailResult
  - httpRequest:
      method: POST
      url: https://example.com/hooks/grids
      headers:
        X-App: Grids
      json:
        event: item.checked_in
        item: ${{ inputs.item }}
      timeoutMs: 15000
      saveAs: hook
  - setVariable:
      name: finishedAt
      value: ${{ now() }}
  - succeed:
      message: "${{ inputs.item.Name }} checked in."
```

## Kontrollfluss {icon="route"}

Kontrollfluss ist weiterhin ein gewöhnlicher Schritt. Dadurch bleibt verschachteltes Verhalten ausdrücklich sichtbar und Diagnosen können auf den fehlerhaften Zweig zeigen, statt die Absicht des Workflows zu erraten.

:::reference
- **if:** Erfordert eine Bedingung und eine nicht leere Liste `then`. `else` ist optional.
- **switch:** Erfordert einen Wert und mindestens einen Eintrag unter `cases`. Jeder Fall besitzt `when` und eine nicht leere Liste `do`. `default` ist optional.
- **forEach:** Erfordert eine rohe `recordList`-Referenz, einen Bezeichner unter `as` und eine nicht leere Liste `do`. Die Listenreihenfolge bleibt erhalten.
- **Wertvergleiche:** `equals` und `notEquals` erwarten genau zwei literale oder dynamische Werte.
- **Textvergleiche:** `textEquals`, `contains`, `startsWith` und `endsWith` erwarten zwei Textwerte.
- **Listenzugehörigkeit:** `includes` erwartet eine Liste und einen exakten Wert. Prüfe damit beispielsweise, ob ein Datensatz zu einer Relationsliste gehört; `contains` ist nur für Text vorgesehen.
- **Vorhandensein und Verschachtelung:** `exists` erwartet eine rohe Wertreferenz. `all` und `any` erfordern mindestens eine Bedingung. `not` umschließt eine Bedingung.
:::

**Zweige und Schleifen**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
  items:
    type: recordList
    table: Items
    required: true
  priority:
    type: select
    options:
      - Low
      - Normal
      - High
steps:
  - if:
      equals:
        - ${{ inputs.item.Status }}
        - Loaned
    then:
      - updateRecord:
          record: inputs.item
          set:
            Status: Available
    else:
      - fail:
          message: Item is not currently loaned out.
  - switch: ${{ inputs.priority }}
    cases:
      - when: High
        do:
          - setVariable:
              name: queue
              value: urgent
    default:
      - setVariable:
          name: queue
          value: normal
  - forEach: inputs.items
    as: item
    do:
      - generateDocument:
          template: Item label
          record: item
```

**Rekursive Bedingungen**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
  prefix:
    type: text
    required: true
steps:
  - if:
      all:
        - exists: inputs.item.Status
        - any:
            - equals:
                - ${{ inputs.item.Status }}
                - Loaned
            - startsWith:
                - ${{ inputs.item.Name }}
                - ${{ inputs.prefix }}
        - not:
            endsWith:
              - ${{ inputs.item.Name }}
              - Archived
    then:
      - succeed:
          message: Item matches.
    else:
      - fail:
          message: Item does not match.
```

## Werte und Referenzen {icon="book-2"}

:::reference
- **Literale Zeichenfolgen:** Gewöhnliche Zeichenfolgen sind immer literale Werte. Schreibe `Checked`, URLs, E-Mail-Adressen und Text mit Punkten direkt, wenn der Workflow genau diesen Text verwenden soll.
- **Dynamische Werte:** Ein dynamischer Wert muss die vollständige Zeichenfolge `${{ ... }}` sein. Nutze `${{ inputs.name }}`, ergänze ein Datensatzfeld wie `${{ inputs.item.Status }}`, nutze `${{ inputs.item.recordId }}` für die stabile öffentliche Datensatz-ID, lies einen gespeicherten Wert mit `${{ savedValue }}` oder werte `${{ now() }}` aus. Die Ausdruckssprache führt keine Arithmetik aus, verbindet keinen Text und ruft keine anderen Funktionen auf.
- **Eigene Referenzen:** Plätze, die nur Referenzen akzeptieren, bleiben roh: `record: inputs.item`, `forEach: inputs.items`, `document: savedDocument` und `exists: inputs.item.Field`. Umschließe diese Plätze nicht mit Ausdruckssyntax.
- **Relationsreferenzen:** Ein einzelnes Relationsfeld kann jeden rohen `record`-Platz füllen, zum Beispiel `record: inputs.asset.Current loan item`. Ein mehrfaches Relationsfeld kann `forEach` füllen, zum Beispiel `forEach: inputs.loan.Items`. Grids löst die gespeicherten IDs zu autorisierten Datensätzen in der Zieltabelle der Relation auf und lässt die Ausführung scheitern, wenn ein Ziel fehlt oder unzugänglich ist.
- **Bereich:** Eingaben stehen für die gesamte Ausführung zur Verfügung. Namen aus `saveAs` und `setVariable` stehen erst nach ihrem Schritt zur Verfügung. Ein `forEach`-Alias existiert nur in seinen `do`-Schritten. In Zweigen und Schleifen erzeugte Werte verlassen diesen Bereich nicht.
- **Ergebnismeldungen:** Meldungen von `succeed` und `fail` sind literaler Text und dürfen einen oder mehrere Ausdrücke einbetten, zum Beispiel `Processed ${{ inputs.item.Name }}`.
- **Strukturierte Werte:** Listen und Objekte dürfen Literale und dynamische Werte rekursiv enthalten. Das ist für `set`, `values`, `data` und `json` nützlich.
:::

:::note Gespeicherte Ausgabepfade
Gespeicherte Ausgaben stellen strukturierte Pfade bereit. Dokumente besitzen `id`, `shortId`, `templateId`, `baseId`, `tableId`, `recordId`, `number`, `filename`, `createdAt`, `createdBy`, `tags` und `primaryArtifactKey`. Dokumentlinks besitzen `kind`, `id`, `url`, `expiresAt` und `documentId`. E-Mail-Ergebnisse besitzen `subject`, `templateId` und `recipients`; jeder Empfänger besitzt `id`, `deliveryId`, `kind`, `recipient` und `status`. HTTP-Ergebnisse besitzen `status`, `ok` und `body`. Lies sie mit Ausdrücken wie `${{ link.url }}`, `${{ emailResult.recipients }}` oder `${{ hook.status }}`.
:::

## E-Mail-Vorlagen {icon="file-description"}

E-Mail-Vorlagen werden auf der Workflow-Seite im Bearbeitungsmodus verwaltet. Sie sind Liquid-Vorlagen auf Basisebene mit Betreff, HTML, gespeicherten Beispieldaten und Vorschau. Ein Workflow-Schritt wählt eine Vorlage und übergibt nur die für die E-Mail benötigten `data`. Beispieldaten werden ausschließlich für die Editorvorschau verwendet. Änderungen daran betreffen versendete Nachrichten nicht.

:::reference
- **Vorlagensuche:** `sendEmail.template` akzeptiert den exakten Namen oder die öffentliche ID einer aktivierten E-Mail-Vorlage. Mehrdeutige Namen werden abgelehnt.
- **Empfänger:** Nutze `email` für einen E-Mail-Adresswert oder `user` für eine Cloud-Benutzer-ID. Jeder Eintrag muss genau einen Empfängertyp wählen.
- **Liquid-Wurzeln:** Vorlagen können `data`, `app`, `business`, `workflow`, `run` und `date` lesen.
- **Vorschaudaten:** Das Beispieldaten-JSON der Vorlage erscheint unter `data`. Seine verschachtelten Schlüssel steuern außerdem Editorvorschläge. Beispiele für App, Business, Workflow, Ausführung und Datum sind nur Systemwerte der Vorschau.
:::

**Link zu einem generierten Dokument senden**

```yaml
inputs:
  invoice:
    type: record
    table: Invoices
    required: true
  recipientEmail:
    type: text
    required: true
steps:
  - generateDocument:
      template: Invoice
      record: inputs.invoice
      saveAs: invoicePdf
  - createDocumentLink:
      document: invoicePdf
      expiresIn: 30d
      saveAs: invoiceLink
  - sendEmail:
      template: Invoice email
      to:
        - email: ${{ inputs.recipientEmail }}
      data:
        link: ${{ invoiceLink }}
        document: ${{ invoicePdf }}
```

**E-Mail-HTML**

```html
<p>Hello,</p>
<p>Your document is ready.</p>
<p><a href="{{ data.link.url }}">Download PDF</a></p>
<p>{{ business.legalName | default: app.name }}</p>
```

## Ausführungsmodi und Beobachtbarkeit {icon="route"}

- `execute` führt die festgeschriebene Revision aus; `dryRun` zeichnet geplante Auswirkungen ohne Änderungen oder externe Anfragen auf.
- Kanäle: `api` für UI/API/CLI; `customApp`, `scanner`, `bulk` für Ausführungsoptionen; `schedule`, `recordEvent` für automatische Trigger.
- Laufdetails zeigen Revision, Eingaben, Zeiten, Ergebnis/Fehler, Schritte und Dokumente. Statistiken zählen execute-Läufe; Testlauffehler bleiben im Verlauf.
- Die Workflow-Seite zeigt Zeitplanabgleich, nächsten Lauf oder dauerhafte Zeitplanprobleme sowie aktive Datensatzereignis-/Tabellenbindungen.
- Auslösende Ereignisse und einzelne externe Auswirkungen findet die Cloud-Administration unter **Observability → Workflows** oder `cld admin workflows`.

Laufstatus: `queued`, `running`, `waiting`, `succeeded`, `failed`, `canceled`, `needs_attention`.
Schrittstatus: `running`, `completed`, `waiting`, `failed`, `needs_attention`, `terminal`, `planned`, `unsupported`, `indeterminate`, `canceled`.

`terminal` bezeichnet ein beendendes `succeed` oder `fail` im Testlauf; tatsächlich ausgeführtes `fail` heißt `failed`.
`planned`, `unsupported` und `indeterminate` sind Testergebnisse, keine Laufzeitfehler.
Prüfe geplante Datensätze, Vorlagen, Empfängeranzahlen und HTTP-Hosts. Anfrageinhalte bleiben verborgen; ein Testlauf garantiert keine später unveränderten Daten, Rechte oder externen Systeme.

## Eine unterbrochene Ausführung verstehen {icon="alert-triangle"}

Unterbrochene Läufe setzen anhand gespeicherter Ergebnisse fort, nicht von vorn:

- Datensatzänderungen und `createDocumentLink` werden atomar mit ihrem Ergebnis gespeichert; abgeschlossene Änderungen werden nicht wiederholt.
- `generateDocument` und `sendEmail` verwenden dieselbe Lauf-/Schrittidentität, ohne doppelte Dokumente oder Empfängerzustellungen.
- `setVariable`, `succeed`, `fail` und Kontrollfluss haben keine externen Auswirkungen und können erneut ausgewertet werden.
- Eine `httpRequest` ohne vollständige Antwort kann bereits angekommen sein. Grids stoppt mit `needs_attention`, statt zu wiederholen oder einen Fehler zu behaupten. Prüfe vor einem neuen Lauf das Zielsystem. Bevorzuge Empfänger, die `Idempotency-Key` beachten.

## Berechtigungen und Grenzen {icon="shield-lock"}

:::reference
- **Ausführungsberechtigung:** Direkte Aufrufe und eigenständige Ausführungsoptionen erfordern Schreibzugriff auf die Basis. Eine veröffentlichte Grids App darf nur ihren exakt enthaltenen Launcher aufrufen. Öffentliche Besucher dürfen keine Workflow-Aktionen ausführen.
- **Identität direkt aufrufender Ausführungen:** Direkte Aufrufe über Oberfläche, API und CLI sowie Scanner- und Bulk-Ausführungsoptionen laufen als startende Person oder startendes Dienstkonto. Ausführungsoptionen in Grids Apps verwenden die Identität der angemeldeten Person. Freigaben für Grids Apps unterstützen keine Dienstkonten. Direkte Aufrufe erscheinen im Kanal `api`.
- **Identität automatischer Ausführungen:** Zeitpläne und Datensatzereignisse laufen als verantwortliche Person des Workflows mit deren aktuellen Gruppen. Ein Datensatzereignis bewahrt die ändernde Person in den Trigger-Metadaten, übernimmt aber nicht deren Berechtigungen.
- **Aktionsberechtigung:** Unmittelbare Ausführungen verwenden die Berechtigung der zugehörigen Basis. Ein Aufruf aus einer Grids App prüft die unveränderliche App-Capability und die `availableWhen`-Regel erneut auf dem Server. Workflow-Vorbedingungen schützen weiterhin Zustand, der sich nach dem Start ändern kann.
- **App-Ergebnis:** Die aufrufende App-Aktion darf nur ihre eigene Ausführung abfragen und erhält `running`, `succeeded` oder `failed` sowie die bereinigte Ergebnismeldung des Workflows. Sie erhält weder allgemeinen Ausführungsverlauf noch rohe Fehler.
- **E-Mail-Zustellung:** Die Verwaltung von E-Mail-Vorlagen erfordert Verwaltungszugriff auf die Basis. Workflow-Ausführungen können aktivierte Vorlagen verwenden, ohne deren HTML in der Autovervollständigung offenzulegen.
- **Abhängigkeiten von E-Mail-Vorlagen:** Grids zeigt, welche Workflows eine E-Mail-Vorlage verwenden, und verweigert das Löschen einer referenzierten Vorlage. Ändere zuerst diese Workflows.
- **HTTP-Schutzregeln:** `httpRequest` erreicht ausschließlich öffentliche Internetadressen. Eine URL zu einer privaten, lokalen oder anderweitig reservierten Adresse wird verweigert. Dasselbe gilt für einen Hostnamen, der zu einer solchen Adresse auflöst, auch wenn er zusätzlich zu einer öffentlichen Adresse auflöst. Es gibt weder eine Erlaubnisliste noch eine Einstellung zum Öffnen dieser Grenze. Ein Dienst im eigenen Netzwerk kann nicht von einem Workflow aufgerufen werden.
- **HTTP-Grenzen:** `httpRequest` begrenzt Anfrage- und Antwortinhalt auf 64 KiB, wendet die konfigurierte Zeitüberschreitung auf die vollständige Anfrage einschließlich Zielauflösung an und lehnt in der URL eingebettete Anmeldedaten ab. Verbindungs- und Übertragungsheader können nicht überschrieben werden.
:::

Ein Workflow darf über alle Zweige und Schleifen höchstens 100 Eingaben und 1.000 Schritte deklarieren. Kontrollfluss und rekursive Bedingungen dürfen jeweils 20 Ebenen tief verschachtelt sein und höchstens 1.000 Bedingungen enthalten. Eine `recordList`, Bulk-Auswahl oder `forEach`-Schleife darf höchstens 10.000 Datensätze enthalten. Workflow-YAML ist auf 200.000 Zeichen begrenzt.

Dies sind Validierungs- und Ausführungsgrenzen, keine empfohlenen Entwurfsziele. Teile einen Workflow auf, bevor er sich ihnen nähert, damit eine Ausführung weiterhin einen verständlichen Zweck besitzt.

## Scanner-Beispiel {icon="point"}

**Workflow-YAML für Scanner**

```yaml
inputs:
  item:
    type: record
    table: Items
    required: true
steps:
  - if:
      equals:
        - ${{ inputs.item.Status }}
        - Loaned
    then:
      - updateRecord:
          record: inputs.item
          set:
            Status: Available
            Last scanned at: ${{ now() }}
      - succeed:
          message: "${{ inputs.item.Name }} returned."
    else:
      - fail:
          message: "${{ inputs.item.Name }} is not currently loaned out."
```

:::note Scanner-Ausführungsoption
Füge eine Scanner-Ausführungsoption hinzu, die `item` einem gescannten Datensatz zuordnet. Wähle die Auflösung über generierten Scan-Code oder konfiguriere ein eindeutiges Feld wie `Label code`. Die Option bleibt außerhalb dieses YAML.
:::

## Beispiel für Bulk-Dokumente {icon="file-description"}

**Workflow-YAML für Bulk-Dokumente**

```yaml
inputs:
  items:
    type: recordList
    table: Items
    required: true
steps:
  - forEach: inputs.items
    as: item
    do:
      - generateDocument:
          template: Item label
          record: item
```

:::note Bulk-Ausführungsoption
Füge eine Bulk-Ausführungsoption für die Datensatzlisten-Eingabe `items` hinzu. Die Option kann eine ausdrückliche Auswahl oder die aktuelle zeilenförmige Abfrage bereitstellen, ohne dem YAML einen Trigger hinzuzufügen.
:::
