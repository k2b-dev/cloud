---
id: grids-custom-app-api
title: Custom-App-API-Referenz
icon: ti ti-code
description: Definitionsoptionen, Standardwerte, Bindungen, Validierung und Formular-Payloads.
order: 137
---
Den visuellen Ablauf beschreibt [Custom App bauen](/app/grids/help/grids-build-custom-app). Hier stehen App-Definitionen und veröffentlichte Formular-Payloads.

Private App-Seiten führen ausgeloggte Besucher zum Login, danach zum selben Pfad samt Query. Öffentliche Apps, API-/Download-Status und 404 für Angemeldete ohne Zugriff bleiben unverändert. Siehe [Formularlayout](/app/grids/help/grids-forms).

## Installierten Vertrag lesen {icon="code"}

`cld grids apps reference --json` oder `GET /api/grids/apps/reference` liefert `definitionSchema`: das erzeugte Eingabe-JSON-Schema mit allen Eigenschaften, Pflichtfeldern, Aufzählungen, Standardwerten und Größenlimits.

`cld grids apps validate BASE --source-file app.yaml --json` prüft übergreifende Regeln, Abfragen, Zugriffe und Veröffentlichung. Die Pfade in `diagnostics` korrigieren; JSON Schema allein beweist keine Veröffentlichbarkeit.

## Identität, Seiten und Layout {icon="layout-grid"}

Die Wurzel benötigt `schemaVersion:5`, `kind:grids.custom-app`, `id`, `baseId`, `name`, `startPageId` und `pages`. Optional sind `icon` und `sidebar`. Namen haben 1–200 Zeichen. Icons sind Tabler-Slugs wie `file-invoice`, keine CSS-Klassen.

Ressourcen-IDs bestehen aus genau sechs Buchstaben/Ziffern; Groß-/Kleinschreibung zählt. Lokale Seiten-, Zeilen-, Spalten-, Block- und Aktions-IDs beginnen mit einem Kleinbuchstaben und erlauben Kleinbuchstaben, Ziffern und Bindestriche, maximal 80 Zeichen. Parameternamen verwenden stattdessen Unterstriche. IDs sind im jeweiligen Container eindeutig; Block-IDs gelten für die gesamte Seite.

| Objekt | Pflicht | Optional und Standardwerte |
| --- | --- | --- |
| Seite | `id`, `title` (1–200), `rows` (1–24) | `navigation:{visible:true}`, `parameters:{}`, `record`, `availableWhen` |
| Navigation | keine | `visible:true`, `icon` |
| Parameter | `type:record`, `tableId`, `required:true` | keine anderen Typen oder Standardwerte |
| Seitendatensatz | `tableId`, `id:{source:PARAMS,path:parameter_name}` | keine |
| Zeile | `id`, `columns` (1–12) | keine |
| Spalte | `id`, `span` (ganze Zahl 1–12), `blocks` (1–24) | keine |

Eine App hat 1–12 Seiten. Spaltenbreiten ergeben je Zeile höchstens 12. Die Startseite benötigt keine Parameter. Eine Datensatzseite deklariert genau ihren gebundenen Datensatzparameter, verwendet in beiden Angaben dieselbe Tabelle, setzt `navigation.visible:false` und enthält einen `record`- oder `html`-Block. Auch andere parametrisierte Seiten sind reine Navigationsziele. Navigation muss alle Zielparameter genau einmal mit passenden Datensatztypen liefern.

## Sämtliche Blockoptionen {icon="blocks"}

Jeder Block benötigt `id` und `type`. Alle unterstützen optional `title` (1–160 Zeichen) und `availableWhen:{query}` und `disclosure:{label,defaultOpen?}`. Abfragen haben 1–20.000 Zeichen. Optionale Werte weglassen statt `null` einzutragen. `emptyText` (1–240 Zeichen) unterstützen nur `records`, `referenced_records` und `record`.

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

`source` ist genau `{kind:view,viewId}` oder `{kind:gql,query}`. Für `records` ist `display` entweder `{kind:table,columnIds:[…]}` (bis 30) oder `{kind:cards}`. Tabellen aus gespeicherten Ansichten benötigen mindestens eine Spalte; Inline-GQL zeigt mit `columnIds:[]` seine ausgewählten Spalten; eine nichtleere Liste begrenzt die sichtbaren Felder, während ausgewählte Felder für Verhalten verfügbar bleiben. Karten übernehmen die Kartenkonfiguration einer gespeicherten Ansicht; Inline-GQL ist dafür nicht möglich. Kennzahlen benötigen ungruppierte skalare Aggregate (bis 12); Diagramme gruppierte Aggregate (bis 100 Gruppen). Pro App sind höchstens vier Records-Blöcke, 24 Kennzahlen-/Diagrammblöcke und 24 Scanner-Blöcke erlaubt.

`referenced_records`, `record`, `html` und `comments` benötigen einen gebundenen Seitendatensatz. Eingehende Relationen müssen auf dessen Tabelle zeigen. Record-/HTML-Blöcke einer Seite dürfen zusammen höchstens 30 unterschiedliche Felder zeigen. `editableFieldIds` ist eine explizite beschreibbare Teilmenge der angezeigten Felder. `documents.templateIds` erlaubt vorhandene Dokumente zu lesen, nicht neue zu erzeugen. `html` zeigt ein vorhandenes HTML-Feld in einem isolierten Frame.

`documents.preview:true` erlaubt PDF-Vorschauen gespeicherter Entwürfe samt Vorlagendaten, ohne Ausstellung oder Nummernreservierung. Die Quelle darf nur `{{ record.id }}` oder `{{ record.shortId }}` einsetzen, ohne Liquid-Filter/Tags. Vorlagen- oder Base-Schemaänderungen erfordern erneutes Veröffentlichen.

`valueFormat` benötigt `style:number|integer|percent`; optional sind `decimalPlaces` (0–20), `unit` (1–20 Zeichen) und `unitPosition:prefix|suffix`. Ganzzahlen erlauben keine Nachkommastellen; nur `number` erlaubt eine eigene Einheit; deren Position benötigt eine Einheit. Ohne diese Optionen gilt die normale Darstellung des Renderers.

## Aktionen und Bindungen {icon="arrows-right-left"}

Aktionen im `actions`-Block benötigen `id`, `label` (1–120) und `kind`. Beide Arten unterstützen `icon` und `availableWhen`.

- `kind:navigate` benötigt zusätzlich `pageId` und `params`; `history` ist standardmäßig `push`, alternativ `replace`.
- `kind:workflow` benötigt `launcherId`; `inputs` ist standardmäßig `{}`. `confirm` ist optionaler Bestätigungstext (1–240 Zeichen). Binde alle erforderlichen Workflow-Eingaben oder frage sie über `prompt: { inputs: ["date", "amount"], description?, successMessage? }` ab. Die Namen wählen ungebundene skalare Workflow-Eingaben (text, decimal, number, date, dateTime, boolean oder select); Beschriftungen und Validierung stammen aus dem veröffentlichten Workflow. Diese Aktionen öffnen einen kompakten Dialog. Bei unklarem Ausgang bleiben Eingaben und Vorgangsschlüssel für Wiederholungen erhalten. Ein Prompt ist nicht mit `confirm`, `background`, festen Launchern oder Zeilenaktionen kombinierbar. Browser-Eingaben überschreiben niemals Server-Bindungen.
- Zeilenaktionen erlauben nur `kind:workflow`, mit denselben Feldern und zusätzlich `showLabel:true`. `false` benötigt ein Icon; die Beschriftung bleibt für Barrierefreiheit erforderlich.
- `rowNavigate` enthält `kind:navigate`, `pageId`, `params` und optional `history:push|replace`, keine Beschriftung oder Aktions-ID.
- `onSuccessNavigate` enthält `kind:navigate`, `pageId` und `params`. Nach Erfolg wird die Navigation ersetzt; eine `history`-Option gibt es hier nicht.

Dialog-Vorgänge mit unklarem Ausgang bleiben in diesem Browser-Tab auch nach dem Neuladen erhalten. Auf der ursprünglichen Seite kannst du ihren Status prüfen, auch wenn der ursprüngliche Button nicht mehr angezeigt wird. Wiederholungen bleiben an den ursprünglichen Workflow-Starter gebunden; eine neu veröffentlichte Aktion leitet einen vorhandenen Versuch nicht auf einen anderen Workflow um. Prüfe den Status vor einer weiteren Erfassung. Beim Schließen des Tabs oder Löschen des Browser-Speichers geht diese lokale Wiederaufnahme verloren; prüfe dann die vorhandenen Einträge vor einer erneuten Erfassung.

Bindungen sind Objekte, keine Ausdrücke. Erlaubte Quellen hängen von ihrer Position ab:

| Position | Akzeptierte Bindungsformen |
| --- | --- |
| Navigationsaktion `params` | `{source:PARAMS,path:name}`, `{source:RECORD,path:id}` |
| Zeilennavigation `params` | `{source:ROW,path:id}`, `{source:ROW,path:relation,fieldId}`; letzteres benötigt eine ausgewählte Einfachrelation |
| Workflow `inputs` | `{source:LITERAL,value:JSON}`, `PARAMS`, `RECORD`; Zeilenaktionen zusätzlich `{source:ROW,path:id}` |
| Formular `fixedValues` | `LITERAL`, `PARAMS`, `RECORD`, `{source:AUTH,path:currentUser}` |
| Formularerfolg `params` | `PARAMS`, `{source:RESULT,path:recordId}` |
| Globale feste Werte | nur `LITERAL`, `AUTH.currentUser` |
| Globaler Formularerfolg `params` | nur `RESULT.recordId` |

Schlüssel fester Werte sind öffentliche Formularfeld-IDs; Workflow-Schlüssel sind Eingabenamen des Launchers. Bindungen müssen zum Zieltyp passen. `AUTH.currentUser` benötigt eine Anmeldung und ein kompatibles Principal-Feld. Feste Felder werden aus den Eingaben entfernt und serverseitig erneut ausgewertet.

`sidebar.actions` enthält bis zu zwölf globale Formularaktionen. Pflicht: `id`, `label`, `kind:form`, `formId`. Optional: `icon`, `tone:default|success|danger` (Standard `default`), `availableWhen`, `fixedValues:{}`, `onSuccessNavigate`. Globale Formulare legen immer neue Datensätze an; sie besitzen keinen Seiten-/Datensatzkontext.

## Verfügbarkeit und Berechtigungen {icon="shield-lock"}

`availableWhen:{query}` gilt für Seiten, Blöcke und Aktionen. Eine Ergebniszeile bedeutet verfügbar; leere Ergebnisse oder Fehler bedeuten nicht verfügbar. Der Server prüft Lese- und Schreibzugriffe erneut. Kontext: `@auth`, deklarierte `@params`, `@page`, `@app`, `@base`, `@time`. Globale Aktionen erlauben keinen Seiten-/Parameterkontext. Syntax: [GQL](/app/grids/help/grids-gql).

App-Entwicklung benötigt Base Admin. App-Leser erhalten nur veröffentlichte Bereiche, keinen rohen Base-Zugriff. Workflow-Aktionen und Scanner benötigen Anmeldung. Schreibzugriffe behalten Berechtigungs-, Finalisierungs- und Schreibregelprüfungen. Versteckte Navigation ist keine Zugriffskontrolle.

## Formulare per API ausfüllen und bearbeiten {icon="forms"}

Zuerst `cld grids apps runtime read APP --page PAGE --params '{"item_id":"REC001"}' --json` lesen. Das `form`-Ergebnis eines Formularblocks enthält `form`, `fields`, `inlineTargetFields`, `submitUrl` und im Bearbeitungsmodus `initialRecord`. Beim Aufruf von `apps runtime submit APP PAGE BLOCK --body-file submission.json --yes` dieselben Seitenparameter mitgeben.

Anlegen akzeptiert ein Feld-Wert-Objekt oder `{data,inlineCreates?,idempotencyKey?}`. Bearbeiten benötigt `{data,version,idempotencyKey,inlineCreates?,inlineUpdates?}`. Schlüssel in `data` sind öffentliche Feld-IDs; Relationswerte sind öffentliche Datensatz-IDs oder unter `inlineCreates` deklarierte temporäre IDs.

Eine `object_list` ist ein Feldwert, keine Relation: `{"data":{"ITEMS1":[{"Label1":"Beratung","Amount":"19.95"}]}}`. Spalten-IDs und Regeln stehen in `fields[].config`. Exakte Dezimalwerte als Strings senden, berechnete Zellen weglassen. Die Liste ersetzt alle Zeilen; `[]` leert sie, falls erlaubt. Kein `inlineCreates` nötig. Siehe [Listenregeln und Formeln](/app/grids/help/grids-tables-fields).

```json
{
  "version": 3,
  "idempotencyKey": "edit-invoice-unique-attempt",
  "data": {"TITLE1": "Consulting", "LINES1": ["LINE01", "tmp_new"]},
  "inlineUpdates": {"LINES1": [{"recordId": "LINE01", "version": 2, "data": {"TEXT01": "Consulting day"}}]},
  "inlineCreates": {"LINES1": [{"tempId": "tmp_new", "data": {"TEXT01": "Travel"}}]}
}
```

Ermittelte IDs und vollständige Formularwerte verwenden: Pflichtwerte beibehalten, zum Leeren explizite Leerwerte senden. Verknüpfte Eingaben erlauben nur `inlineCreate.fields`, höchstens 20 Änderungen/Neuanlagen je Relation und 50 insgesamt. Bearbeitete Kinder bleiben exklusiv bei diesem Eltern-Datensatz in derselben Base verknüpft. Entfernen löscht keine Kinder. Finalisierte Datensätze bleiben gesperrt. Alle Änderungen werden gemeinsam gespeichert oder zurückgerollt.

`initialRecord` enthält Elternversion `version`, Eingaben `values` und vorausgefüllte Einträge in `inlineCreates` mit `{tempId,data,existing:{id,version}}`. Bestehende temporäre Verweise durch `existing.id` ersetzen; vorhandene Änderungen als `inlineUpdates`, nur neue als `inlineCreates` senden. Dies ist kein Schreib-Payload.

Der Server bestimmt das Bearbeitungsziel aus dem Seitendatensatz, niemals aus einer `recordId` im Body. Base-Schreiber verwenden entsprechend `cld grids forms submit BASE TABLE FORM --record REC001 --body-file submission.json --yes`, mit aktuellen Versionen aus `records get`. HTTP: `POST /api/grids/forms/FORM/records/REC001`; Anlegen: `POST /api/grids/forms/FORM/submit`.

Schlüssel: nichtleer, höchstens 200 Zeichen, ohne NUL; Gültigkeit je Formular/Tabelle und Akteur. Exakte Wiederholungen liefern dieselbe Datensatz-ID ohne weitere Änderung. Andere Payloads, gelöschte Ergebnisse oder alte Versionen ergeben `409`. Nach Timeouts denselben Body/Schlüssel wiederholen oder Ergebnis prüfen; ohne Schlüssel drohen Duplikate. Nach bestätigten Versionskonflikten neu laden und prüfen. Validierungsfehler (`400`/`422`) und Zugriffsfehler (`401`/`403`/`404`) sind keine Speicherung. Anlegen liefert `201`, Bearbeiten `200`, mit `recordId` und optionaler App-Erfolgsnavigation.

### Dokumentaktionen im Hintergrund

Workflow-Aktionen können `background: { acceptedMessage, documentBlockId,
documentTemplateId }` setzen. Dafür braucht die Seite einen Datensatz und einen
uneingeschränkt verfügbaren Datensatzblock mit dieser Dokumentvorlage. Pro Seite
ist eine Ergebnisvorlage vorgesehen. `GET` auf dem Aktionsendpunkt liest den
aktuellen Dokumentstatus; `POST` bestätigt die Annahme direkt. Diese Aktionen
liefern den Dokumentstatus statt einer Workflow-Lauf-ID. Nur aktuell berechtigte
App-Leser dürfen ihn sehen. Bei `needs_attention` ist kein weiterer Start möglich;
ein fertiges Dokument wird direkt geöffnet.
