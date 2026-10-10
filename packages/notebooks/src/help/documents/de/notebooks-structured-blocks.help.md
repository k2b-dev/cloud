---
id: notebooks-structured-blocks
title: "Strukturierte Blöcke"
icon: "ti ti-braces"
description: "Eigene Daten festlegen und gefilterte Seitenlisten und Inhaltsverzeichnisse erstellen."
order: 130
---

Nutze benannte Daten für Fakten neben deinem Text, Abfragen für automatische Seitenlisten und ein Inhaltsverzeichnis für die Überschriften einer Seite. Ein vorgegebenes Schema für Metadaten brauchst du nicht.

Setze `:::data`, `:::query` und `:::toc` direkt ins Dokument. Setze sie nicht in Listen, Zitate, Codebeispiele oder andere Blöcke. Notebooks wertet verschachtelte Blöcke nicht aus.

Rücke bei Hinweisblöcken wie `:::info` das schließende `:::` nicht weiter ein als die öffnende Zeile.

## Eigene Daten ergänzen {icon="braces"}

Setze einen stabilen Namen direkt über einen Datenblock:

```text
@profile
:::data
owner: Ada
status: active
reviewDays: 30
approved: true
teams:
  - operations
  - support
:::
```

Damit entstehen Felder wie `profile.owner` und `profile.reviewDays`. Namen und Feldschlüssel unterscheiden Groß- und Kleinschreibung. Beginne für Abfragefelder jeden Teil mit einem Buchstaben, gefolgt von Buchstaben, Zahlen, Unterstrichen oder Bindestrichen. Jeder Teil hat höchstens 64 Zeichen.

:::reference
- **Werte:** Zeichenfolgen, Zahlen, Wahrheitswerte oder flache Listen dieser Werte.
- **Zahlen als Text:** Setze Text, der wie eine Zahl aussieht, in Anführungszeichen. `"30"` ist nicht die Zahl `30`.
- **Listen:** Schreibe jeden Listeneintrag in eine eigene Zeile mit zwei Leerzeichen vor `-`. Datenblöcke erlauben keine Inline-Arrays und keine verschachtelten Objekte.
- **Datumsangaben:** Datumsangaben bleiben Text. Einen eigenen Datentyp für Datumsangaben gibt es nicht.
- **Leere Werte:** Ein Schlüssel ohne Wert und ohne Listeneinträge ist eine leere Liste. Verwende `""` für eine leere Zeichenfolge.
:::

Wiederhole keinen Blocknamen und keinen Schlüssel innerhalb eines Blocks. Abfragen schließen ungültige benannte Daten aus, und Notebooks meldet sie als Diagnose. Ein Block hat höchstens 64 Felder, eine Liste 128 Einträge und eine Zeichenfolge 2.000 Zeichen.

## Passende Seiten auflisten {icon="list-search"}

Tippe im Editor `:::` und wähle **query**. Dieses Beispiel findet Handbuchseiten mit dem Status active und einem Prüfintervall von höchstens 30 Tagen:

```text
:::query
source: notes
scope: notebook
match: all
where:
  - field: $tags
    op: contains-all
    value: [handbook]
  - field: profile.status
    op: eq
    value: active
  - field: profile.reviewDays
    op: lte
    value: 30
sort:
  field: $updated
  direction: desc
columns:
  - $title
  - profile.owner
  - profile.reviewDays
limit: 25
:::
```

Abfragen lesen nur gespeicherte Notizen aus dem aktuellen Notizbuch. Sie können keine anderen Notizbücher abrufen, keine Tabellenzeilen lesen, kein JavaScript ausführen, keine Datenbestände verknüpfen und nichts ändern.

Übernimm die Einrückung aus dem Beispiel. Setze zwei Leerzeichen vor Einträge der Filterliste, Spalten und Sortierfelder. Setze vier Leerzeichen vor `op` und `value` eines Filters. Das Format ähnelt YAML, ist aber kein allgemeines YAML. Es unterstützt keine Kommentare, keine Anker und keine verschachtelten Filterobjekte. Für den Standardwert einer optionalen Einstellung lässt du die Einstellung weg. Lass ihren Wert nicht leer.

| Einstellung | Bedeutung |
| --- | --- |
| `source` | Pflichtwert: `notes` |
| `scope` | `notebook` (Standard, einschließlich dieser Notiz), direkte `children` oder alle `descendants` dieser Notiz. Kinder und Nachkommen schließen diese Notiz aus. |
| `match` | `all` (Standard) verlangt jeden Filter; `any` mindestens einen. Ohne Filter passen alle Notizen im Bereich. |
| `sort` | `field`: `$title`, `$created` oder `$updated`; `direction`: `asc` oder `desc`. Standard: zuletzt geändert, absteigend. |
| `columns` | Anzuzeigende Felder, je eines als eingerückter Listeneintrag. Ohne Spalten zeigt die Abfrage eine Liste verlinkter Titel. |
| `limit` | 1–100 Ergebnisse, Standard 25. Ein Hinweis zeigt, dass weitere Notizen passen. Grenze die Filter ein, um sie zu sehen. |

Eine Abfrage hat höchstens 32 Filter und 16 verschiedene Spalten. Eine Seite hat höchstens 20 Abfrageblöcke. Listen in Filtern verwenden Inline-Syntax wie `[active, draft]` mit 1–100 Werten. Eine Filterzeichenfolge hat höchstens 2.000 Zeichen. Setze Listenwerte mit Kommas in Anführungszeichen, etwa `["Sales, Europe", Support]`.

## Filter wählen {icon="filter"}

| Feld oder Wert | Operatoren |
| --- | --- |
| `$title` | `eq`, `ne`, `in`, `not-in`, `contains`, `starts-with` |
| `$created`, `$updated` | `eq`, `ne`, `in`, `not-in`; vollständige Zeitstempel wie `2026-09-01T10:00:00Z` verwenden |
| `$tags` | `contains` für einen Tag; `contains-any` oder `contains-all` für eine Liste; `exists` oder `missing` |
| Benannte Einzelwerte | `eq`, `ne`, `in`, `not-in`, `exists`, `missing` |
| Benannter Text | Zusätzlich `contains`, `starts-with` |
| Benannte Zahlen | Zusätzlich `gt`, `gte`, `lt`, `lte` |
| Benannte Listen | `contains-any`, `contains-all`, `exists`, `missing` |

Lass `value` bei `exists` und `missing` weg. Operatoren für die Zugehörigkeit zu einer Liste erwarten Listen. Alle anderen Operatoren erwarten einen Einzelwert. `in` prüft einen Einzelwert gegen eine Liste. `contains-any` und `contains-all` prüfen den Inhalt einer Liste.

:::reference
- **Gleichheit:** Beachtet Typen und Groß- und Kleinschreibung.
- **Text:** `contains` und `starts-with` ignorieren Groß- und Kleinschreibung.
- **Tags:** Ignorieren Groß- und Kleinschreibung und ein optionales führendes `#`.
- **Fehlende Felder:** `ne` und `not-in` finden keine fehlenden Felder. Brauchst du sie, ergänze einen eigenen `missing`-Filter mit `match: any`.
- **Vorhanden:** Leere Eigenschaftslisten sind vorhanden. `$tags` ist nur vorhanden, wenn eine Notiz mindestens einen Tag hat.
- **Nicht verfügbar:** Verschachtelte Filtergruppen, Ausdrücke, Vergleiche von Datumsbereichen und Sortierung nach eigenen Feldern.
:::

## Seiteninhalt verlinken {icon="list"}

Tippe `:::` und wähle **toc**:

```text
:::toc
min-depth: 2
max-depth: 3
:::
```

Der Block verlinkt die Überschriften dieser Notiz, auch Überschriften vor und nach dem Block. Die Ebenen reichen von 1 bis 6. Die Standardwerte sind 1 und 6. `min-depth` darf nicht größer als `max-depth` sein. Der Block zeigt den Inhalt einer Seite, kein Verzeichnis des Notizbuchs.

Die Buchansicht verlinkt auch Überschriften in Listen, Zitaten und Hinweisen. Die Editorvorschau springt nur zu Überschriften mit genauer Position im Quelltext. Bei anderen Überschriften zeigt sie einen Hinweis.

## Blöcke in der Vorschau sehen und aktualisieren {icon="refresh"}

Der Rich-Modus zeigt Vorschauen für Abfragen und Inhaltsverzeichnisse, die der Server rendert. Um einen Block zu bearbeiten, setze den Cursor hinein oder wähle **Quelltext anzeigen**. Notebooks markiert ungültige Einstellungen in ihren Quellzeilen.

Eine Entwurfsvorschau nutzt die Abfrageeinstellungen und Überschriften deines Entwurfs. Abfragen lesen trotzdem gespeicherte Daten, auch für die aktuelle Notiz. Die Vorschau speichert den Entwurf nicht und ändert keine passenden Notizen.

Die Buchansicht rendert dieselben Blöcke auf dem Server, ohne Editor. Ist JavaScript verfügbar, aktualisieren gespeicherte Änderungen die Buchansicht und die Abfragevorschauen automatisch. **Schreibgeschützt** behält den gespeicherten Quelltext bis zum Neuladen. Lade neu, nachdem sich dieser Quelltext geändert hat. Ohne JavaScript zeigt die Buchansicht Ergebnisse und Links beim Laden der Seite.

## Tabellen und Aufgaben lesbar halten {icon="table"}

Normale Tabellen, Listen, Kontrollkästchen und benannte Abschnitte bleiben Markdown. Verwende Tabellenformeln für Berechnungen in einer Tabelle. Abfragen indexieren nur benannte `:::data`-Eigenschaften und die oben genannten Systemfelder.

Die Buchansicht berechnet dieselben Tabellenformeln wie der Editor, auch berechnete Spalten, Summen und Fortschrittsbalken. Ein Formelfehler bleibt in seiner Zelle sichtbar. Tabellenüberschriften und normale Zellen unterstützen außerdem Formatierungen, Links, Bilder und LaTeX. Formelergebnisse bleiben reine Werte.
