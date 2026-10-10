---
id: grids-custom-app-api
title: Custom-App-API-Referenz
icon: ti ti-code
description: Schlage Definitionsoptionen, Standardwerte, Bindungen, Validierung und veröffentlichte Formular-Payloads nach.
order: 137
---
Den visuellen Ablauf beschreibt [Erste Grids App erstellen](/app/grids/help/grids-build-custom-app). Diese Seite beschreibt App-Definitionen und veröffentlichte Formular-Payloads.

Eine private App-Seite schickt abgemeldete Besucher zur Anmeldung und danach zurück zum selben Pfad samt Query. Öffentliche Apps, API- und Download-Status und der 404 für Angemeldete ohne Zugriff bleiben unverändert. Das Formularlayout beschreibt [Formulare](/app/grids/help/grids-forms).

## Den installierten Vertrag lesen {icon="code"}

`cld grids apps reference --json` oder `GET /api/grids/apps/reference` liefert `definitionSchema`. Dieses erzeugte Eingabe-JSON-Schema nennt alle Eigenschaften, Aufzählungen, Standardwerte, Pflichtschlüssel und Größengrenzen.

Führe `cld grids apps validate BASE --source-file app.yaml --json` aus, um feldübergreifende Regeln, Abfragen, Zugriff und Veröffentlichung zu prüfen. Korrigiere die Pfade in `diagnostics`. JSON Schema allein beweist nicht, dass du veröffentlichen kannst.

## Identität, Seiten und Layout festlegen {icon="layout-grid"}

Die Wurzel braucht `schemaVersion:5`, `kind:grids.custom-app`, `id`, `baseId`, `name`, `startPageId` und `pages`. Optional sind `icon` und `sidebar`. Namen haben 1–200 Zeichen. Icons sind Tabler-Slugs wie `file-invoice`, keine CSS-Klassen.

Ressourcen-IDs bestehen aus genau sechs Buchstaben oder Ziffern. Groß- und Kleinschreibung zählt. Lokale IDs für Seiten, Zeilen, Spalten, Blöcke und Aktionen beginnen mit einem Kleinbuchstaben. Sie bestehen aus Kleinbuchstaben, Ziffern und Bindestrichen, höchstens 80 Zeichen. Parameternamen verwenden Unterstriche statt Bindestrichen. IDs sind in ihrem Container eindeutig. Block-IDs sind auf der ganzen Seite eindeutig.

| Objekt | Pflicht | Optional und Standardwerte |
| --- | --- | --- |
| Seite | `id`, `title` (1–200), `rows` (1–24) | `navigation:{visible:true}`, `parameters:{}`, `record`, `availableWhen` |
| Navigation | keine | `visible:true`, `icon` |
| Parameter | `type:record`, `tableId`, `required:true` | keine anderen Typen oder Standardwerte |
| Seitendatensatz | `tableId`, `id:{source:PARAMS,path:parameter_name}` | keine |
| Zeile | `id`, `columns` (1–12) | keine |
| Spalte | `id`, `span` (ganze Zahl 1–12), `blocks` (1–24) | keine |

Eine App hat 1–12 Seiten. Die Spaltenbreiten einer Zeile ergeben zusammen höchstens 12. Die Startseite hat keine Pflichtparameter.

Für eine Datensatzseite gelten diese Regeln:

- Sie deklariert genau ihren gebundenen Datensatzparameter.
- Sie verwendet in beiden Angaben dieselbe Tabelle.
- Sie setzt `navigation.visible:false`.
- Sie enthält einen `record`- oder `html`-Block.

Andere Seiten mit Parametern sind ebenfalls reine Navigationsziele. Die Navigation muss alle Zielparameter genau einmal mit passenden Datensatztypen liefern.

## Alle Blockoptionen festlegen {icon="blocks"}

Jeder Block braucht `id` und `type`. Alle Blöcke akzeptieren optional `title` (1–160 Zeichen), `availableWhen:{query}` und `disclosure:{label,defaultOpen?}`. Abfragen haben 1–20.000 Zeichen. Lass optionale Werte weg, statt `null` einzutragen. Nur `records`, `referenced_records` und `record` unterstützen `emptyText` (1–240 Zeichen).

| `type` | Weitere Pflichtfelder | Optional und Standardwerte |
| --- | --- | --- |
| `markdown` | `markdown` (bis 20.000 Zeichen, leer erlaubt) | `disclosure:{label,defaultOpen?}` |
| `records` | `source`, `display` | `emptyText`, `searchable:true`, `pageSize:25` (5–100), `workflowStatus`, `rowNavigate`, `rowActions` (bis 6), `disclosure:{label,defaultOpen?}` |
| `referenced_records` | `sourceTableId`, `relationFieldId`, `fieldIds` (1–30), `display:{kind:table\|cards}` | `emptyText`, `searchable:true`, `pageSize:25` (5–100), `rowActions` (bis 6), `disclosure:{label,defaultOpen?}` |
| `metrics` | `source` | `valueFormat` (gemeinsames Format für alle Werte dieses Blocks), `disclosure:{label,defaultOpen?}` |
| `chart` | `source`, `chartType:donut\|bar\|line` | `subtitle` (1–200), `limit:100` (1–100), `valueFormat`, `xAxisLabel`, `yAxisLabel` (je 1–60), `disclosure:{label,defaultOpen?}` |
| `record` | `fieldIds` (1–30) | `emptyText`, `editableFieldIds:[]` (bis 30), `layout:grid\|rows\|compact\|summary\|context`, `relativeDates`, `heading:{fieldId,documentNumber?,title?}`, `documents:{templateIds:[…]}` (1–12), `disclosure:{label,defaultOpen?}` |
| `html` | `fieldId` | `height:normal` (`compact\|normal\|large`), `disclosure:{label,defaultOpen?}` |
| `comments` | keine | `disclosure:{label,defaultOpen?}` |
| `form` | `formId` | `mode:create` (`create\|edit`), `fixedValues:{}`, `onSuccessNavigate`, `actionsBlockId`, `workspace:{summaryTitle?,summaryDescription?,helpTitle?,helpText?}`, `presentation:{kind:dialog,label,icon?,variant?}`, `disclosure:{label,defaultOpen?}` |
| `actions` | `actions` (1–12) | `disclosure:{label,defaultOpen?}` |
| `scanner` | `launcherId` | `disclosure:{label,defaultOpen?}` |

`source` ist genau `{kind:view,viewId}` oder `{kind:gql,query}`. Für `records` ist `display` entweder `{kind:table,columnIds:[…]}` (bis 30) oder `{kind:cards}`.

- Eine Tabelle aus einer gespeicherten Ansicht braucht mindestens eine Spalte.
- Eine Inline-GQL-Tabelle zeigt mit `columnIds:[]` normalerweise die ausgewählten Spalten der Abfrage. Eine nichtleere Liste begrenzt die angezeigten Felder. Die ausgewählten Felder bleiben für das Verhalten verfügbar.
- Karten verwenden die Kartenkonfiguration einer gespeicherten Ansicht und können kein Inline-GQL verwenden.
- Kennzahlen brauchen ungruppierte skalare Aggregate (bis 12). Diagramme brauchen gruppierte Aggregate (bis 100 Gruppen).
- Eine App erlaubt höchstens vier Records-Blöcke, 24 Kennzahlen- und Diagrammblöcke und 24 Scanner-Blöcke.

`referenced_records`, `record`, `html` und `comments` brauchen einen gebundenen Seitendatensatz. Eingehende Relationen müssen auf dessen Tabelle zeigen. Die Record- und HTML-Blöcke einer Seite dürfen zusammen höchstens 30 unterschiedliche Felder zeigen. Bearbeitbare Felder sind eine ausdrückliche beschreibbare Teilmenge der angezeigten Felder. `documents.templateIds` erlaubt das Lesen vorhandener erzeugter Dokumente. Neue Dokumente ausstellen erlaubt es nicht. Ein `html`-Block zeigt ein vorhandenes HTML-Feld in einem isolierten Frame.

`documents.preview:true` erlaubt PDF-Vorschauen gespeicherter Entwürfe, einschließlich der abgefragten Daten der Vorlagen. Die Vorschau stellt nichts aus und reserviert keine Nummer. Die Quelle darf nur `{{ record.id }}` oder `{{ record.shortId }}` einsetzen, ohne Liquid-Filter oder -Tags. Änderungen an einer Vorlage oder am Schema der Base erfordern eine neue Veröffentlichung.

`valueFormat` braucht `style:number|integer|percent`. Optional sind `decimalPlaces` (0–20), `unit` (1–20 Zeichen) und `unitPosition:prefix|suffix`. Der Stil `integer` lehnt Nachkommastellen ab. Nur der Stil `number` akzeptiert eine eigene Einheit. Eine Einheitenposition braucht eine Einheit. Ohne diese Optionen gilt die normale Darstellung des Renderers.

## Aktionen und Bindungen konfigurieren {icon="arrows-right-left"}

Aktionen in einem `actions`-Block brauchen `id`, `label` (1–120) und `kind`. Beide Arten akzeptieren `icon` und `availableWhen`.

- `kind:navigate` braucht zusätzlich `pageId` und `params`. `history` ist standardmäßig `push` und akzeptiert auch `replace`.
- `kind:workflow` braucht zusätzlich `launcherId`. `inputs` ist standardmäßig `{}`. `confirm` liefert optional einen Bestätigungstext (1–240 Zeichen).
- Zeilenaktionen verwenden nur `kind:workflow`, mit denselben Schlüsseln und zusätzlich `showLabel:true`. `false` braucht ein Icon. Die Beschriftung bleibt für die Barrierefreiheit Pflicht.
- `rowNavigate` hat `kind:navigate`, `pageId`, `params` und optional `history:push|replace`. Es hat keine Beschriftung und keine Aktions-ID.
- `onSuccessNavigate` hat `kind:navigate`, `pageId` und `params`. Nach erfolgreichem Absenden ersetzt die Navigation den Verlaufseintrag. Eine `history`-Option gibt es hier nicht.

### Workflow-Eingaben abfragen

Binde alle erforderlichen Workflow-Eingaben oder frage sie mit `prompt: { inputs: ["date", "amount"], description?, successMessage? }` ab. Die Namen wählen ungebundene skalare Workflow-Eingaben: text, decimal, number, date, dateTime, boolean oder select. Beschriftungen und Validierung stammen aus dem veröffentlichten Workflow. Diese Aktionen öffnen einen kompakten Dialog. Ist der Ausgang unklar, behält der Dialog die gesendeten Werte und den Vorgangsschlüssel. Ein Prompt lässt sich nicht mit `confirm`, `background`, festen Launchern oder Zeilenaktionen kombinieren. Browser-Eingaben überschreiben nie Server-Bindungen.

Ein Prompt-Vorgang, der noch auf seinen Ausgang wartet, bleibt in diesem Browser-Tab auch nach dem Neuladen erhalten. Eine Statusaktion auf der ursprünglichen Seite bleibt verfügbar, auch wenn die ursprüngliche Schaltfläche verschwindet. Wiederholungen bleiben beim ursprünglichen Workflow-Launcher. Eine neue Veröffentlichung der Aktion leitet einen vorhandenen Versuch nie auf einen anderen Workflow um. Prüfe den Status, bevor du einen weiteren Vorgang startest.

:::warning Die lokale Wiederaufnahme endet mit dem Tab
Schließt du den Tab oder löschst du den Browser-Speicher, geht diese lokale Wiederaufnahme verloren. Prüfe dann die vorhandenen Einträge, bevor du erneut absendest.
:::

### Werte binden

Bindungen sind Objekte, keine Ausdrücke. Die erlaubten Quellen hängen von der Position ab:

| Position | Akzeptierte Bindungsformen |
| --- | --- |
| Navigationsaktion `params` | `{source:PARAMS,path:name}`, `{source:RECORD,path:id}` |
| Zeilennavigation `params` | `{source:ROW,path:id}`, `{source:ROW,path:relation,fieldId}`; letzteres benötigt eine ausgewählte Einfachrelation |
| Workflow `inputs` | `{source:LITERAL,value:JSON}`, `PARAMS`, `RECORD`; Zeilenaktionen zusätzlich `{source:ROW,path:id}` |
| Formular `fixedValues` | `LITERAL`, `PARAMS`, `RECORD`, `{source:AUTH,path:currentUser}` |
| Formularerfolg `params` | `PARAMS`, `{source:RESULT,path:recordId}` |
| Globale feste Werte | nur `LITERAL`, `AUTH.currentUser` |
| Globaler Formularerfolg `params` | nur `RESULT.recordId` |

Schlüssel fester Werte sind öffentliche Formularfeld-IDs. Schlüssel von Workflow-Eingaben sind die Eingabenamen des Launchers. Bindungen müssen zu ihrem Zieltyp passen. `AUTH.currentUser` braucht eine angemeldete Person und ein kompatibles Principal-Feld. Grids entfernt feste Felder aus den gesendeten Eingaben und wertet sie auf dem Server erneut aus.

`sidebar.actions` enthält bis zu zwölf globale Formularaktionen. Jede braucht `id`, `label`, `kind:form` und `formId`. Optional sind `icon`, `tone:default|success|danger` (Standard `default`), `availableWhen`, `fixedValues:{}` und `onSuccessNavigate`. Formulare der Seitenleiste erstellen immer neue Datensätze. Sie haben keinen Kontext der aktuellen Seite oder des Datensatzes.

## Verfügbarkeit und Zugriff steuern {icon="shield-lock"}

`availableWhen:{query}` gilt für Seiten, Blöcke und Aktionen. Eine Ergebniszeile bedeutet verfügbar. Ein leeres Ergebnis oder ein Fehler bedeutet nicht verfügbar. Der Server prüft Lese- und Schreibvorgänge erneut. Der typisierte Kontext ist `@auth`, die deklarierten `@params`, `@page`, `@app`, `@base` und `@time`. Globale Abfragen der Seitenleiste können keinen Seiten- oder Parameterkontext verwenden. Die Syntax beschreibt [GQL](/app/grids/help/grids-gql).

Das Erstellen einer App braucht Zugriff **Verwalten** auf die Base. Personen, die die App verwenden, erhalten nur die veröffentlichten Bereiche, keinen direkten Zugriff auf die Base. Workflow-Aktionen und Scanner erfordern eine Anmeldung. Alle Schreibvorgänge behalten die Prüfungen für Zugriff, Finalisierung und Änderungsrichtlinie zur Laufzeit. Ausgeblendete Navigation ist keine Zugriffskontrolle.

## Formulare über die API absenden und bearbeiten {icon="forms"}

Führe zuerst `cld grids apps runtime read APP --page PAGE --params '{"item_id":"REC001"}' --json` aus. Das `form`-Ergebnis jedes Formularblocks enthält `form`, `fields`, `inlineTargetFields`, `submitUrl` und im Bearbeitungsmodus `initialRecord`. Gib dieselben Seitenparameter mit, wenn du `apps runtime submit APP PAGE BLOCK --body-file submission.json --yes` aufrufst.

Erstellen akzeptiert ein Feld-Wert-Objekt oder `{data,inlineCreates?,idempotencyKey?}`. Bearbeiten braucht `{data,version,idempotencyKey,inlineCreates?,inlineUpdates?}`. Schlüssel in `data` sind öffentliche Feld-IDs. Relationswerte sind öffentliche Datensatz-IDs oder temporäre IDs, die `inlineCreates` deklariert.

Eine `object_list` ist ein Feldwert, keine Relation: `{"data":{"ITEMS1":[{"Label1":"Beratung","Amount":"19.95"}]}}`. Spalten-IDs und Regeln findest du in `fields[].config`. Sende exakte Dezimalwerte als Strings und lass berechnete Zellen weg. Das Senden der Liste ersetzt alle ihre Zeilen. `[]` leert sie, falls erlaubt. `inlineCreates` brauchst du nicht. Siehe [Listenregeln und Formeln](/app/grids/help/grids-tables-fields).

```json
{
  "version": 3,
  "idempotencyKey": "edit-invoice-unique-attempt",
  "data": {"TITLE1": "Consulting", "LINES1": ["LINE01", "tmp_new"]},
  "inlineUpdates": {"LINES1": [{"recordId": "LINE01", "version": 2, "data": {"TEXT01": "Consulting day"}}]},
  "inlineCreates": {"LINES1": [{"tempId": "tmp_new", "data": {"TEXT01": "Travel"}}]}
}
```

Verwende die ermittelten IDs und vollständige Formularwerte. Behalte Pflichtwerte bei und sende ausdrückliche Leerwerte, um einen Wert zu leeren. Verknüpfte Eingaben erlauben nur `inlineCreate.fields`, höchstens 20 Neuanlagen oder Änderungen je Relation und 50 insgesamt. Bearbeitete untergeordnete Datensätze müssen ausschließlich mit diesem übergeordneten Datensatz in derselben Base verknüpft bleiben. Das Lösen einer Verknüpfung löscht keine untergeordneten Datensätze. Finalisierte Datensätze sind schreibgeschützt. Alle Änderungen werden gemeinsam gespeichert oder zurückgerollt.

`initialRecord` enthält die `version` des übergeordneten Datensatzes, die bearbeitbaren `values` und Entwürfe in `inlineCreates` mit `{tempId,data,existing:{id,version}}`. Ersetze vorhandene temporäre Verweise durch `existing.id`. Sende Änderungen an vorhandenen Datensätzen als `inlineUpdates` und nur neue Entwürfe als `inlineCreates`. `initialRecord` ist kein Schreib-Payload.

Der Server bestimmt das Bearbeitungsziel aus dem gebundenen Seitendatensatz, nie aus einer `recordId` im Body. Für Personen mit Zugriff **Bearbeiten** auf die Base ist das Gegenstück `cld grids forms submit BASE TABLE FORM --record REC001 --body-file submission.json --yes`, mit aktuellen Versionen aus `records show`. Der HTTP-Endpunkt ist `POST /api/grids/forms/FORM/records/REC001`. Erstellen verwendet `POST /api/grids/forms/FORM/submit`.

### Sicher wiederholen

:::reference
- **Schlüssel:** Nicht leer, höchstens 200 Zeichen, ohne NUL. Ein Schlüssel gilt für die Kombination aus Formular, Tabelle und Akteur.
- **Exakte Wiederholung:** Liefert die ursprüngliche Datensatz-ID und schreibt nichts erneut.
- **Konflikt (`409`):** Ein geänderter Payload, ein gelöschtes Ergebnis oder eine veraltete Version.
- **Zeitüberschreitung:** Wiederhole denselben Body mit demselben Schlüssel oder prüfe das Ergebnis. Ein Erstellen ohne Schlüssel kann doppelt laufen.
- **Bestätigte veraltete Version:** Lade neu und prüfe die Daten vor einem neuen Versuch.
- **Nicht gespeichert:** Validierungsfehler (`400`/`422`) und Zugriffsfehler (`401`/`403`/`404`).
- **Erfolg:** Erstellen liefert `201`, Bearbeiten `200`, jeweils mit `recordId` und der optionalen Erfolgsnavigation der App.
:::

### Dokumentaktionen im Hintergrund ausführen

Workflow-Aktionen können `background: { acceptedMessage, documentBlockId, documentTemplateId }` setzen. Dafür braucht die Seite einen Datensatz und einen bedingungslos verfügbaren Datensatzblock, der diese Vorlage zeigt. Jede Seite hat eine Ergebnisvorlage für Hintergrundaktionen. `GET` auf dem Aktionsendpunkt liest den aktuellen Dokumentstatus. `POST` bestätigt die Annahme sofort. Diese Aktionen liefern die Dokumentdarstellung statt einer Lauf-ID. Nur Personen, die die App aktuell verwenden dürfen, können diese Darstellung lesen. `needs_attention` verhindert einen weiteren Start. Ein fertiges Dokument öffnet sich direkt. Siehe [Seiten und Blöcke in Grids Apps](/app/grids/help/grids-custom-app-pages-blocks).
