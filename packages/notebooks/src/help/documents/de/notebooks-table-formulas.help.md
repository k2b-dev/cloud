---
id: notebooks-table-formulas
title: "Tabellenformeln"
icon: "ti ti-math-function"
description: "Vollständige Referenz zu Syntax und Funktionen von Tabellenformeln."
order: 140
---

Tabellenformeln machen aus Zellen in Markdown-Tabellen berechnete Werte. Sie sind bewusst kompakt: Schreibe die Formel in die Zelle und lasse die Ausgangsspalten sichtbar.

**Formelaufbau**

## Kleine Beispiele {icon="flask"}

**Fortschritt**

```text
=PROGRESS(2, 10)
```

**Spaltensumme**

```text
=SUM(Hours)
```

**Bedingte Bezeichnung**

```text
=IF(Status == "done", "closed", "open")
```

**Syntax**

## Formelregeln {icon="ruler-2"}

:::reference
- **Mit = beginnen:** Eine Tabellenformel beginnt mit =, zum Beispiel =SUM(Hours).
- **Spalten über ihren Namen referenzieren:** Verwende den Spaltennamen direkt. Setze Namen mit Leerzeichen in Backticks, zum Beispiel =SUM(`Total Cost`).
- **Vergleiche liefern Zahlen:** >, <, == und verwandte Operatoren liefern 1 oder 0.
- **Formelzellen zählen sich nicht selbst:** Spaltensummen überspringen ihre eigene Formelzelle. =SUM(Hours) bezieht die Summenzelle daher nicht ein.
:::

**Referenz**

## Funktionskatalog {icon="book-2"}

### Autovervollständigung und Darstellung verwenden diesen Funktionsumfang

Die Autovervollständigung für Tabellen, die Vorschau beim Bearbeiten und die Darstellung im Lesemodus verwenden dieselben Funktionsnamen.

### Bei Namen wird die Groß- und Kleinschreibung nicht berücksichtigt

Großbuchstaben verbessern die Lesbarkeit, der Formelauswerter akzeptiert Funktionsnamen jedoch auch in Kleinbuchstaben.

### Fortschritt und Prozentwerte

Verwende diese Funktionen, wenn eine Zelle einen Fortschritt oder Prozentwert anzeigen soll.

| Funktion | Syntax | Beispiel | Ergebnis und Hinweise |
| --- | --- | --- | --- |
| `PROGRESS` | `PROGRESS(ratio)` | `=PROGRESS(0.4)` | Fortschrittsbalken bei 40 %<br>Die visuelle Darstellung wird auf den Bereich von 0 % bis 100 % begrenzt. |
| `PROGRESS` | `PROGRESS(done, total)` | `=PROGRESS(2, 10)` | Fortschrittsbalken bei 2/10<br>total darf nicht 0 sein. |
| `PERCENT` | `PERCENT(part, total)` | `=PERCENT(Done, Total)` | Prozentwert<br>Liefert 40 für 40 %, nicht 0.4. |

### Spaltenaggregate

Diese Funktionen lesen eine ganze Spalte. Leere oder nicht numerische Zellen werden bei numerischen Funktionen ignoriert.

| Funktion | Syntax | Beispiel | Ergebnis und Hinweise |
| --- | --- | --- | --- |
| `SUM` | `SUM(column)` | `=SUM(Hours)` | Summe der numerischen Zellen |
| `AVG` | `AVG(column)` | `=AVG(Rating)` | Durchschnitt; 0 bei einer leeren Spalte |
| `MEAN` | `MEAN(column)` | `=MEAN(Rating)` | entspricht AVG(column) |
| `MIN` | `MIN(column)` | `=MIN(Price)` | kleinste Zahl; 0 bei einer leeren Spalte |
| `MAX` | `MAX(column)` | `=MAX(Price)` | größte Zahl; 0 bei einer leeren Spalte |
| `COUNT` | `COUNT(column)` | `=COUNT(Name)` | Anzahl nicht leerer Zellen<br>Text wird ebenfalls gezählt. |
| `MEDIAN` | `MEDIAN(column)` | `=MEDIAN(Score)` | mittlere Zahl; 0 bei einer leeren Spalte |
| `UNIQUE` | `UNIQUE(column)` | `=UNIQUE(Status)` | Anzahl unterschiedlicher, nicht leerer Werte |
| `STDEV` | `STDEV(column)` | `=STDEV(Weight)` | Stichproben-Standardabweichung<br>Liefert 0 bei weniger als 2 Zahlen. |
| `COUNTIF` | `COUNTIF(column, value)` | `=COUNTIF(Status, "done")` | Anzahl übereinstimmender Zellen<br>Der Text muss exakt übereinstimmen. |
| `SUMIF` | `SUMIF(sumColumn, conditionColumn, value)` | `=SUMIF(Hours, Status, "done")` | bedingte Summe |

### Zeilenaggregate

Diese Funktionen lesen die aktuelle Zeile. Die Zelle mit der Formel wird übersprungen.

| Funktion | Syntax | Beispiel | Ergebnis und Hinweise |
| --- | --- | --- | --- |
| `ROWSUM` | `ROWSUM()` | `=ROWSUM()` | Summe der numerischen Zellen in dieser Zeile |
| `ROWAVG` | `ROWAVG()` | `=ROWAVG()` | Durchschnitt der numerischen Zellen in dieser Zeile |
| `ROWMEAN` | `ROWMEAN()` | `=ROWMEAN()` | entspricht ROWAVG() |

### Logik und Bedingungen

Erstelle einfache Entscheidungen. Als wahr gelten Zahlen ungleich null und nicht leerer Text.

| Funktion | Syntax | Beispiel | Ergebnis und Hinweise |
| --- | --- | --- | --- |
| `IF` | `IF(condition, then, else)` | `=IF(Hours > 2, "long", "short")` | Wert von then oder else |
| `IFEMPTY` | `IFEMPTY(value, fallback)` | `=IFEMPTY(Owner, "unassigned")` | fallback für leere Zellen |
| `IFERROR` | `IFERROR(value, fallback)` | `=IFERROR(SUM(Missing), 0)` | fallback, wenn value einen Fehler liefert |
| `AND` | `AND(a, b, ...)` | `=AND(Status == "done", Hours > 0)` | 1, wenn alle Werte wahr sind, sonst 0 |
| `OR` | `OR(a, b, ...)` | `=OR(Status == "done", Status == "shipped")` | 1, wenn mindestens ein Wert wahr ist, sonst 0 |
| `NOT` | `NOT(value)` | `=NOT(Status == "done")` | 1 oder 0 |
| `CONTAINS` | `CONTAINS(text, search)` | `=CONTAINS(Notes, "urgent")` | 1, wenn text den Wert search enthält, sonst 0 |

### Text

Bereinige und verbinde Textwerte.

| Funktion | Syntax | Beispiel | Ergebnis und Hinweise |
| --- | --- | --- | --- |
| `CONCAT` | `CONCAT(...parts)` | `=CONCAT(First, " ", Last)` | verbundener Text |
| `UPPER` | `UPPER(text)` | `=UPPER(Name)` | Text in Großbuchstaben |
| `LOWER` | `LOWER(text)` | `=LOWER(Tag)` | Text in Kleinbuchstaben |
| `TRIM` | `TRIM(text)` | `=TRIM(Name)` | Text ohne Leerzeichen am Anfang und Ende |
| `LEFT` | `LEFT(text, n)` | `=LEFT(Code, 3)` | erste n Zeichen |
| `RIGHT` | `RIGHT(text, n)` | `=RIGHT(Code, 2)` | letzte n Zeichen |
| `LEN` | `LEN(text)` | `=LEN(Notes)` | Anzahl der Zeichen |
| `SUBSTRING` | `SUBSTRING(text, start, length)` | `=SUBSTRING(Code, 2, 4)` | Textausschnitt<br>start beginnt bei 0. length gibt die Anzahl der übernommenen Zeichen an. |
| `REPLACE` | `REPLACE(text, search, replacement)` | `=REPLACE(Name, "old", "new")` | Text, in dem alle Treffer ersetzt wurden |

### Mathematik

Verwende Rechenoperatoren direkt oder Hilfsfunktionen, wenn eine Zelle formatiert werden soll.

| Funktion | Syntax | Beispiel | Ergebnis und Hinweise |
| --- | --- | --- | --- |
| `Arithmetic` | `+  -  *  /` | `=Price * Qty` | Zahl<br>Eine Division durch 0 zeigt einen Formelfehler. |
| `Comparisons` | `==  !=  <  <=  >  >=` | `=Hours >= 8` | 1 oder 0 |
| `ROUND` | `ROUND(number, digits)` | `=ROUND(Price * Qty, 2)` | gerundete Zahl |
| `ABS` | `ABS(number)` | `=ABS(Balance)` | absoluter Wert |
| `SQRT` | `SQRT(number)` | `=SQRT(Area)` | Quadratwurzel |
| `POW` | `POW(base, exponent)` | `=POW(2, 8)` | Potenz |
| `MOD` | `MOD(a, b)` | `=MOD(Row, 2)` | Rest |

### Datum und Uhrzeit

Diese Funktionen liefern einfache Datumsangaben oder vergleichen Datumswerte.

| Funktion | Syntax | Beispiel | Ergebnis und Hinweise |
| --- | --- | --- | --- |
| `TODAY` | `TODAY()` | `=TODAY()` | YYYY-MM-DD |
| `NOW` | `NOW()` | `=NOW()` | YYYY-MM-DD HH:MM:SS |
| `DATEDIFF` | `DATEDIFF(start, end, unit?)` | `=DATEDIFF(Start, Due, "d")` | Differenz als Zahl<br>Einheiten: ms, s, m, h, d. Vollständige Namen funktionieren ebenfalls. |
