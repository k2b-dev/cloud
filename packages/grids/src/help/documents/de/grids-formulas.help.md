---
id: grids-formulas
title: Formeln
icon: ti ti-function
description: Werte mit einer gemeinsamen Ausdruckssprache aus Feldern berechnen.
order: 126
---
Formeln berechnen einen Wert aus den Feldern eines Datensatzes. Nutze sie für Summen, Bezeichnungen, Datumsdifferenzen, Bedingungen und andere Ergebnisse, die automatisch den gespeicherten Eingaben folgen sollen.

Erstelle ein **Formelfeld**, wenn das Ergebnis zu jedem Datensatz gehört. Füge eine **Berechnete Spalte** hinzu, wenn die Berechnung nur in einer Abfrage benötigt wird. In GQL kann dieselbe Ausdruckssprache Datensätze filtern oder eine Ausgabespalte erzeugen.

## Wo Formeln ausgeführt werden {icon="math-function"}

- **Formelfelder** werden beim Lesen von Datensätzen neu berechnet und können in Ansichten, Karten, Detailbereichen, Grids Apps und Dokumenten erscheinen.
- **Berechnete Spalten** sind temporäre Abfrageausgaben und fügen der Tabelle kein Feld hinzu.
- **GQL-Bedingungen** verwenden einen Ausdruck in `where` oder `having`.
- **GQL-Ausgaben** verwenden `formula(expression) as alias`.

Formeln verwenden das vollständige Abfrageergebnis, nicht nur die derzeit auf dem Bildschirm sichtbaren Datensätze. Derselbe Ausdruck verhält sich in Tabellen, Ansichten, berechneten Spalten und GQL gleich.

## Ausdrucksregeln {icon="book-2"}

:::reference
- **Felder:** Referenziere ein einfaches Feld als `Price`. Setze Namen mit Leerzeichen oder Satzzeichen wie `"Unit price"` in doppelte Anführungszeichen. Nutze `{field-id}`, wenn eine generierte Konfiguration eine Umbenennung überstehen muss.
- **Literale:** Schreibe Text in einfache Anführungszeichen, Zahlen ohne Anführungszeichen und die Werte `true`, `false` und `null` direkt. Doppelte Anführungszeichen bezeichnen immer einen Feldnamen. Nutze in Text `\\'`, `\\\\`, `\\n`, `\\r` oder `\\t` für ein Anführungszeichen, einen umgekehrten Schrägstrich oder ein Steuerzeichen.
- **Gruppierung:** Nutze Klammern, um eine Berechnung oder Bedingung eindeutig zu machen. Ein optionales führendes `=` wird akzeptiert, Formeln werden aber normalerweise ohne dieses Zeichen geschrieben.
- **Funktionen:** Bei Funktionsnamen spielt die Groß- und Kleinschreibung keine Rolle. Argumente werden durch Kommas getrennt und ihre Anzahl muss der dokumentierten Funktionssignatur entsprechen.
:::

Erstelle eine Formel anhand eines repräsentativen Datensatzes und prüfe leere Werte, Nullwerte und Grenzfälle. Wenn sich der Typ eines Felds ändert oder ein Feld entfernt wird, aktualisiere abhängige Formeln, bevor du dich auf deren Ausgabe verlässt.

### Operatoren und Rangfolge

| Priorität | Operatoren | Bedeutung |
| --- | --- | --- |
| 1 | `-value`, `not value`, `!value` | Numerische oder logische Negation |
| 2 | `*`, `/`, `%` | Multiplikation, Division, Rest |
| 3 | `+`, `-` | Addition, Subtraktion; zwei nicht numerische Textwerte können mit `+` verbunden werden |
| 4 | `<`, `<=`, `>`, `>=` | Zahlen, Datumswerte oder kompatible Texte vergleichen |
| 5 | `=`, `!=` | Gleich oder ungleich |
| 6 | `and`, `&&` | Beide Bedingungen sind wahr |
| 7 | `or`, `||` | Mindestens eine Bedingung ist wahr |

Weiter oben stehende Operatoren binden stärker. Klammern überschreiben diese Reihenfolge. Nutze in Formeln, die Personen direkt pflegen, bevorzugt die Wortformen `and`, `or` und `not`.

### Leere Werte, Wahrheitswerte und Fehler

- Arithmetische Operationen und geordnete Vergleiche geben einen leeren Wert zurück, wenn eine Seite leer ist. Zwei leere Werte sind gleich.
- `null`, `false`, `0` und leerer Text gelten in einer Bedingung als falsch; andere nicht leere Werte gelten als wahr.
- `and`, `or`, `AND` und `OR` beenden die Auswertung, sobald das Ergebnis feststeht. `IF` wertet nur den gewählten Zweig aus.
- Ungültige Berechnungen wie Division oder Rest durch null, eine Quadratwurzel aus einer negativen Zahl oder eine falsche Anzahl von Funktionsargumenten erzeugen einen sichtbaren Formelfehler statt eines irreführenden Werts.
- `IFEMPTY(value, fallback)` behandelt `null` und leeren Text. `IFERROR(value, fallback)` behandelt Formelfehler. Der jeweilige Ersatzwert wird nur bei Bedarf ausgewertet.
- `CONCAT(value, ...)` verbindet Text am eindeutigsten. Numerisch wirkender Text nimmt an numerischen Berechnungen teil. Verlasse dich deshalb bei Bezeichnungen nicht auf `+`.

Die unten als Aggregate bezeichneten Funktionen kombinieren Argumente aus dem aktuellen Datensatz, zum Beispiel `SUM(Subtotal, Tax)`. Sie fassen nicht mehrere Datensätze zusammen. Nutze GQL `aggregate`, wenn ein Bericht Summen über mehrere Zeilen benötigt.

## Häufige Formeln {icon="math-function"}

**Zeilensumme**

```text
price * quantity
```

**Bruttobetrag**

```text
"Unit price" * quantity * 1.19
```

**Ersatztext**

```text
IFEMPTY(notes, 'No notes')
```

**Bedingte Bezeichnung**

```text
IF(inStock, 'Available', 'Out of stock')
```

**Tage bis zur Fälligkeit**

```text
DATEDIFF(TODAY(), dueDate, 'days')
```

**Sichere Division**

```text
IFERROR(total / quantity, 0)
```

## Vollständige Funktionsreferenz {icon="book-2"}

| Gruppe    | Funktion                           | Wirkung                                                                                               | Rückgabe |
| --------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| Aggregat  | SUM(value, ...)                    | Addiert numerische Werte.                                                                             | Zahl     |
| Aggregat  | AVG(value, ...)                    | Bildet den Durchschnitt numerischer Werte.                                                            | Zahl     |
| Aggregat  | MEAN(value, ...)                   | Alias für AVG.                                                                                         | Zahl     |
| Aggregat  | COUNT(value, ...)                  | Zählt nicht leere Werte.                                                                               | Zahl     |
| Aggregat  | MIN(value, ...)                    | Ermittelt den kleinsten numerischen Wert.                                                              | Zahl     |
| Aggregat  | MAX(value, ...)                    | Ermittelt den größten numerischen Wert.                                                               | Zahl     |
| Aggregat  | MEDIAN(value, ...)                 | Ermittelt den mittleren numerischen Wert.                                                             | Zahl     |
| Zahl      | ABS(number)                        | Absolutwert.                                                                                           | Zahl     |
| Zahl      | ROUND(number, digits?)             | Rundet eine Zahl.                                                                                      | Zahl     |
| Zahl      | FLOOR(number)                      | Rundet ab.                                                                                             | Zahl     |
| Zahl      | CEIL(number)                       | Rundet auf.                                                                                            | Zahl     |
| Zahl      | SQRT(number)                       | Quadratwurzel.                                                                                         | Zahl     |
| Zahl      | POW(base, exponent)                | Potenz.                                                                                                | Zahl     |
| Zahl      | MOD(a, b)                          | Rest.                                                                                                  | Zahl     |
| Zahl      | PERCENT(part, total)               | Anteil in Prozent der Gesamtsumme.                                                                    | Zahl     |
| Logik     | IF(condition, then, else)          | Wählt anhand einer Bedingung.                                                                          | beliebig |
| Logik     | IFEMPTY(value, fallback)           | Ersatzwert für leere Werte.                                                                            | beliebig |
| Logik     | IFERROR(value, fallback)           | Ersatzwert für Formelfehler.                                                                           | beliebig |
| Logik     | AND(value, ...)                    | Alle Werte sind wahr. Nutze in GQL where/having bevorzugt den Operator \`and\`.                       | Boolean  |
| Logik     | OR(value, ...)                     | Mindestens ein Wert ist wahr. Nutze in GQL where/having bevorzugt den Operator \`or\`.                | Boolean  |
| Logik     | NOT(value)                         | Kehrt den Wahrheitswert um. Nutze in GQL where/having bevorzugt den Operator \`not\`.                 | Boolean  |
| Logik     | ISBLANK(value)                     | Wahr, wenn leer.                                                                                       | Boolean  |
| Text      | CONTAINS(text, search)             | Prüft auf eine Teilzeichenfolge.                                                                       | Boolean  |
| Text      | STARTSWITH(text, prefix)           | Wahr, wenn der Text mit dem Präfix beginnt.                                                            | Boolean  |
| Text      | ENDSWITH(text, suffix)             | Wahr, wenn der Text mit dem Suffix endet.                                                              | Boolean  |
| Text      | ICONTAINS(text, search)            | Prüft ohne Beachtung der Groß- und Kleinschreibung auf eine Teilzeichenfolge.                           | Boolean  |
| Text      | ISTARTSWITH(text, prefix)          | Prüft ohne Beachtung der Groß- und Kleinschreibung, ob der Text mit dem Präfix beginnt.                 | Boolean  |
| Text      | IENDSWITH(text, suffix)            | Prüft ohne Beachtung der Groß- und Kleinschreibung, ob der Text mit dem Suffix endet.                   | Boolean  |
| Text      | CONCAT(value, ...)                 | Verbindet Werte als Text.                                                                              | Text     |
| Text      | LEN(text)                          | Textlänge.                                                                                             | Zahl     |
| Text      | LOWER(text)                        | Text in Kleinbuchstaben.                                                                               | Text     |
| Text      | UPPER(text)                        | Text in Großbuchstaben.                                                                                | Text     |
| Text      | TRIM(text)                         | Entfernt Leerraum am Anfang und Ende.                                                                 | Text     |
| Text      | LEFT(text, n)                      | Die ersten n Zeichen.                                                                                  | Text     |
| Text      | RIGHT(text, n)                     | Die letzten n Zeichen.                                                                                 | Text     |
| Text      | SUBSTRING(text, start, length)     | Textausschnitt mit Startindex 0.                                                                       | Text     |
| Text      | REPLACE(text, search, replacement) | Ersetzt alle Treffer.                                                                                  | Text     |
| Datum     | TODAY()                            | Aktuelles Datum.                                                                                       | Datum    |
| Datum     | NOW()                              | Aktuelles Datum und aktuelle Uhrzeit.                                                                 | Datum    |
| Datum     | YEAR(date)                         | Jahreszahl.                                                                                            | Zahl     |
| Datum     | MONTH(date)                        | Monatszahl.                                                                                            | Zahl     |
| Datum     | DAY(date)                          | Tageszahl.                                                                                             | Zahl     |
| Datum     | DATEADD(date, count, unit?)        | Addiert Zeit zu einem Datum; die Einheit ist standardmäßig Tage.                                       | Datum    |
| Datum     | DATEDIFF(from, to, unit?)          | Differenz zwischen Datumswerten; die Einheit ist standardmäßig Tage.                                   | Zahl     |

`ROUND` verwendet standardmäßig null Dezimalstellen und akzeptiert negative Stellen für Zehner, Hunderter und größere Positionen. `LEFT`, `RIGHT` und `SUBSTRING` behandeln negative Längen als null; `SUBSTRING` beginnt an Position 0. `REPLACE` ersetzt jeden Treffer.

`TODAY()` gibt das aktuelle Datum und `NOW()` das aktuelle Datum mit Uhrzeit zurück. Kalenderberechnungen mit Datum und Uhrzeit verwenden die Anzeigezeitzone der Anfrage. Wenn keine angegeben ist, verwendet Grids die Zeitzone der Cloud-Anwendung. Reine Datumswerte bleiben Kalenderdaten. `DATEADD` akzeptiert Tag(e), Stunde(n), Minute(n), Monat(e) und Jahr(e), verwendet standardmäßig Tage und erhält beim Addieren von Monaten oder Jahren gültige Monatsenddaten. `DATEDIFF` akzeptiert Tag(e), Stunde(n), Minute(n) und Sekunde(n), verwendet standardmäßig Tage und gibt `to - from`, abgerundet auf ganze Einheiten, zurück.

:::note Formelfelder speichern keinen zweiten Wert
Sie werden beim Lesen aus dem aktuellen Datensatz berechnet. Ändere die Quellfelder, wenn das Ergebnis falsch ist, statt das dargestellte Formelergebnis zu bearbeiten.
:::
