---
id: grids-field-configuration
title: Feldkonfiguration nachschlagen
icon: ti ti-adjustments
description: Feldtypen, Optionen, Nummernvergabe, Standardwerte und Objektlisten für Base-Autoren.
order: 111
---
Diese Referenz hilft bei Feldkonfigurationen über CLI und API. Zur Auswahl eines Feldtyps siehe [Tabellen und Felder](/app/grids/help/grids-tables-fields). `cld grids fields types --json` liefert den aktuellen Katalog, `cld grids fields type <type> --json` einen einzelnen Typ. Die sichtbare Feldbezeichnung allein erklärt nicht die Konfiguration.

## Gemeinsame Optionen {icon="settings"}

Ein Feld hat `name` (1–200 Zeichen), optional `description` (bis 2.000), `icon` (bis 200), eine ganzzahlige `position` und die Schalter `required`, `presentable`, `hideInTable` (standardmäßig false). Namen sind innerhalb der Tabelle eindeutig, ohne Beachtung der Großschreibung und umgebender Leerzeichen. Das Anzeigefeld liefert den Datensatztitel, keine Berechtigung.

`type` ist nach dem Anlegen fest. Ein Update von `config` ersetzt die Konfiguration; fehlende Unteroptionen werden nicht ergänzt. APIs verwenden öffentliche Feld- und Tabellen-IDs. Ein Beispielname ist keine ID.

`defaultValue` belegt ausgelassene Werte neuer Datensätze typgerecht vor. `0` und `false` sind echte Werte, keine fehlenden Angaben. `null` bedeutet: kein konfigurierter Standard. Datumsfelder erlauben zusätzlich `{"kind":"now"}`. Bestehende Datensätze bleiben unverändert.

`indexed` gibt es für Text, Langtext, ID, Zahl, Prozent, Dauer, Datum, Boolean und Einfachauswahl. `uniqueConstraint` gibt es für Text, Langtext, Zahl, Prozent, Datum, Boolean und ID. Indizes helfen bei konkreten Abfragen, verursachen aber zusätzlichen Aufwand beim Schreiben.

## Eingegebene Werte {icon="edit"}

| `type` | Optionen in `config` und Standards |
| --- | --- |
| `text` | `minLength` ≥ 0, `maxLength` ≥ 1, `regex`, `multiline` (false). Umgebende Leerzeichen werden entfernt. |
| `longtext` | `minLength`, `maxLength`, `regex`, `markdown`. Behält Leerzeichen und Umbrüche. |
| `number` | `min`, `max` als Dezimalstring oder Zahl; `precision` 1–38; `decimalPlaces` 0–20; `integerOnly`; `unit` 1–20 Zeichen; `unitPosition: "prefix" \| "suffix"`. Dezimalwerte bleiben Strings. Zu viele Stellen werden abgelehnt, nicht still gerundet. |
| `boolean` | `{}`. Speichert true, false oder bei optionalen Feldern null. |
| `date` | `includeTime` (false), `min`, `max`. Reine Daten: `YYYY-MM-DD`; Zeitpunkte mit Zeitzone. |
| `select` | Pflicht: `options: [{id, label, color?, description?}]`; `multiple` (false); `minSelected` ≥ 0; `maxSelected` ≥ 1. Werte sind Arrays von Options-IDs, auch bei Einfachauswahl. |
| `principal` | `cardinality: "single" \| "multiple"` (multiple). Arrays typisierter Cloud-Nutzer-/Gruppenreferenzen mit UUIDs, höchstens 100. Der Picker beachtet die Sichtbarkeit der Identitäten. |
| `percent` | `range: "percent" \| "fraction"` (percent), `decimals` 0–8 (2). Fraction 0.19 und percent 19 zeigen jeweils 19 %; für Formeln zählt die gespeicherte Skala. |
| `duration` | `unit: "seconds" \| "minutes" \| "hours"`. Werte stehen für nichtnegative Sekunden; numerische Eingaben werden auf ganze Sekunden gerundet. Auch `HH:MM:SS` und `MM:SS` sind möglich. Die Anzeigeeinheit ändert die Speichereinheit nicht. |
| `json` | `{}`. Beliebiger gültiger JSON-Wert ohne einzelne Grids-Felddefinitionen. Ein String als Eingabe wird als JSON-Text interpretiert. |
| `file` | `maxFiles` 1–100, wenn gesetzt; `accept` mit bis zu 100 MIME-Typen, MIME-Wildcards oder Dateiendungen. Hochladen und Entfernen nutzen Datei-Aktionen, keine Datensatz-JSON-Writes. |
| `object_list` | Siehe Spaltenvertrag weiter unten. |

Ein Principal-Wert ist etwa `[{"type":"user","id":"<user-uuid>"}]` oder eine `group`-Referenz. Eine Identität im Feld ist ein Wert, **keine Freigabe**. Den aktuellen Nutzer sicher einzutragen gehört in die konfigurierte Übermittlung einer veröffentlichten App, nicht in ein veränderbares Eingabefeld.

## Verknüpfungen und berechnete Werte {icon="link"}

| `type` | `config` |
| --- | --- |
| `relation` | `targetTableId`, `cardinality: "single" \| "multiple"` (multiple). Werte sind Arrays öffentlicher Datensatz-IDs. |
| `lookup` | `relationFieldId`, `targetFieldId`, optional `format`. Liest verknüpfte Werte; keine bearbeitbare Kopie. |
| `rollup` | `relationFieldId`, `targetFieldId`, `agg: "count" \| "sum" \| "avg" \| "min" \| "max"`, optional `format`. |
| `formula` | `expression`, optional `format`. Siehe [Formelreferenz](/app/grids/help/grids-formulas), auch für exakte Dezimalrechnung und typisierte Auswahlvergleiche. |
| `html_template` | `template` bis 50 KiB, `css` bis 32 KiB mit 200 Regeln/1.000 Deklarationen. Liquid-Wurzeln: `record`, `table`, `app`, `business`, `date`. Ausgabe bis 300 KiB, isoliert und nur lesend. |

Berechnete Werte sind keine schreibbaren Datensatzwerte. Lookup und Rollup beachten Zugriffsrechte auf die Daten. Beim Finalisieren werden unterstützte Berechnungen mit ihren Datentypen festgeschrieben. Spätere Formeländerungen berechnen diesen Datensatz nicht neu.

HTML-Vorlagenfelder sind keine Dokumente. Sie benötigen gespeicherte Tabellen und stehen nicht für Filter, Sortierung, Gruppierung, Aggregate, Formeln oder Lookups zur Verfügung. Andere HTML-Vorlagenfelder sind zum Schutz vor Rekursion nicht zugänglich.

## Anzeige berechneter Werte {icon="numbers"}

Das optionale `format` steuert die Anzeige, nicht die gespeicherte Genauigkeit: `{kind:"decimal", precision?:0..10, thousandsSeparator?:boolean}`, `{kind:"percent", precision?:0..10}`, `{kind:"date", format:"iso"|"short"|"long"|"relative", includeTime?:boolean}`, `{kind:"progress", label?:"value"|"percent"|"none"}` oder `{kind:"barcode", bcid:string, showText?:boolean}`. `bcid` benennt das Barcodeformat mit 1–80 Kleinbuchstaben/Ziffern. Das Format muss zum Ergebnistyp passen.

## Generierte Kennungen {icon="id"}

`id` ist ein servergeneriertes Feld, kein frei bearbeitbarer Text. Die Konfiguration lautet:

| `strategy` | Optionen |
| --- | --- |
| `sequence` (Standard) | `prefix` bis 32 Zeichen; `padding` 1–16 (1); `assignment` siehe unten |
| `date_sequence` | `prefix`; `padding` 1–16 (4); `period: "year" \| "month" \| "day"` (year); `assignment` siehe unten |
| `short_code` | `prefix`; `length` 4–12 (5) |
| `random_code` | `prefix`; `groups` 2–4 (2); `segmentLength` 3–6 (4) |
| `uuid` | `prefix` |
| `uuidv7` | `prefix` |
| `ulid` | `prefix` |

Nur die beiden Sequenzstrategien unterstützen `assignment: "creation" | "finalization"`; Standard ist creation. Aktiviere zuerst die Finalisierung der Tabelle, wenn die Nummer erst beim Festschreiben entstehen soll. Entwürfe haben dann noch keine Nummer. Die Vergabe ist atomar und Nummern werden nicht wiederverwendet; daraus folgt keine Zusage rechtlich lückenloser Buchführung.

Beispiel für jährliche Dokumentnummern:

```json
{"strategy":"date_sequence","prefix":"INV-","padding":4,"period":"year","assignment":"finalization"}
```

`created_at`, `updated_at`, `created_by` und `updated_by` sind Systemtypen mit `config: {}`. Grids setzt diese Werte; sie sind keine schreibbaren Formularantworten.

## Spalten einer Objektliste {icon="columns"}

`object_list.config` enthält `fields` (1–200 Spalten), `minItems` (0–1.000, Standard 0) und `maxItems` (1–1.000, Standard 100). Die gesamte Liste einschließlich berechneter Werte darf 256 KiB groß sein. Verschachtelte Listen, Relationen, Dateien und beliebige Objektspalten sind nicht erlaubt.

Jede Spalte hat:

| Eigenschaft | Bedeutung |
| --- | --- |
| `id` | Sechsstellige alphanumerische Spalten-ID; Werte verwenden diese, nicht den Namen |
| `name` | 1–200 Zeichen |
| `description` | Optionaler Hinweis, bis 2.000 Zeichen |
| `type` | `text`, `longtext`, `number`, `boolean`, `date`, `select`, `percent` oder `duration` |
| `config` | Konfiguration des skalaren Typs |
| `required` | Ob eine eingegebene Zelle leer sein darf; Standard false |
| `defaultValue` | Gültiger Literalvorschlag beim Hinzufügen im Editor; nicht für API-Writes, vorhandene Zeilen oder berechnete Spalten |
| `formula` | Berechnung mit `expression` und optional `format`, mit Referenzen auf Nachbarspalten |
| `width` | `fullWidth` (Standard) oder `compact`; aufeinanderfolgende kompakte Felder umbrechen gemeinsam |
| `detailsOnly` | Berechnete Spalte erst bei angezeigten Berechnungsdetails zeigen; Standard false |

Auswahlspalten und Regex-Regeln sind nur für Eingaben geeignet. Berechnete Spalten verwenden die unterstützten skalaren Formeltypen. Der Editor zeigt sie nur lesend, der Server berechnet sie selbst; mitgesendeten Berechnungswerten wird nicht vertraut.

Für Listenauswertungen gibt es `LIST_SUM(Items, 'Amount')`, `LIST_AVG`, `LIST_MIN`, `LIST_MAX` und `LIST_COUNT`. Eine leere Liste ergibt für Summe und Anzahl die Zahl 0; eine fehlende Liste ist keine leere Liste. Syntax unter [Formeln](/app/grids/help/grids-formulas), Layout und Formularstandards unter [Formulare](/app/grids/help/grids-forms).
