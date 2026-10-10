---
id: grids-field-configuration
title: Feldkonfiguration nachschlagen
icon: ti ti-adjustments
description: Schlage Feldtypen, Optionen, erzeugte IDs, Standardwerte und Spalten von Objektlisten nach, wenn du eine Base konfigurierst.
order: 111
---
Nutze diese Referenz, wenn du ein Feld über CLI oder API konfigurierst. Zur Auswahl eines Felds lies [Tabellen und Felder](/app/grids/help/grids-tables-fields). `cld grids fields types --json` liefert den aktuellen Katalog, `cld grids fields type <type> --json` einen einzelnen Typ. Leite die Konfiguration nicht aus der angezeigten Bezeichnung eines Felds ab.

## Gemeinsame Optionen festlegen {icon="settings"}

Ein Feld hat diese Optionen:

- `name`: 1–200 Zeichen;
- `description`: optional, bis 2.000 Zeichen;
- `icon`: bis 200 Zeichen;
- `position`: eine Ganzzahl;
- die Schalter `required`, `presentable` und `hideInTable`, standardmäßig false.

Namen sind innerhalb der Tabelle eindeutig. Grids ignoriert beim Vergleich Groß- und Kleinschreibung und umgebende Leerzeichen. Das Anzeigefeld liefert die Datensatzbezeichnung. Den Zugriff ändert es nicht.

`type` ist nach dem Anlegen fest. Ein Update von `config` ersetzt die ganze Konfiguration. Fehlende Unteroptionen ergänzt es nicht. Verwende in APIs öffentliche Feld- und Tabellen-IDs. Eine Bezeichnung in einem Beispiel ist keine ID.

`defaultValue` ist ein typisierter Standard für ausgelassene Werte neuer Datensätze. Ein ausdrückliches `0` oder `false` ist ein Wert, keine fehlende Angabe. `null` bedeutet, dass kein Standard konfiguriert ist. Datumsfelder akzeptieren zusätzlich `{"kind":"now"}`. Standardwerte ändern bestehende Datensätze nie.

`indexed` gibt es für Text, Langtext, ID, Zahl, Prozent, Dauer, Datum, Boolean und Einfachauswahl. `uniqueConstraint` gibt es für Text, Langtext, Zahl, Prozent, Datum, Boolean und ID. Lege Indizes nur für echte Abfragemuster an, weil sie jeden Schreibvorgang aufwendiger machen.

## Eingegebene Werte konfigurieren {icon="edit"}

| `type` | Optionen in `config` und Standards |
| --- | --- |
| `text` | `minLength` ≥ 0, `maxLength` ≥ 1, `regex`, `multiline` (false). Grids entfernt umgebende Leerzeichen. |
| `longtext` | `minLength`, `maxLength`, `regex`, `markdown`. Behält Leerzeichen und Umbrüche. |
| `number` | `min`, `max` als Dezimalstring oder Zahl; `precision` 1–38; `decimalPlaces` 0–20; `integerOnly`; `unit` 1–20 Zeichen; `unitPosition: "prefix" \| "suffix"`. Dezimalwerte bleiben Strings. Zu viele Stellen lehnt Grids ab und rundet nie still. |
| `boolean` | `{}`. Speichert true, false oder bei optionalen Feldern null. |
| `date` | `includeTime` (false), `min`, `max`. Reine Daten verwenden `YYYY-MM-DD`. Zeitpunkte enthalten eine Zeitzone. |
| `select` | Pflicht: `options: [{id, label, color?, description?}]`; `multiple` (false); `minSelected` ≥ 0; `maxSelected` ≥ 1. Werte sind Arrays von Options-IDs, auch bei Einfachauswahl. |
| `principal` | `cardinality: "single" \| "multiple"` (multiple). Werte sind Arrays typisierter Referenzen auf Cloud-Nutzer oder -Gruppen mit UUIDs, höchstens 100. Die Auswahl zeigt nur Identitäten, die die Person sehen kann. |
| `percent` | `range: "percent" \| "fraction"` (percent), `decimals` 0–8 (2). Fraction 0.19 und percent 19 zeigen beide 19 %. In Formeln zählt die gespeicherte Skala. |
| `duration` | `unit: "seconds" \| "minutes" \| "hours"`. Werte sind nichtnegative Sekunden. Grids rundet numerische Eingaben auf ganze Sekunden. Akzeptiert auch `HH:MM:SS` und `MM:SS`. Die Anzeigeeinheit ändert die Speichereinheit nicht. |
| `json` | `{}`. Beliebiger gültiger JSON-Wert. Seine Eigenschaften haben kein deklariertes Grids-Feldschema. Grids liest eine String-Eingabe als JSON-Text. |
| `file` | `maxFiles` 1–100, wenn gesetzt; `accept` mit bis zu 100 MIME-Typen, MIME-Wildcards oder Dateiendungen. Hochladen und Entfernen nutzen die Dateivorgänge, keine JSON-Schreibvorgänge am Datensatz. |
| `object_list` | Siehe den Spaltenvertrag weiter unten. |

Ein Principal-Wert ist etwa `[{"type":"user","id":"<user-uuid>"}]` oder eine `group`-Referenz. Eine Identität in einem Feld ist ein Wert. Sie **gibt keinen Zugriff**. Um die aktuelle Person sicher einzutragen, nutze die konfigurierte Übermittlung einer veröffentlichten App, kein Eingabefeld, das die Person ändern kann.

## Relationen und berechnete Werte konfigurieren {icon="link"}

| `type` | `config` |
| --- | --- |
| `relation` | `targetTableId`, `cardinality: "single" \| "multiple"` (multiple). Werte sind Arrays öffentlicher Datensatz-IDs. |
| `lookup` | `relationFieldId`, `targetFieldId`, optional `format`. Liest verknüpfte Werte. Kopiert sie nicht in eine bearbeitbare Eingabe. |
| `rollup` | `relationFieldId`, `targetFieldId`, `agg: "count" \| "sum" \| "avg" \| "min" \| "max"`, optional `format`. |
| `formula` | `expression`, optional `format`. Siehe [Formeln](/app/grids/help/grids-formulas), auch für exakte Dezimalrechnung und typisierte Vergleiche mit Auswahlfeldern. |
| `html_template` | `template` (bis 50 KiB), `css` (bis 32 KiB; 200 Regeln und 1.000 Deklarationen). Liquid-Wurzeln: `record`, `table`, `app`, `business`, `date`. Ausgabe bis 300 KiB, isoliert und schreibgeschützt. |

Schreibvorgänge an Datensätzen können keine berechneten Werte liefern. Lookups und Rollups folgen dem Zugriff auf die Daten. Beim Finalisieren eines Datensatzes friert Grids die unterstützten berechneten Werte mit ihren Typen ein. Eine spätere Formeländerung berechnet diesen eingefrorenen Datensatz nicht neu.

HTML-Vorlagenfelder sind keine Dokumente. Sie brauchen gespeicherte Tabellen. Du kannst sie nicht in Filtern, Sortierungen, Gruppierungen, Aggregaten, Formeln oder Lookups verwenden. Andere HTML-Vorlagenfelder sind darin nicht verfügbar, um Rekursion zu verhindern.

## Berechnete Werte formatieren {icon="numbers"}

Das optionale `format` steuert die Anzeige, nicht die gespeicherte Genauigkeit. Verwende eines dieser Formate:

- `{kind:"decimal", precision?:0..10, thousandsSeparator?:boolean}`
- `{kind:"percent", precision?:0..10}`
- `{kind:"date", format:"iso"|"short"|"long"|"relative", includeTime?:boolean}`
- `{kind:"progress", label?:"value"|"percent"|"none"}`
- `{kind:"barcode", bcid:string, showText?:boolean}`

`bcid` benennt das Barcodeformat mit 1–80 Kleinbuchstaben oder Ziffern. Verwende nur ein Format, das zum Ergebnistyp passt.

## Erzeugte Kennungen konfigurieren {icon="id"}

`id` ist ein Feld, das der Server erzeugt. Es ist kein normal bearbeitbares Textfeld. Seine Konfiguration verwendet:

| `strategy` | Optionen |
| --- | --- |
| `sequence` (Standard) | `prefix` bis 32 Zeichen; `padding` 1–16 (1); `assignment` siehe unten |
| `date_sequence` | `prefix`; `padding` 1–16 (4); `period: "year" \| "month" \| "day"` (year); `assignment` siehe unten |
| `short_code` | `prefix`; `length` 4–12 (5) |
| `random_code` | `prefix`; `groups` 2–4 (2); `segmentLength` 3–6 (4) |
| `uuid` | `prefix` |
| `uuidv7` | `prefix` |
| `ulid` | `prefix` |

Nur die beiden Sequenzstrategien akzeptieren `assignment: "creation" | "finalization"`. Standard ist creation. Aktiviere die Finalisierung der Tabelle, bevor du die Nummernvergabe beim Finalisieren konfigurierst. Entwürfe haben dann keine Nummer. Grids vergibt Werte atomar und verwendet sie nie wieder. Eine rechtlich lückenlose Buchführung garantiert das nicht.

Beispiel für eine jährliche Dokumentnummer:

```json
{"strategy":"date_sequence","prefix":"INV-","padding":4,"period":"year","assignment":"finalization"}
```

`created_at`, `updated_at`, `created_by` und `updated_by` sind Systemtypen mit `config: {}`. Grids setzt ihre Werte. Sie sind nie schreibbare Formularantworten.

## Spalten einer Objektliste konfigurieren {icon="columns"}

`object_list.config` enthält `fields` (1–200 Spalten), `minItems` (0–1.000, Standard 0) und `maxItems` (1–1.000, Standard 100). Die ganze Liste darf einschließlich berechneter Zellen höchstens 256 KiB groß sein. Verschachtelte Listen, Relationen, Dateien und beliebige verschachtelte Objektspalten sind nicht erlaubt.

Jede Spalte hat:

| Eigenschaft | Bedeutung |
| --- | --- |
| `id` | Sechsstellige alphanumerische Spalten-ID. Werte verwenden diesen Schlüssel, nicht den Namen. |
| `name` | 1–200 Zeichen |
| `description` | Optionaler Hinweis, bis 2.000 Zeichen |
| `type` | `text`, `longtext`, `number`, `boolean`, `date`, `select`, `percent` oder `duration` |
| `config` | Konfiguration dieses skalaren Typs |
| `required` | Ob eine eingegebene Zelle einen Wert haben muss. Standard false. |
| `defaultValue` | Ein gültiger Literalwert, den der Editor nur beim Hinzufügen einer Zeile vorschlägt. Gilt nicht für API-Schreibvorgänge oder vorhandene Zeilen. Nicht für berechnete Spalten verfügbar. |
| `formula` | Berechnung mit `expression` und optional `format`. Sie referenziert Nachbarspalten. |
| `width` | `fullWidth` (Standard) oder `compact`. Aufeinanderfolgende kompakte Felder umbrechen gemeinsam. |
| `detailsOnly` | Blendet eine berechnete Spalte aus, bis jemand die Berechnungsdetails anzeigt. Standard false. |

Auswahlspalten und Regex-Regeln gelten nur für Eingaben. Berechnete Spalten verwenden die unterstützten skalaren Formeltypen. Der Editor zeigt Berechnungen schreibgeschützt an, und der Server berechnet sie neu. Mitgesendeten berechneten Werten vertraut der Server nicht.

Für Listenauswertungen nutze `LIST_SUM(Items, 'Amount')`, `LIST_AVG`, `LIST_MIN`, `LIST_MAX` und `LIST_COUNT`. Eine leere Liste ergibt für Summe und Anzahl null. Eine fehlende Liste ist keine leere Liste. [Formeln](/app/grids/help/grids-formulas) beschreibt Ausdrücke. [Formulare](/app/grids/help/grids-forms) beschreibt Layout und Standardwerte für Formulare.

## Eine Cloud-Ressource verknüpfen {icon="link"}

Nutze `resource` mit Konfiguration `{}`, um eine Ressource über die Cloud-Auswahl zu wählen. Das Feld speichert `{type, id, title?}`. Der optionale Titel bleibt als Text erhalten. Beim Öffnen gelten der aktuelle kanonische Leser der Ressource und ihre aktuellen Zugriffsregeln. Das Feld speichert keine URL, kein Token und keinen Zugriff. Nutze ein Dateifeld für Uploads, die Grids gehören, und eine Relation für Verbindungen zwischen Grids-Datensätzen.
