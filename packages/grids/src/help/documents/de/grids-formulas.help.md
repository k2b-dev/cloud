---
id: grids-formulas
title: Formeln
icon: ti ti-function
description: Berechne Werte aus Feldern mit einer gemeinsamen Ausdruckssprache.
order: 126
---
Formeln berechnen Summen, Bezeichnungen, Datumswerte und Bedingungen aus Feldern eines Datensatzes.

Erstelle ein Feld vom Typ **Formel**, wenn das Ergebnis zu jedem Datensatz gehört. Füge eine **Berechnete Spalte** hinzu, wenn nur eine Abfrage die Berechnung braucht. In GQL kann dieselbe Ausdruckssprache Datensätze filtern oder eine Ausgabespalte erzeugen.

## Wählen, wo eine Formel läuft {icon="math-function"}

- **Formelfelder** aktualisieren sich für Entwürfe automatisch. Eine Berechnung, die nur von gespeicherten Werten desselben Datensatzes abhängt, wird bei jeder Änderung mitgespeichert und beim Lesen wiederverwendet. Eine geänderte Formel aktualisiert auch bestehende Entwürfe. Die Finalisierung friert Werte und Typen ein. Spätere Formeländerungen ändern sie nicht.
- **Berechnete Spalten** sind temporäre Ausgaben einer Abfrage. Sie fügen der Tabelle kein Feld hinzu.
- **GQL-Bedingungen** verwenden einen Ausdruck in `where` oder `having`.
- **GQL-Ausgaben** verwenden `formula(expression) as alias`.

**Spalten von Objektlisten** rechnen innerhalb einer Zeile: Aktiviere **Regeln und Berechnung** und verweise auf Nachbarspalten. Die Finalisierung friert die Ergebnisse ein. Datensatzformeln werten Listen mit `LIST_SUM(list, column)`, `LIST_AVG(list, column)`, `LIST_MIN(list, column)`, `LIST_MAX(list, column)` oder `LIST_COUNT(list)` aus. Setze Spaltennamen in Anführungszeichen, zum Beispiel `LIST_SUM(Items, 'Amount')`.

Hängt eine Formel von verknüpften Datensätzen, der aktuellen Zeit oder der Zeitzone der lesenden Person ab, berechnet Grids sie beim Lesen. Du musst keinen Berechnungsmodus wählen. Ein Berechnungsfehler bleibt sichtbar. Scheitert eine Berechnung in einer Objektliste, bleiben die eingegebenen Zellen erhalten, damit du sie korrigieren kannst.

## Ausdrücke schreiben {icon="book-2"}

:::reference
- **Felder:** Verweise auf ein einfaches Feld als `Price`. Setze Namen mit Leerzeichen oder Satzzeichen in doppelte Anführungszeichen, etwa `"Unit price"`. Nutze `{field-id}`, wenn eine erzeugte Konfiguration eine Umbenennung überstehen muss.
- **Literale:** Schreibe Text in einfache Anführungszeichen und Zahlen ohne Anführungszeichen. Schreibe die Werte `true`, `false` und `null` direkt. Doppelte Anführungszeichen bezeichnen immer einen Feldnamen. Nutze in Text `\\'`, `\\\\`, `\\n`, `\\r` oder `\\t` für ein Anführungszeichen, einen umgekehrten Schrägstrich oder ein Steuerzeichen.
- **Gruppierung:** Nutze Klammern, um eine Berechnung oder Bedingung eindeutig zu machen. Grids akzeptiert ein optionales führendes `=`, Formeln verwenden es aber normalerweise nicht.
- **Funktionen:** Bei Funktionsnamen spielt Groß- und Kleinschreibung keine Rolle. Trenne Argumente mit Kommas. Die Anzahl der Argumente muss der dokumentierten Signatur entsprechen.
:::

Prüfe leere Werte, Nullwerte und Grenzfälle. Ein Ausdruck erlaubt bis zu 20.000 Zeichen, 64 Verschachtelungsebenen und 1.024 Ausdrucksknoten (Operatoren, Werte, Referenzen und Aufrufe). Eine Abfrage oder eine berechnete Spalte kann eine kleinere Textgrenze haben. Vereinfache einen Ausdruck, der diese Grenzen überschreitet. Zusätzliche Klammern verkürzen keine Operatorkette.

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

Weiter oben stehende Operatoren binden stärker. Klammern überschreiben diese Reihenfolge. Nutze in Formeln, die Personen direkt pflegen, lieber die Wortformen `and`, `or` und `not`.

### Bedingungen mit Auswahlfeldern

Bei einer Einfachauswahl verwende `Steuersatz = '19 %'` oder `Steuersatz = 'ust-19'`. Options-IDs müssen exakt passen. Bezeichnungen passen ohne Beachtung der Groß- und Kleinschreibung und müssen eindeutig sein. Grids lehnt unbekannte Optionen ab, auch bei Feldern ohne Optionen.

Speicherst du ein Formelfeld, eine Berechnung in einer Objektliste oder eine berechnete Spalte einer Ansicht, hinterlegt Grids die Options-ID. Eine spätere Umbenennung der Bezeichnung ändert die Bedeutung deshalb nicht. Grids lehnt es ab, eine Option zu entfernen, die diese Formeln noch verwenden.

`HAS_OPTION(Tags, 'approved')` prüft die exakte Mitgliedschaft bei Einfach- und Mehrfachauswahl. Teil-IDs passen nicht: `ust-1` passt nicht auf `ust-19`. `ISBLANK(Steuersatz)` oder `Steuersatz = null` prüft eine leere Auswahl. Gleichheit zwischen einer Mehrfachauswahl und einem Text lehnt Grids ab. Nutze stattdessen `HAS_OPTION`. `CONTAINS` und andere Textfunktionen prüfen keine Mitgliedschaft in Auswahlfeldern.

Beispiel: `IF(Steuersatz = 'ust-19', ROUND(Netto / 100 * 19, 2), 0)`. Diese Regeln gelten auch für Auswahlspalten in Berechnungen von Objektlisten.

Ein Lookup, der eine Liste liefert, ist keine skalare Formeleingabe. Verknüpfe in GQL die zugehörige Tabelle und prüfe ihr Auswahlfeld direkt, zum Beispiel `HAS_OPTION(customer.Status, 'approved')`. Nutze keine Textsuche auf JSON. Formelfehler verwenden stabile Codes wie `#SELECT_INVALID` und `#NON_SCALAR`. Die Formelprüfung erklärt den ungültigen Ausdruck.

Die Formelprüfung validiert die unterstützten Operationen, bevor sie Beispieldatensätze lädt, auch bei einer leeren Tabelle. Eine erfolgreiche Prüfung prüft weder jeden Datensatz noch die fachliche Bedeutung der Berechnung. Kontrolliere die Beispielergebnisse. Teste leere Werte und jede relevante Option.

### Leere Werte, Wahrheitswerte und Fehler

- Arithmetik und geordnete Vergleiche liefern einen leeren Wert, wenn eine Seite leer ist. Zwei leere Werte sind gleich.
- In einer Bedingung sind `null`, `false`, `0` und leerer Text falsch. Andere nicht leere Werte sind wahr.
- `and`, `or`, `AND` und `OR` beenden die Auswertung, sobald das Ergebnis feststeht. `IF` wertet nur den gewählten Zweig aus.
- Nulldivisoren, negative Quadratwurzeln, überlaufende Potenzen und falsche Argumentanzahlen erzeugen Formelfehler. Ein unbehandelter Fehler bricht GQL und Workflow-Captures mit `BAD_INPUT` ab. Aggregate überspringen Fehler nie unbemerkt.
- `IFEMPTY(value, fallback)` fängt `null` und leeren Text ab. `IFERROR(value, fallback)` fängt Formelfehler ab. Grids wertet den Ersatzwert nur bei Bedarf aus.
- `CONCAT(value, ...)` verbindet Text am eindeutigsten. Text, der wie eine Zahl aussieht, nimmt an numerischen Berechnungen teil. Verlasse dich bei Bezeichnungen deshalb nicht auf `+`.

Aggregatfunktionen kombinieren die Argumente eines Datensatzes, etwa `SUM(Subtotal, Tax)`. GQL `aggregate` fasst Datensätze zusammen. Division und Mittelwerte nutzen Dezimalgenauigkeit und ignorieren nachgestellte Nullen. Runde Geldbeträge ausdrücklich mit `ROUND`. Spaltenregeln prüfen sie nur.

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

| Gruppe | Funktion | Wirkung | Rückgabe |
| --------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- | -------- |
| Aggregat | SUM(value, ...) | Addiert numerische Werte. | Zahl |
| Aggregat | AVG(value, ...) | Bildet den Durchschnitt numerischer Werte. | Zahl |
| Aggregat | MEAN(value, ...) | Alias für AVG. | Zahl |
| Aggregat | COUNT(value, ...) | Zählt nicht leere Werte. | Zahl |
| Aggregat | MIN(value, ...) | Ermittelt den kleinsten numerischen Wert. | Zahl |
| Aggregat | MAX(value, ...) | Ermittelt den größten numerischen Wert. | Zahl |
| Aggregat | MEDIAN(value, ...) | Ermittelt den mittleren numerischen Wert. | Zahl |
| Zahl | ABS(number) | Absolutwert. | Zahl |
| Zahl | ROUND(number, digits?) | Rundet eine Zahl. | Zahl |
| Zahl | FLOOR(number) | Rundet ab. | Zahl |
| Zahl | CEIL(number) | Rundet auf. | Zahl |
| Zahl | SQRT(number) | Quadratwurzel; gleiche Dezimalrundung in Vorschau und Abfragen. | Zahl |
| Zahl | POW(base, exponent) | Potenz: Ganzzahlige 32-Bit-Exponenten erhalten Ganzzahlstellen, andere nutzen 80 signifikante Stellen (höchstens 1.000 Nachkommastellen). Geld explizit runden. | Zahl |
| Zahl | MOD(a, b) | Rest. | Zahl |
| Zahl | PERCENT(part, total) | Anteil in Prozent der Gesamtsumme. | Zahl |
| Logik | IF(condition, then, else) | Wählt anhand einer Bedingung. | beliebig |
| Logik | IFEMPTY(value, fallback) | Ersatzwert für leere Werte. | beliebig |
| Logik | IFERROR(value, fallback) | Ersatzwert für Formelfehler. | beliebig |
| Logik | AND(value, ...) | Alle Werte sind wahr. Nutze in GQL where/having bevorzugt den Operator \`and\`. | Boolean |
| Logik | OR(value, ...) | Mindestens ein Wert ist wahr. Nutze in GQL where/having bevorzugt den Operator \`or\`. | Boolean |
| Logik | NOT(value) | Kehrt den Wahrheitswert um. Nutze in GQL where/having bevorzugt den Operator \`not\`. | Boolean |
| Logik | ISBLANK(value) | Wahr, wenn leer. | Boolean |
| Text | CONTAINS(text, search) | Prüft auf eine Teilzeichenfolge. | Boolean |
| Logik | HAS_OPTION(select, option) | Exakte Auswahlprüfung per Options-ID oder eindeutigem Namen. | Boolean |
| Text | STARTSWITH(text, prefix) | Wahr, wenn der Text mit dem Präfix beginnt. | Boolean |
| Text | ENDSWITH(text, suffix) | Wahr, wenn der Text mit dem Suffix endet. | Boolean |
| Text | ICONTAINS(text, search) | Prüft ohne Beachtung der Groß- und Kleinschreibung auf eine Teilzeichenfolge. | Boolean |
| Text | ISTARTSWITH(text, prefix) | Prüft ohne Beachtung der Groß- und Kleinschreibung, ob der Text mit dem Präfix beginnt. | Boolean |
| Text | IENDSWITH(text, suffix) | Prüft ohne Beachtung der Groß- und Kleinschreibung, ob der Text mit dem Suffix endet. | Boolean |
| Text | CONCAT(value, ...) | Verbindet Werte als Text. | Text |
| Text | LEN(text) | Textlänge. | Zahl |
| Text | LOWER(text) | Text in Kleinbuchstaben. | Text |
| Text | UPPER(text) | Text in Großbuchstaben. | Text |
| Text | TRIM(text) | Entfernt Leerraum am Anfang und Ende. | Text |
| Text | LEFT(text, n) | Die ersten n Zeichen. | Text |
| Text | RIGHT(text, n) | Die letzten n Zeichen. | Text |
| Text | SUBSTRING(text, start, length) | Textausschnitt mit Startindex 0. | Text |
| Text | REPLACE(text, search, replacement) | Ersetzt alle Treffer. | Text |
| Datum | TODAY() | Aktuelles Datum. | Datum |
| Datum | NOW() | Aktuelles Datum und aktuelle Uhrzeit. | Datum |
| Datum | YEAR(date) | Jahreszahl. | Zahl |
| Datum | MONTH(date) | Monatszahl. | Zahl |
| Datum | DAY(date) | Tageszahl. | Zahl |
| Datum | DATEADD(date, count, unit?) | Addiert Zeit zu einem Datum; die Einheit ist standardmäßig Tage. | Datum |
| Datum | DATEDIFF(from, to, unit?) | Differenz zwischen Datumswerten; die Einheit ist standardmäßig Tage. | Zahl |

`ROUND` rundet standardmäßig auf null Stellen. Negative Stellen runden auf Zehner, Hunderter und so weiter. Gebrochene Stellenzahlen werden Richtung null abgeschnitten. Werte außerhalb von −131.072…16.383 erzeugen einen Formelfehler. `LEFT`, `RIGHT` und `SUBSTRING` werten negative Längen als null. `SUBSTRING` beginnt an Position 0. `REPLACE` ersetzt jeden Treffer.

`TODAY()` liefert das aktuelle Datum. `NOW()` liefert das aktuelle Datum mit Uhrzeit. Kalenderberechnungen mit Datum und Uhrzeit verwenden die Anzeigezeitzone der Anfrage. Liefert die Anfrage keine, verwendet Grids die Zeitzone der Cloud. Reine Datumswerte bleiben Kalenderdaten.

- `DATEADD` akzeptiert Tag(e), Stunde(n), Minute(n), Monat(e) und Jahr(e). Standard sind Tage. Beim Addieren von Monaten oder Jahren bleiben Monatsenden gültig.
- `DATEDIFF` akzeptiert Tag(e), Stunde(n), Minute(n) und Sekunde(n). Standard sind Tage. Es liefert `to - from`, abgerundet auf ganze Einheiten.

`DATEADD` akzeptiert Eingaben und Ergebnisse in den Jahren 1000–9999. Bei Datum mit Uhrzeit müssen der lokale Kalenderwert und der resultierende UTC-Zeitpunkt in diesem Bereich bleiben. Eine größere Verschiebung liefert `#DATEADD_OUT_OF_RANGE`, das `IFERROR` abfangen kann. Die Datenbankabfrage bricht dabei nicht ab. Nachkommastellen der Anzahl werden weiterhin Richtung null abgeschnitten.

:::note Die Quelle korrigieren, nicht das Ergebnis
Formelwerte von Entwürfen aktualisieren sich automatisch. Finalisierte Datensätze behalten ihre eingefrorenen Werte. Korrigiere die Quellfelder, nicht das angezeigte Ergebnis.
:::
