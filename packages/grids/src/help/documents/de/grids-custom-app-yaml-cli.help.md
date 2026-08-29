---
id: grids-custom-app-yaml-cli
title: YAML und CLI für Grids Apps
icon: ti ti-terminal-2
description: Die kanonische App-Definition validieren, planen, anwenden, exportieren und veröffentlichen.
order: 136
---
Der visuelle Builder und die CLI lesen und schreiben dieselbe typisierte Definition einer Grids App. YAML ist ihre verlustfreie menschenlesbare Serialisierung. Es setzt vorhandene Grids-Ressourcen und die von einer Veröffentlichung bereitgestellten Capabilities zusammen. Es dupliziert weder Basisdaten noch definiert es Berechtigungen für untergeordnete Ressourcen.

## Ressourcen vor der App erstellen {icon="building-factory-2"}

Eine vollständige Lösung besitzt weiterhin eine zuständige Stelle für jeden Aspekt. Nutze die vorhandenen Befehle unter `cld grids`, um Basis, Tabellen, Felder, Ansichten, Formulare, Dokumentvorlagen, Workflow-Launcher und Zugriffsbindungen zu erstellen oder zu aktualisieren. Lies diese Ressourcen mit `--json` zurück und verwende ihre kanonischen IDs in der Definition der Grids App.

Der deterministische Ablauf für Agenten lautet:

1. Prüfe die aktuelle Basis und die installierten Grids-Referenzen.
2. Erstelle oder aktualisiere die erforderlichen Ressourcen über die jeweils zuständigen Befehle.
3. Konfiguriere Basiszugriff für Personen mit Verwaltungsrechten und Zugriff auf die Grids App für ihre Zielgruppe.
4. Schreibe das appbezogene YAML mit den zurückgegebenen kanonischen IDs.
5. Validiere, plane und wende den App-Entwurf an.
6. Öffne den gespeicherten Entwurf und durchlaufe den vollständigen Ablauf mit echten Testkonten für jede vorgesehene Zielgruppe.
7. Veröffentliche erst, wenn Plan und Ablauftests erfolgreich waren.

YAML für Grids Apps ist bewusst kein Paket für die vollständige Basis. Ein zweites Schema für Tabellen, Workflows oder Berechtigungen würde vorhandene APIs duplizieren, widersprüchliche Zuständigkeiten schaffen und Teilaktualisierungen schwerer nachvollziehbar machen. Ein Agent darf mehrere gewöhnliche Eingabedateien neben dem App-YAML aufbewahren, wendet aber jede Datei über den für diese Ressource zuständigen Befehl an.

## Mit der Maschinenreferenz beginnen {icon="book-2"}

Rufe über die CLI das installierte Schema und die unterstützten Blockverträge ab:

```bash
cld grids apps reference --json
```

Agenten sollten diese Referenz vor dem Erzeugen einer Definition lesen. Der Server bleibt maßgeblich für die installierte Schemaversion, zugängliche Ressourcen, Feldtypen und Launcher-Eingaben.

Erstelle für einen geführten Einstieg denselben leeren Startseitenentwurf wie mit **Neue App** im visuellen Builder. Exportiere und bearbeite ihn anschließend. Fortgeschrittene Personen können diesen Schritt überspringen und direkt eine vollständige Definition anwenden:

```bash
cld grids apps create MyBase --name "Certificate requests" --json
cld grids apps export MyBase "Certificate requests" --out certificate-app.yaml
```

## Ein striktes Wurzeldokument verwenden {icon="file-code"}

Jede Definition besitzt diese Form:

```yaml
schemaVersion: 5
kind: grids.custom-app
id: app001
baseId: bas001
name: Certificate requests
icon: certificate
startPageId: home
sidebar:
  actions: []
pages:
  - id: home
    title: Home
    navigation: { visible: true }
    parameters: {}
    rows:
      - id: content
        columns:
          - id: main
            span: 12
            blocks:
              - id: intro
                type: markdown
                markdown: "# Certificate requests"
```

| Schlüssel | Vertrag |
| --- | --- |
| `schemaVersion` | Erforderliche ganze Zahl. Nicht unterstützte Versionen lassen die Validierung scheitern. |
| `kind` | Muss `grids.custom-app` sein. |
| `id` | Erforderliche öffentliche ID aus sechs Zeichen. Das Angeben macht Erstellen und Anwenden idempotent. |
| `baseId` | Erforderliche öffentliche ID der einen zugehörigen Basis aus sechs Zeichen. Sie kann später nicht geändert werden. |
| `name` | Erforderlicher sichtbarer Name. |
| `icon` | Optionaler unterstützter Symbolname. |
| `startPageId` | Erforderliche lokale ID einer vorhandenen Seite. |
| `sidebar.actions` | Optionale geordnete appweite Formular-Launcher. Feste Werte akzeptieren `LITERAL`; kompatible Principal-Felder akzeptieren zusätzlich `AUTH.currentUser`. Die Verfügbarkeit besitzt keinen Seiten- oder Parameterkontext. |
| `pages` | Mindestens eine Seite. |

Fehlerhaftes YAML scheitert in der CLI, bevor eine Anfrage gesendet wird. Das strikte Schema lehnt unbekannte Schlüssel, doppelte IDs, ungültige öffentliche IDs und Werte mit falschem Typ ab.

## Seiten und Layout definieren {icon="layout-grid"}

```yaml
pages:
  - id: request
    title: Request detail
    navigation:
      visible: false
    parameters:
      request_id:
        type: record
        tableId: tbl001
        required: true
    record:
      tableId: tbl001
      id: { source: PARAMS, path: request_id }
    rows:
      - id: body
        columns:
          - id: main
            span: 8
            blocks: []
          - id: context
            span: 4
            blocks: []
```

Lokale IDs verwenden Kleinbuchstaben, Zahlen und Bindestriche. Spaltenbreiten sind ganze Zahlen von 1 bis 12 und dürfen innerhalb einer Zeile zusammen 12 nicht überschreiten.

## Typisierte Werte binden {icon="brackets"}

Bindungen sind unterscheidbare Werte:

```yaml
# A constant
{ source: LITERAL, value: Submitted }

# A declared page parameter
{ source: PARAMS, path: list_id }

# The authorized page record
{ source: RECORD, path: id }

# The current Records result row
{ source: ROW, path: id }

# A selected single relation from the current row, for row navigation
{ source: ROW, path: relation, fieldId: res301 }

# The operation that just succeeded
{ source: RESULT, path: recordId }
```

Jede Eigenschaft deklariert, welche Quellen und welchen Zieltyp sie akzeptiert. Die Validierung löst referenzierte Ressourcenschemas auf und lehnt inkompatible Bindungen vor dem Anwenden oder Veröffentlichen ab.

## Blöcke definieren {icon="blocks"}

Alle Blöcke benötigen eine lokale `id` und einen `type`. Blöcke können einen optionalen `title` und `availableWhen` unterstützen. Datensätze, Referenzierte Datensätze und Datensatz unterstützen zusätzlich `emptyText`. Ein Block vom Typ `referenced_records` ist nur auf einer Record-Seite gültig und schreibt `sourceTableId`, `relationFieldId`, `fieldIds`, `display`, `searchable`, `pageSize` und optionale `rowActions` fest. Die installierte Maschinenreferenz ist für jeden Blocktyp maßgeblich.

```yaml
# Guidance
- id: intro
  type: markdown
  markdown: |
    ## Request a certificate
    Hello @auth.name. Tell us what the certificate should cover.

# Existing saved view
- id: requests
  type: records
  searchable: true
  pageSize: 25
  source:
    kind: view
    viewId: res401
  display:
    kind: table
    columnIds:
      - res301
  rowNavigate:
    kind: navigate
    pageId: request
    history: push
    params:
      request_id: { source: ROW, path: id }
  rowActions:
    - id: approve-row
      label: Approve request
      icon: check
      showLabel: true
      kind: workflow
      launcherId: res701
      inputs:
        request_id: { source: ROW, path: id }
# Bounded inline query
- id: totals
  type: metrics
  source:
    kind: gql
    query: |
      from table "Certificate requests"
      aggregate count(*) as requests

# Grouped and bounded chart
- id: requests-by-state
  type: chart
  title: Requests by state
  chartType: bar
  source:
    kind: gql
    query: |
      from table "Certificate requests"
      group by "State"
      aggregate count(*) as requests
  limit: 20

# Existing form with server-fixed context
- id: request-form
  type: form
  formId: res501
  fixedValues: {}
  onSuccessNavigate:
    kind: navigate
    pageId: request
    params:
      request_id: { source: RESULT, path: recordId }

# Current page record with a permitted direct-edit subset
- id: request
  type: record
  fieldIds:
    - res301
  editableFieldIds:
    - res301
  documents:
    templateIds:
      - res601

# Existing HTML template field on the current page record
- id: equipment-card
  type: html
  fieldId: res701
  height: normal

# Comments on the current page record
- id: discussion
  type: comments

# Navigation and enabled workflow launchers
- id: actions
  type: actions
  actions:
    - id: approve
      label: Approve and generate
      icon: certificate
      kind: workflow
      launcherId: res701
      inputs:
        request_id: { source: RECORD, path: id }
```

`documents.templateIds` ist eine exakte Erlaubnisliste der Veröffentlichung für vorhandene generierte PDFs. Sie generiert kein Dokument. Verweise einen Aktionsblock auf einen Workflow-Launcher, wenn die Generierung zum Ablauf gehört.

Kennzahlen und Diagramm lesen eine gespeicherte Ansicht oder begrenztes Inline-GQL. Kennzahlen erfordert nicht gruppierte Aggregate. Diagramm leitet Kategorien und Werte aus gruppierter Aggregatausgabe ab und deklariert `donut`, `bar` oder `line`. Den exakten installierten Vertrag findest du unter `apps reference --json`.

Inline-GQL erhält automatisch den Kontext `@auth`, deklarierte `@params`, `@page`, `@app`, `@base` und `@time`. Unbekannte Namensräume und nicht deklarierte Seitenparameter lassen die Validierung scheitern. Werte werden getrennt vom Abfragetext gebunden und nie in ihn interpoliert.

Die Autovervollständigung kann diese exakten Schlüssel aus einer gespeicherten Entwurfsseite ableiten, ohne sie in der unmittelbaren Abfragekonsole zu aktivieren:

```bash
cld grids gql autocomplete MyBase \
  --app "Certificate requests" \
  --page request \
  --query 'where @' \
  --caret 7 \
  --json
```

Nutze einen eigenständigen Aktionsblock für seitenspezifische Navigation und Workflows. Nutze `rowActions` für bis zu sechs Workflows, die auf eine Ergebniszeile von Datensätzen oder Referenzierten Datensätzen in Tabellen- oder Kartendarstellung wirken. Karten können stattdessen schreibgeschützt sein oder nur navigieren; ein getrenntes Kartenaktionsmodell gibt es nicht. Jede Zeilenaktion besitzt eine erforderliche zugängliche Bezeichnung, darf sie nur mit vorhandenem Symbol verbergen und darf `ROW.id` an eine kompatible Datensatzeingabe binden. Die Zeilennavigation kann stattdessen ein ausgewähltes Einzelrelationsfeld an einen kompatiblen Zielseitenparameter binden. Validierung und Absendeverhalten des Formulars bleiben Eigentum des referenzierten Formulars.

Seiten, Blöcke, Formulare und Aktionen können eine serverseitig durchgesetzte Verfügbarkeitsabfrage deklarieren:

```yaml
availableWhen:
  query: |
    from table "Certificate requests"
    where record.id = @params.request_id and Status = 'Submitted'
    limit 1
```

Mindestens eine zurückgegebene Zeile bedeutet verfügbar. Ein leeres Ergebnis, eine ungültige Abfrage, fehlender Kontext, eine Zeitüberschreitung oder ein Abbruch bedeutet nicht verfügbar. Die Laufzeit lässt nicht verfügbare Ressourcen aus und prüft Formulare und Aktionen unmittelbar vor der Ausführung erneut.

## Validieren und planen {icon="list-check"}

```bash
cld grids apps validate MyBase --source-file certificate-app.yaml --json
cld grids apps plan MyBase --source-file certificate-app.yaml --json
cld grids apps apply MyBase --source-file certificate-app.yaml --dry-run --json
```

`validate` prüft Schema, IDs, Referenzen, Typen, Abfragegrenzen, Navigation und Blockinvarianten, ohne zu schreiben. `plan` führt denselben Compiler aus und vergleicht die Definition zusätzlich mit dem gespeicherten Entwurf. Seine deterministische Ausgabe enthält Aktion, konkrete Änderungen, Diagnosen und die abgeleiteten Capabilities der Veröffentlichung.

`apply --dry-run` ist eine alternative Schreibweise derselben Planoperation. Der Befehl gibt denselben `CustomAppPlan` zurück und ruft den Apply-Endpunkt nie auf. Agenten können deshalb eine einheitliche letzte Befehlsform verwenden, bevor sie `--dry-run` entfernen.

Eine fehlende oder unzugängliche Ressource ist ein Fehler und kein Anlass für eine vermutete Namensübereinstimmung. Pläne veröffentlichen nie und führen keine App-Operationen aus.

Diagnosen verwenden stabile Definitionspfade wie `pages[request].rows[detail].columns[request].blocks[actions].actions[approve].launcherId`. Korrigiere zuerst den zuständigen Pfad, validiere erneut und prüfe erst dann den neuen Plan. Agenten dürfen einen Fehler nicht durch Entfernen eines zugriffssensitiven Blocks oder Abschwächen seines Ressourcenbereichs unterdrücken, sofern die erstellende Person diese Produktänderung nicht ausdrücklich angefordert hat.

## Ohne Veröffentlichung anwenden {icon="database-import"}

```bash
cld grids apps apply MyBase --source-file certificate-app.yaml --json
```

`apply` erstellt oder aktualisiert den Entwurf mit der angegebenen öffentlichen App-ID. Das erneute Anwenden derselben kanonischen Definition ist ein No-op und erstellt keine weitere App. Der veröffentlichte Snapshot wird nie verändert.

Nutze `plan` oder `apply --dry-run`, um das Ergebnis `noop` ausdrücklich zu sehen. Ein anschließendes gewöhnliches `apply` derselben Definition lässt gespeicherte App und ihren Aktualisierungszeitpunkt unverändert.

Der Befehl läuft als angemeldetes Cloud-Konto und erfordert **Verwalten**-Zugriff auf die Basis. Er kann sich selbst keinen Zugriff auf die Basis oder Grids App gewähren.

## Exportieren und prüfen {icon="file-export"}

```bash
cld grids apps export app001 \
  --out certificate-app.yaml
cld grids apps export app001 \
  --published \
  --out certificate-app-live.yaml
```

Der Export verwendet kanonische Schlüsselreihenfolge und öffentliche Ressourcen-IDs und enthält keine Geheimnisse. Eine Bearbeitung im visuellen Builder mit anschließendem Export muss dieselbe Semantik behalten wie eine Bearbeitung über die CLI mit anschließendem Anwenden.

## Veröffentlichen {icon="rocket"}

```bash
cld grids apps publish app001 --yes --json
```

Die Veröffentlichung führt die Vorabprüfung erneut aus und ersetzt den veröffentlichten Snapshot nur bei Erfolg. Sie ist eine ausdrückliche Zustandsänderung und erfordert bei nicht interaktiver Nutzung `--yes`.

Wiederherstellen verwirft ausstehende Entwurfsänderungen und kopiert die aktive Definition zurück in den Entwurf. Veröffentlichung aufheben entfernt nur den aktiven Snapshot und behält den Entwurf. Löschen entfernt die App aus normalen Listen und ihre aktive Route. Diese destruktiven Befehle erfordern `--yes`:

```bash
cld grids apps restore app001 --yes --json
cld grids apps unpublish app001 --yes --json
cld grids apps delete app001 --yes --json
```

Die Befehlsoberfläche lautet:

```text
apps reference|list|create|get|validate|plan|apply|export|publish|unpublish|restore|delete
```

Lies [Veröffentlichen und Berechtigungen](/app/grids/help/grids-publish-custom-app), um die Zugriffsgrenze zu prüfen, bevor ein Agent eine App veröffentlicht.
