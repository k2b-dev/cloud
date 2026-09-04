---
id: notebooks-structured-blocks
title: "Strukturierte Blöcke"
icon: "ti ti-braces"
description: "Eigene Daten definieren und gefilterte Seitenlisten und Inhaltsverzeichnisse erstellen."
order: 130
---

Nutze benannte Daten für Fakten neben deinem Text, Abfragen für automatische Seitenlisten und Inhaltsverzeichnisse für Überschriften einer Seite. Ein vorgegebenes Metadatenschema ist nicht nötig.

Setze `:::data`, `:::query` und `:::toc` direkt ins Dokument, außerhalb von Listen, Zitaten, Codebeispielen und anderen Blöcken. Verschachtelte Beispiele werden nicht ausgewertet.

Bei Hinweisblöcken wie `:::info` darf das abschließende `:::` nicht weiter eingerückt sein als die öffnende Zeile.

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

Damit entstehen Felder wie `profile.owner` und `profile.reviewDays`. Namen und Feldschlüssel unterscheiden Groß- und Kleinschreibung. Verwende für Abfragefelder einen Buchstaben, gefolgt von Buchstaben, Zahlen, Unterstrichen oder Bindestrichen, mit höchstens 64 Zeichen pro Teil.

Werte sind Zeichenfolgen, Zahlen, Wahrheitswerte oder flache Listen dieser Werte. Setze zahlenähnlichen Text in Anführungszeichen: `"30"` ist nicht die Zahl `30`. Schreibe Listeneinträge auf eigene Zeilen mit zwei Leerzeichen vor `-`; Datenblöcke erlauben keine Inline-Arrays oder verschachtelten Objekte. Datumsangaben bleiben Text statt eines eigenen Datentyps. Ein Schlüssel ohne Wert und Listeneinträge ist eine leere Liste; `""` ist eine leere Zeichenfolge.

Wiederhole weder Blocknamen noch Schlüssel innerhalb eines Blocks. Ungültige benannte Daten werden aus Abfragen ausgeschlossen und mit einer Diagnose gemeldet. Ein Block unterstützt höchstens 64 Felder, eine Liste 128 Einträge und eine Zeichenfolge 2.000 Zeichen.

## Passende Seiten auflisten {icon="list-search"}

Tippe im Editor `:::` und wähle **query**. Dieses Beispiel findet Handbuchseiten mit aktivem Status und einem Prüfintervall von höchstens 30 Tagen:

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

Abfragen lesen ausschließlich gespeicherte Notizen aus dem aktuellen Notizbuch. Sie können keine anderen Notizbücher abrufen, Tabellenzeilen lesen, JavaScript ausführen, Datenbestände verknüpfen oder Änderungen schreiben.

| Einstellung | Bedeutung |
| --- | --- |
| `source` | Pflichtwert: `notes` |
| `scope` | `notebook` (Standard), direkte `children` oder alle `descendants` dieser Notiz |
| `match` | `all` (Standard) verlangt jeden Filter; `any` mindestens einen. Ohne Filter passen alle Notizen im gewählten Bereich. |
| `sort` | `field`: `$title`, `$created` oder `$updated`; `direction`: `asc` oder `desc`. Standard: zuletzt geändert, absteigend. |
| `columns` | Anzuzeigende Felder, je eines als eingerückter Listeneintrag. Ohne diese Einstellung erscheint eine verlinkte Titelliste. |
| `limit` | 1–100 Ergebnisse, Standard 25. Ein Hinweis zeigt weitere Treffer an; grenze die Filter ein, um diese zu sehen. |

Verwende höchstens 32 Filter und 16 verschiedene Spalten pro Abfrage. Eine Seite unterstützt höchstens 20 Abfrageblöcke. Listen in Filtern verwenden Inline-Syntax wie `[active, draft]` mit 1–100 Werten.

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

Lasse `value` bei `exists` und `missing` weg. Operatoren für Listenzugehörigkeit erwarten Listen; die anderen Operatoren einen Einzelwert. `in` prüft einen Einzelwert gegen eine Liste, während `contains-any` und `contains-all` Listeninhalte prüfen.

Gleichheit beachtet Typen und Groß- und Kleinschreibung. Die Textoperatoren `contains` und `starts-with` ignorieren Groß- und Kleinschreibung; Tags ignorieren außerdem ein optionales führendes `#`. `ne` und `not-in` finden keine fehlenden Felder: Verwende dafür bei Bedarf einen zusätzlichen `missing`-Filter mit `match: any`. Leere Listen existieren. Es gibt keine verschachtelten Filtergruppen, Ausdrücke, Datumsbereichsvergleiche oder Sortierung nach eigenen Feldern.

## Seiteninhalt verlinken {icon="list"}

Tippe `:::` und wähle **toc**:

```text
:::toc
min-depth: 2
max-depth: 3
:::
```

Der Block verlinkt Überschriften dieser Notiz, auch nach dem Block. Die Ebenen reichen von 1 bis 6; Standardwerte sind 1 und 6. Das ist ein Inhaltsverzeichnis der Seite, kein Notizbuchverzeichnis.

## Vorschau und Aktualisierung {icon="refresh"}

Der Rich-Modus zeigt serverseitig gerenderte Abfrage- und Inhaltsvorschauen. Bewege den Cursor in den Block oder wähle **Quelltext anzeigen**, um ihn zu bearbeiten. Ungültige Einstellungen werden an ihren Quellzeilen markiert. Eine Entwurfsvorschau speichert weder den Entwurf noch ändert sie passende Notizen.

Die Buchansicht rendert dieselben Blöcke auf dem Server ohne Editor. Gespeicherte Änderungen aktualisieren Buchinhalte und Abfragevorschauen automatisch, wenn JavaScript verfügbar ist. Schreibgeschützt bleibt die gespeicherte Quelle bis zum Neuladen unverändert; lade nach deren Änderung neu. Ohne JavaScript zeigt die Buchansicht Ergebnisse und Links weiterhin beim Seitenaufruf.

## Tabellen und Aufgaben lesbar halten {icon="table"}

Normale Tabellen, Listen, Kontrollkästchen und benannte Abschnitte bleiben Markdown. Verwende Tabellenformeln für Berechnungen innerhalb einer Tabelle; Abfragen indexieren nur benannte `:::data`-Eigenschaften und die oben genannten Systemfelder.
