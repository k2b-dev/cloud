---
id: grids-gql
title: GQL
icon: ti ti-code
description: Finde, verbinde und fasse Grids-Daten mit der Grids Query Language zusammen.
order: 125
---
GQL ist die Grids Query Language. Sie beschreibt, welche gespeicherten Daten du willst und wie Grids das Ergebnis formt. Abfrage-Explorer, gespeicherte Ansichten, Blöcke in Grids Apps, Dokumentquellen, Exporte und die CLI verwenden dieselbe Sprache.

Für normale Tabellenarbeit brauchst du kein GQL. Beginne mit den Steuerelementen **Suche**, **Filter**, **Sortieren** und **Berechnet**. Nutze GQL, wenn eine genaue Abfrage als Text leichter zu verstehen, wiederzuverwenden oder zu prüfen ist.

## Abfrage mit KI {icon="sparkles"}

Wähle im Editor **Abfrage mit KI**, um einen Assistant-Entwurf mit dieser Base, Quelle und Abfrage zu öffnen. Ergänze, was du finden willst, und sende ihn ab. Assistant findet relevante Felder, prüft Abfragen und zeigt echte Ergebnisse mit demselben Zugriff wie der Editor. Dieser Chat kann weder Datensätze noch das Schema ändern.

Assistant kann eine Abfrage als Ansicht speichern, nachdem du ihren Namen und ihre persönliche oder geteilte Sichtbarkeit bestätigt hast. Beides erfordert Zugriff **Verwalten** auf die Base. Über den zurückgegebenen Link öffnest du die Abfrage in einem neuen Browser-Tab. Der Chat bleibt offen. Sehr lange Abfragen musst du gegebenenfalls kopieren. Vorschauen und einzelne Seiten sind keine vollständigen Exporte.

Der integrierte Skill **cloud-grids** verweist Assistant für Produkt- und Administrationsfragen auf die aktuelle Hilfe. Unterstützt kein Werkzeug eine Aktion, erklärt Assistant die Schritte in der Oberfläche. Der Skill gibt keinen zusätzlichen Zugriff.

Beschreibe bei einer allgemeinen Anfrage zuerst das gewünschte Ergebnis, bevor Assistant das Schema liest. Scheitert eine Abfrage, nennt ihre Diagnose auch die technische Ursache und die Position. Eine korrigierte Abfrage muss dieselben fachlichen Bedingungen behalten. Sie darf zum Beispiel einen Status des Kopfs nicht durch einen Positionsstatus ersetzen. Auswahl- und Mitgliedschaftsfilter auf verknüpften Tabellen werden derzeit nicht unterstützt. Eigenständige Assistant-Abfragen verwenden `TODAY()` und `NOW()`. Den Custom-App-Kontext `@auth` und `@time` erhalten sie nicht.

## Eine erste Abfrage lesen {icon="search"}

Diese Abfrage liest die Tabelle Books, behält verfügbare Bücher und wählt drei Felder. Sie sortiert die neuesten zuerst und liefert höchstens 25 Zeilen:

```gql
from table Books
where Status = 'Available'
select Title, Author, Published
sort Published desc
limit 25
```

Jede Zeile ist eine Klausel:

- `from` wählt eine Tabelle oder gespeicherte Ansicht.
- `where` entfernt Datensätze, die einer exakten Regel nicht entsprechen.
- `select` wählt die Ausgabespalten.
- `sort` legt die Reihenfolge fest.
- `limit` begrenzt das vollständige Ergebnis bewusst.

Schreibe Feld- und Tabellennamen so, wie Grids sie zeigt. Setze Namen mit Leerzeichen in doppelte Anführungszeichen, etwa `"Birth year"`. Setze Textwerte in einfache Anführungszeichen, etwa `'Available'`.

## Eine Abfrage sicher aufbauen {icon="search"}

Beginne nur mit der Quelle und zeige eine Vorschau an:

```gql
from table Books
```

Ergänze danach einen Aspekt nach dem anderen: einen Filter, die ausgewählten Felder und zuletzt eine aussagekräftige Sortierung. Der Editor löst beim Tippen zugängliche Tabellen, Ansichten, Felder, Relationen und Aliasse auf. Diagnosen nennen Syntaxfehler, unbekannte Namen, Mehrdeutigkeiten, inkompatible Vorgänge und Zugriffsfehler. Sie raten nie.

Ohne `select` liefert die Abfrage alle gewöhnlichen Felder der Quelle. Aufwendige Felder, die Grids erst nach der Abfrage berechnet, wie HTML-Vorlagen, erfordern ein ausdrückliches `select`. Liste wichtige Felder ausdrücklich auf, wenn ein gespeichertes Ergebnis, ein Dokument oder eine Integration eine stabile Ausgabe braucht.

Ein ausdrücklich ausgewähltes HTML-Vorlagenfeld rendert Grids, nachdem es die begrenzten primären Datensätze gelesen hat. Du kannst es nicht in `where`, `sort`, `group by`, `aggregate`, `having` oder Formelausdrücken verwenden, weil Liquid und CSS erst rendern, wenn das Abfrageergebnis feststeht. Auch die Auswahl einer HTML-Vorlage aus einer verbundenen Tabelle wird nicht unterstützt. Lege das Ausgabefeld stattdessen in der primären gespeicherten Tabelle an.

## Häufige Abfrageaufgaben lösen {icon="search"}

**Exakte Datensätze finden**

```gql
from table Tasks
where Status = 'Open' and Priority != 'Low'
sort Due asc
```

Nutze `where` für Regeln, die exakt bleiben müssen. Nutze `search` für eine breite Suche in durchsuchbaren Anzeigewerten:

```gql
from table Books
search 'tolkien'
limit 20
```

Du kannst die Suche auf benannte Felder beschränken:

```gql
from table Books
search 'kingdom' in Title, Country
limit 20
```

**Ein berechnetes Ergebnis ergänzen**

```gql
from table Products
select Name, Price, formula(Price * 1.19) as gross
where Price > 0
sort gross desc
```

Die Berechnung gehört zu diesem Ergebnis. Sie erstellt kein Tabellenfeld.

**Datensätze zusammenfassen**

```gql
from table Orders
group by "Ordered at" by month
aggregate sum(Total) as revenue, count(*) as orders
having revenue > 0
sort "Ordered at" asc
```

Eine Gruppierung liefert Zusammenfassungszeilen, keine bearbeitbaren Datensätze. Nutze sie für Berichte, Diagramme, Grids Apps, Dokumente und Exporte. `where` filtert Quelldatensätze vor der Gruppierung. `having` filtert die berechneten Gruppen.

**Einer Relation folgen**

Hat Orders eine Relation zu Customer, kann ein Join Felder aus Customers bereitstellen:

```gql
from table Orders
left join table Customers as customer on Customer = customer.id
select "Order number", customer.Name as customer_name, Total
sort "Order number" asc
limit 50
```

Das Relationsfeld links muss auf die `id` des verbundenen Alias zeigen. Nutze `left join`, wenn Datensätze ohne verknüpftes Ziel im Ergebnis bleiben müssen.

### Unabhängige Summen verbinden

Speichere `PaymentTotals` als `from table Payments; group by Invoice; aggregate sum(Amount) as paid`, wobei `Invoice` auf `Invoices` verweist:

```gql
from table Invoices as bill
left join view PaymentTotals as payments on payments.Invoice = bill.id
select Number, formula(Gross - IF(ISBLANK(payments.paid), 0, payments.paid)) as outstanding
```

Verbinde Korrekturen über eine zweite gruppierte Ansicht, um doppelte Summen zu vermeiden. Jede Ansicht liefert höchstens eine Zeile pro Rechnung. Eine fehlende Gruppe ergibt `null`. Aggregataliasse kannst du auswählen, in Formeln verwenden, filtern und sortieren. Gruppiere jede Ansicht nach einer Relation zur Haupttabelle und deklariere ihre Aggregate.

- Nur `left join view` funktioniert.
- Die Ansicht darf keine äußere Gruppierung, kein Quellenlimit, keine Suche, keine Gruppensortierung, kein HAVING und keine anderen nicht wiederverwendbaren Klauseln verwenden.
- Haupt- und Kindtabelle müssen gespeicherte Tabellen sein, keine kombinierten Tabellen.
- Fehlender Zugriff ist ein Fehler. Ergebnisse sind schreibgeschützt.

## Die Reihenfolge der Klauseln einhalten {icon="search"}

Nicht jede Abfrage braucht jede Klausel. Kombinierst du Klauseln, behalte diese Reihenfolge bei, damit die Quelle leicht zu überblicken bleibt:

```text
from table ...
join ...
select ...
where ...
search ...
group by ...
aggregate ...
having ...
sort ...
limit ...
offset ...
include deleted | deleted only
```

Zeilenumbrüche sind optional. Nutze Semikolons, wenn mehrere Klauseln in einer Zeile stehen, und `-- comment` für einen Kommentar:

```gql
from table Orders; where Status = 'Paid'; sort "Ordered at" desc; limit 10
```

Nutze `from`, `where`, `search`, `having`, `limit`, `offset` und den Modus für gelöschte Datensätze jeweils höchstens einmal. Fasse mehrere Felder, Gruppen, Aggregate oder Sortierungen in einer kommagetrennten Klausel zusammen. Eine Abfrage kann mehrere Joins enthalten, weil jeder Join eine weitere Quelle hinzufügt.

## Klauseln nachschlagen {icon="search"}

| Klausel | Zweck |
| --- | --- |
| `from table` / `from view` | Wählt eine lesbare Quelle. Ergänze `as alias` für eine kürzere oder wiederholte Quellenreferenz. |
| `join` / `left join` | Folgt einer Relation zu einer anderen lesbaren Tabelle. |
| `select` | Wählt Ausgabespalten aus, benennt sie um oder berechnet sie. Formeln und Aggregate benötigen einen Alias. |
| `where` | Filtert Quelldatensätze vor der Gruppierung. |
| `search` | Durchsucht alle durchsuchbaren Felder oder nach `in` benannte Felder. |
| `group by` | Erstellt eine Zusammenfassungszeile pro Wert. Datumsfelder unterstützen `by day`, `week`, `month`, `quarter` oder `year`. |
| `aggregate` | Berechnet `count`, `countEmpty`, `countUnique`, `sum`, `avg`, `min`, `max`, `median`, `earliest` oder `latest`. |
| `having` | Filtert gruppierte Zeilen, nachdem Aggregate vorhanden sind. |
| `sort` | Sortiert Zeilen oder Zusammenfassungen; unterstützt `asc`, `desc`, `nulls first` und `nulls last`. |
| `limit` | Begrenzt das vollständige logische Ergebnis auf 1 bis 10.000 Zeilen. |
| `offset` | Überspringt 0 bis 10.000 Zeilen, bevor Ergebnisse zurückgegeben werden. Kombiniere die Klausel immer mit einer aussagekräftigen Sortierung. |
| `include deleted` | Schließt aktive und gelöschte Datensätze ein. |
| `deleted only` | Gibt nur Datensätze im Papierkorb zurück. |

Die beiden Klauseln für gelöschte Datensätze schließen sich gegenseitig aus. Normale Abfragen liefern nur aktive Datensätze.

`from view` beginnt mit der Abfrage der gespeicherten Ansicht und wendet danach die neuen Klauseln an. Nutze es, wenn ein geprüfter Datenbestand schon der richtige Ausgangspunkt ist.

Nicht jede GQL-Abfrage funktioniert als verschachtelte Quelle. So ist eine gespeicherte Abfrage mit Relation-Joins, Vergleichen zwischen Feldern oder einem Offset nicht als `from view`-Quelle verfügbar. Grids lehnt solche Verweise ab und lässt nie ihre Filter weg. Führe die gespeicherte Abfrage direkt aus oder beginne mit ihrer Tabelle und übernimm die benötigten Klauseln ausdrücklich. Auch eine Ansicht, die nach Datensatzmetadaten filtert, kann nicht Quelle einer anderen Ansicht sein.

## Namen, Aliasse und Werte schreiben {icon="point"}

- Nutze lesbare Namen von Tabellen, Ansichten und Feldern, wenn sie eindeutig sind.
- Setze Namen mit Leerzeichen oder Satzzeichen in doppelte Anführungszeichen.
- Nutze einfache Anführungszeichen für Textliterale.
- Nutze nach Joins Quellenaliasse, zum Beispiel `customer.Name`.
- Nutze öffentliche IDs in geschweiften Klammern, wenn eine erzeugte Konfiguration oder eine Migration einen unveränderlichen Verweis braucht.
- Verwende keine entfernten `#field`-Aliasse.

Ein Alias nach `as` muss mit einem Buchstaben oder Unterstrich beginnen. Danach kann er Buchstaben, Zahlen und Unterstriche enthalten, bis zu 64 Zeichen. Ein Alias darf kein GQL-Schlüsselwort, kein logischer Operator und kein reserviertes Literal sein. Spätere Verweise auf einen Alias ignorieren Groß- und Kleinschreibung.

Hat ein Abfrageeditor einer Tabelle oder Ansicht kein `from`, kann die aktuelle Seite die Quelle liefern. Schreibe `from` ausdrücklich, wenn die Abfrage auch außerhalb dieser Seite verständlich bleiben muss.

## Bedingungen schreiben {icon="search"}

Nutze `=`, `!=`, `>`, `>=`, `<` und `<=` für Vergleiche. Kombiniere Bedingungen mit `and`, `or`, `not` und Klammern:

```gql
from table Inventory
where (Status = 'Available' or Status = 'Reserved') and Quantity > 0
sort Name asc
```

Nutze die Operatoren zwischen Ausdrücken. Schreibe nicht die Funktionsformen `AND(...)`, `OR(...)` oder `NOT(...)`.

Texthilfen sind `contains`, `startswith`, `endswith` und die Varianten `icontains`, `istartswith` und `iendswith`, die Groß- und Kleinschreibung ignorieren. Mitgliedschaftshilfen unterstützen kontrollierte Felder und Felder mit mehreren Werten:

- `oneof(Field, 'a', 'b')`
- `noneof(Field, 'a', 'b')`
- `containsall(Field, 'a', 'b')`

Nutze `null` für einen fehlenden Wert. Die Sortierung ist standardmäßig aufsteigend und setzt fehlende Werte ans Ende. Ergänze `desc`, `nulls first` oder `nulls last` für eine andere Reihenfolge.

Eine Bedingung kann auch eine Formel sein:

```gql
from table Products
where Price <= "Purchase price" * 1.10
select Name, Price, "Purchase price"
```

[Formeln](/app/grids/help/grids-formulas) beschreibt die Ausdruckssyntax und den vollständigen Funktionskatalog.

## Den Kontext einer Grids App verwenden {icon="app-window"}

Abfragen in Grids Apps erhalten automatisch einen typisierten Anfragekontext. Grids bindet die Werte getrennt vom Abfragetext.

| Referenz | Wert |
| --- | --- |
| `@auth.id` | UUID des aktuellen Kontos oder `null` für anonyme Besucher |
| `@auth.subjects` | Flache UUID-Liste mit der aktuellen Person und allen wirksamen direkten oder verschachtelten Gruppen; für anonyme Besucher leer |
| `@params.<name>` | Ein deklarierter und validierter Seitenparameter |
| `@page.id`, `@page.title`, `@page.url` | Identität und kanonische relative URL der aktuellen Seite |
| `@app.id`, `@app.name` | Identität der veröffentlichten Grids App |
| `@base.id`, `@base.name` | Identität der zugehörigen Basis |
| `@time.now`, `@time.today`, `@time.timeZone` | Ein Anfragezeitpunkt, das lokale Datum und die IANA-Zeitzone |

Nutze `@auth.id != null`, wenn eine Abfrage ein angemeldetes Konto erfordert. Erkenne eine anonyme App-Anfrage ausdrücklich mit `@auth.id = null`. Unbekannte Namensräume und nicht deklarierte Parameter sind Veröffentlichungsfehler.

Nutze `oneof(Participants, @auth.subjects)`, wenn ein Principal-Feld der aktuellen Person oder einer ihrer wirksamen Gruppen Zugriff auf einen Datensatz gibt. Der Server ermittelt die wirksamen Gruppenmitgliedschaften. Die Abfrage erhält nie Gruppenmitglieder oder Gruppennamen. `@auth.subjects` ist eine Liste. Es ist deshalb nur in den Mitgliedschaftsprädikaten `oneof`, `noneof` oder `containsall` gültig.

```gql
from table Loans
where oneof(Participants, @auth.subjects)
```

```gql
from table Loans
where record.createdBy = @auth.id and Status = 'Active'
limit 100
```

Regeln für `availableWhen` auf Seiten, Blöcken, Formularen und Aktionen verwenden denselben Kontext. Ein Element ist nur verfügbar, wenn seine begrenzte Abfrage mindestens eine Zeile liefert. Fehler, fehlende Werte, Zeitüberschreitungen, Abbrüche und ein leeres Ergebnis bedeuten alle nicht verfügbar.

```gql
from table Loans
where record.id = @params.loan_id and Status = 'Active'
limit 1
```

### Kompatible Prädikate prüfen

| Feldwert | Unterstützte direkte Prädikate |
| --- | --- |
| Text, Langtext, ID | `=`, `!=`, `contains`, `startswith`, `endswith`, `icontains`, `istartswith`, `iendswith` |
| Zahl, Prozent, Dauer | `=`, `!=`, `<`, `<=`, `>`, `>=` |
| Datum | `=`, `!=`, `<`, `<=`, `>`, `>=`; schreibe Datums- und Datum-Uhrzeit-Werte als ISO-Werte in einfachen Anführungszeichen |
| Boolean | `= true`, `= false`, `!= true`, `!= false` oder nur das Feld |
| Auswahl | `=`, `!=`, `oneof`, `noneof`, `containsall`; Werte können Optionsbezeichnungen oder Options-IDs sein |
| Relation | `=`, `!=`, `oneof`, `noneof`, `containsall`; Werte sind öffentliche IDs verknüpfter Datensätze |

`Feld = null` bedeutet leer. `!= null` bedeutet nicht leer. Dateifelder gespeicherter Tabellen unterstützen nur diese Existenzprüfungen. Dateifelder kombinierter Tabellen unterstützen sie nicht. JSON ist nicht filterbar. Berechnete Skalare können boolesche Formeln verwenden.

Verknüpfte `oneof`, `noneof` und `containsall` behalten typisierte Werte und Zugriffsprüfungen. So prüft `oneof(cost.Verantwortliche, @auth.subjects)` eine Principal-Mitgliedschaft.

### Nach Datensatzmetadaten filtern

Datensatzmetadaten verwenden den reservierten Bereich `record`:

| Referenz | Verwendung |
| --- | --- |
| `record.id` | Gleicht mit `=` eine öffentliche Datensatz-ID oder mit `oneof(...)` mehrere ab |
| `record.createdBy` | Gleicht eine oder mehrere UUIDs erstellender Personen ab |
| `record.updatedBy` | Gleicht eine oder mehrere UUIDs zuletzt bearbeitender Personen ab |
| `record.deletedBy` | Gleicht eine oder mehrere UUIDs löschender Personen ab |
| `record.finalizationState` | Gleicht `draft`, `awaitingReview` oder `finalized` mit `=` oder `oneof(...)` ab |
| `record.finalizedAt` | Zeitpunkt der Finalisierung, der mit den Datensatzmetadaten zurückgegeben wird |
| `record.finalizedBy` | UUID der finalisierenden Person, die mit den Datensatzmetadaten zurückgegeben wird |
| `record.createdAt` | Sortiert nach Erstellungszeitpunkt |
| `record.updatedAt` | Sortiert nach dem letzten Aktualisierungszeitpunkt |
| `record.deletedAt` | Sortiert gelöschte Datensätze nach Löschzeitpunkt |

Metadatenfilter kannst du mit `and` kombinieren, aber nicht in einen `or`-Zweig setzen. Personenwerte sind UUIDs. Datensatzwerte sind öffentliche IDs, keine Anzeigenamen.

`awaitingReview` bedeutet, dass eine aktuelle Vier-Augen-Anfrage noch zur Datensatzversion und zur Tabellenregel passt. Abgelehnte und ersetzte Anfragen sind Verlauf, kein aktueller Zustand des Datensatzes. Eine Tabelle ohne aktivierte Finalisierung hat keine Datensätze im Zustand `draft`.

## Gruppieren und aggregieren {icon="chart-bar"}

`group by` liefert eine Zeile pro unterschiedlichem Wert. Datumsfelder können zusätzlich `by day`, `week`, `month`, `quarter` oder `year` verwenden. Jedes Nicht-Aggregatfeld, das eine gruppierte `sort` verwendet, muss auch in `group by` stehen. Aggregataliasse kannst du direkt sortieren.

Jedes Aggregat braucht einen Ausgabealias:

```gql
from table Orders
where Status = 'Paid'
group by Customer
aggregate count(*) as orders, sum(Total) as revenue, latest("Ordered at") as last_order
having revenue >= 1000
sort revenue desc nulls last
```

| Aggregat | Akzeptierte Eingabe |
| --- | --- |
| `count(*)` | Alle passenden Datensätze; `*` ist nur mit `count` gültig |
| `count(field)`, `countEmpty(field)`, `countUnique(field)` | Jedes lesbare Feld oder jede Formel |
| `sum(field)`, `avg(field)`, `median(field)` | Numerische Felder und Formeln |
| `min(field)`, `max(field)` | Zahlen-, Datums-, Datum-Uhrzeit- oder Textfelder und Formeln |
| `earliest(field)`, `latest(field)` | Datums- oder Datum-Uhrzeit-Felder und Formeln |

Um einen berechneten Wert zu aggregieren, schreibe `aggregate sum(formula(Quantity * Price)) as revenue`. Grids wertet die Formel für jeden Quelldatensatz aus, bevor das Aggregat die Ergebnisse kombiniert.

Lass `group by` weg, um eine Zusammenfassungszeile für die ganze passende Menge zu berechnen:

```gql
from table Orders
where Status = 'Paid'
aggregate count(*) as orders, sum(Total) as revenue
having orders >= 1
```

Eine reine Aggregatabfrage kann mit `having` ihre Zusammenfassungszeile behalten oder entfernen. Sie kann nicht zusätzlich Datensatzfelder auswählen oder ihre einzige Ergebniszeile sortieren. Ergänze `group by`, wenn du mehrere sortierbare Zusammenfassungszeilen brauchst.

## Ergebnisse seitenweise durchlaufen {icon="point"}

Ohne `limit` kann eine Ergebnisansicht alle passenden Zeilen Seite für Seite durchlaufen. Mit `limit 100` endet das vollständige Ergebnis nach 100 Zeilen, auch wenn die Oberfläche es in kleineren Seiten zeigt.

Eine geänderte Abfrage beginnt wieder auf der ersten Seite. Seiten zeigen Live-Daten, kein eingefrorenes Ergebnis. Datensätze, die sich zwischen Seitenaufrufen ändern, können deshalb zwischen Seiten wechseln.

Für automatisierte Lesevorgänge kann die CLI mit `--page-size` eine begrenzte Seite anfordern oder mit `--all --max-rows N` fortfahren.

## Zugriff und unterstützte Abfragen verstehen {icon="shield-lock"}

Grids-Abfragen auf Rohdaten erfordern Zugriff **Ansehen** auf die Base und können die ganze Base lesen. Veröffentlichte Abfragen einer Grids App laufen stattdessen über den unveränderlichen Capability-Snapshot der App. Sie können nicht auf nicht deklarierte Quellen oder Felder ausweichen.

Die Autovervollständigung folgt derselben Grenze. Der Editor für Rohdaten verwendet das aktuelle Schema der Base. Ein Editor in einer Grids App verwendet einen reinen Schemakatalog dieser App-Definition. Er führt keine Abfragen aus und zeigt keine andere Base.

GQL unterstützt bewusst keine beliebigen Join-Bedingungen, Unterabfragen, Common Table Expressions, Fensterfunktionen oder uneingeschränkten Ausdrücke. Eine nicht unterstützte Abfrage scheitert mit einer Diagnose. Grids rät sie nie und wendet sie nie teilweise an.

## Abfrageergebnisse als Ansichten speichern {icon="search"}

Tabellen- und Ansichtsergebnisse mit Zeilen lassen sich wie Datensätze anzeigen und seitenweise durchlaufen. Gruppierte und reine Aggregatergebnisse verwenden eine Zusammenfassungstabelle und sind nicht bearbeitbar. Kompatible Abfrageergebnisse kannst du als Ansichten speichern. Grids Apps, Dokumente und Exporte können sie wiederverwenden.

Nutze eine gespeicherte Ansicht, wenn Personen das Ergebnis im Arbeitsbereich der Base wiederholt öffnen. Halte das GQL lokal in einem Block einer Grids App oder in einem Dokument, wenn die Abfrage nur für diese Ressource existiert.

## Datensätze mit erzeugten Dokumenten finden {icon="search"}

In Abfragen der Base zählt `documentCount()` die eindeutig zugeordneten Dokumente. `latestDocumentAt()` liefert deren letzten Erstellungszeitpunkt oder null. Ein optionales Format wählt `pdf`, `csv`, `json`, `xml`, `sepa-xml` oder `datev-csv`.

```gql
from table Expenses
select Description, documentCount('sepa-xml') as exports
where documentCount('sepa-xml') = 0
```

- Diese Werte bleiben nach der Finalisierung aktuell. Sie folgen keinen Relationen und belegen keine Zahlung.
- Ein Dokument für mehrere Datensätze zählt bei jedem ausdrücklich zugeordneten Datensatz einmal.
- Diese Funktionen sind nicht in gespeicherten Formelfeldern oder Custom-App-Abfragen verfügbar.
- Nutze sie in Zeilenprojektionen und `where`, nicht in Aggregaten oder `having`.
- Allgemeines `xml` und `csv` schließen SEPA- und DATEV-Exporte aus. `pdf` enthält auch E-Rechnungs-PDFs.

Metadatenfilter prüfen die zugeordneten Dokumente jedes infrage kommenden Datensatzes. Grenze große Auswahlen möglichst mit normalen Feldfiltern ein.

## Eine Abfrage reparieren {icon="lifebuoy"}

:::reference
- **Unbekannte Quelle oder unbekanntes Feld:** Prüfe Schreibweise, Anführungszeichen, aktuelle Base und Zugriff.
- **Mehrdeutiger Name:** Ergänze einen Quellenalias oder nutze ein eingegrenztes Feld wie `customer.Name`.
- **Ein Join muss auf eine ID zeigen:** Verbinde das Relationsfeld mit `.id` des verbundenen Alias.
- **Eine gruppierte Sortierung wird abgelehnt:** Sortiere nach einer Gruppen- oder Aggregatausgabe, die in der Zusammenfassung vorkommt.
- **Fehlende Zeilen:** Prüfe `where`, `search`, die Quellansicht, den Modus für gelöschte Datensätze und `limit`.
- **Instabile Seitenreihenfolge:** Ergänze eine fachliche Sortierung, bevor du Seiten durchläufst oder `offset` verwendest.
:::

:::note GQL ist kein zweites Datenmodell
GQL formt gespeicherte Daten. Es kopiert keine Datensätze und umgeht keine Zugriffs-, Feld- oder Relationsregeln der Base.
:::
