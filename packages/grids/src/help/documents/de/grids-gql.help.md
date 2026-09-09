---
id: grids-gql
title: GQL
icon: ti ti-code
description: Grids-Daten mit der Grids Query Language finden, verbinden und zusammenfassen.
order: 125
---
GQL ist die Grids Query Language. Sie beschreibt, welche gespeicherten Daten du benötigst und wie Grids das Ergebnis strukturieren soll. Abfrage-Explorer, gespeicherte Ansichten, Blöcke in Grids Apps, Dokumentquellen, Exporte und die CLI verwenden dieselbe Sprache.

Für gewöhnliche Tabellenarbeit benötigst du kein GQL. Beginne mit den Steuerelementen für Suche, Filter, Sortierung und Berechnete Spalten. Nutze GQL, wenn eine präzise Abfrage als Text leichter zu verstehen, wiederzuverwenden oder zu prüfen ist.

## Abfrage mit KI {icon="sparkles"}

Wähle **Abfrage mit KI**, um einen Assistant-Entwurf mit dieser Base, Quelle und
Abfrage zu öffnen. Ergänze, was du finden möchtest, und sende ihn ab. Assistant
findet relevante Felder, prüft Abfragen und zeigt echte Ergebnisse mit denselben
Berechtigungen wie der Editor. Dieser Chat kann keine Datensätze oder das Schema
ändern.

Er kann eine Abfrage als Ansicht speichern, nachdem du Name und persönliche oder
geteilte Sichtbarkeit bestätigst. Beides erfordert Base-Adminrechte. Über den
zurückgegebenen Link öffnest du die Abfrage in einem neuen Browser-Tab; der Chat bleibt geöffnet. Sehr lange Abfragen musst
du gegebenenfalls kopieren. Vorschauen und einzelne Seiten sind keine vollständigen
Exporte.

Der integrierte Skill **cloud-grids** verweist für Produktfragen und Administration
auf die aktuelle Hilfe. Wenn kein Werkzeug eine Aktion unterstützt, erklärt
Assistant die Schritte in der Oberfläche. Der Skill vergibt keine Berechtigungen.

Beschreibe bei einer allgemeinen Anfrage zuerst das gewünschte Ergebnis, bevor
Assistant das Schema liest. Abfragefehler zeigen auch die technische Ursache und
Position. Eine Korrektur soll die fachlichen Bedingungen erhalten, etwa den
Ausleihstatus nicht durch den Positionsstatus ersetzen. Auswahl- und
Mitgliedschaftsfilter auf verknüpften Tabellen werden derzeit nicht unterstützt.
Eigenständige Assistant-Abfragen verwenden `TODAY()` und `NOW()`; der
Custom-App-Kontext `@auth` und `@time` wird hier nicht bereitgestellt.

## Eine erste Abfrage lesen {icon="search"}

Diese Abfrage liest die Tabelle Books, behält verfügbare Bücher, wählt drei Felder aus, sortiert die neuesten zuerst und gibt höchstens 25 Zeilen zurück:

```gql
from table Books
where Status = 'Available'
select Title, Author, Published
sort Published desc
limit 25
```

Jede Zeile enthält eine Klausel:

- `from` wählt eine Tabelle oder gespeicherte Ansicht aus.
- `where` entfernt Datensätze, die nicht einer exakten Regel entsprechen.
- `select` wählt die Ausgabespalten aus.
- `sort` legt die Reihenfolge fest.
- `limit` begrenzt bewusst das vollständige Ergebnis.

Schreibe Feld- und Tabellennamen so, wie sie in Grids angezeigt werden. Setze Namen mit Leerzeichen in doppelte Anführungszeichen, zum Beispiel `"Birth year"`. Setze Textwerte in einfache Anführungszeichen, zum Beispiel `'Available'`.

## Eine Abfrage sicher aufbauen {icon="search"}

Beginne nur mit der Quelle und zeige eine Vorschau an:

```gql
from table Books
```

Füge dann jeweils einen Aspekt hinzu: einen Filter, ausgewählte Felder und zuletzt eine aussagekräftige Sortierung. Der Editor löst beim Schreiben zugängliche Tabellen, Ansichten, Felder, Relationen und Aliasse auf. Diagnosen kennzeichnen Syntaxfehler, unbekannte Namen, Mehrdeutigkeiten, inkompatible Operationen und Berechtigungsfehler, statt Annahmen zu treffen.

Ohne `select` werden alle gewöhnlichen Felder der Quelle zurückgegeben. Aufwendige Felder, die erst nach der Abfrage berechnet werden, wie HTML-Vorlagen, erfordern ein ausdrückliches `select`. Liste wichtige Felder ausdrücklich auf, wenn ein gespeichertes Ergebnis, Dokument oder eine Integration eine stabile Ausgabe benötigt.

Ein ausdrücklich ausgewähltes HTML-Vorlagenfeld wird gerendert, nachdem die begrenzten primären Datensätze gelesen wurden. Es kann nicht in `where`, `sort`, `group by`, `aggregate`, `having` oder Formelausdrücken verwendet werden, weil Liquid und CSS erst nach dem Feststehen des Abfrageergebnisses gerendert werden. Auch die Auswahl einer HTML-Vorlage aus einer verbundenen Tabelle wird nicht unterstützt. Lege das Ausgabefeld stattdessen in der primären gespeicherten Tabelle an.

## Häufige Abfrageaufgaben {icon="search"}

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

Die Suche kann auf benannte Felder beschränkt werden:

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

Die Berechnung gehört nur zu diesem Ergebnis und erstellt kein Tabellenfeld.

**Datensätze zusammenfassen**

```gql
from table Orders
group by "Ordered at" by month
aggregate sum(Total) as revenue, count(*) as orders
having revenue > 0
sort "Ordered at" asc
```

Eine Gruppierung gibt Zusammenfassungszeilen statt bearbeitbarer Datensätze zurück. Nutze sie für Berichte, Diagramme, Grids Apps, Dokumente und Exporte. `where` filtert die Quelldatensätze vor der Gruppierung; `having` filtert die berechneten Gruppen.

**Einer Relation folgen**

Wenn Orders eine Relation zu Customer besitzt, kann ein Join Felder aus Customers bereitstellen:

```gql
from table Orders
left join table Customers as customer on Customer = customer.id
select "Order number", customer.Name as customer_name, Total
sort "Order number" asc
limit 50
```

Das Relationsfeld auf der linken Seite muss auf die `id` des verbundenen Alias zeigen. Nutze `left join`, wenn Datensätze ohne verknüpftes Ziel im Ergebnis verbleiben sollen.

## Reihenfolge der Klauseln {icon="search"}

Nicht jede Abfrage benötigt jede Klausel. Wenn du Klauseln kombinierst, behalte diese Reihenfolge bei, damit die Quelle leicht zu überblicken bleibt:

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

Nutze `from`, `where`, `search`, `having`, `limit`, `offset` und den Modus für gelöschte Datensätze jeweils höchstens einmal. Fasse mehrere Felder, Gruppen, Aggregate oder Sortierungen in einer kommagetrennten Klausel zusammen. Eine Abfrage darf mehrere Joins enthalten, weil jeder Join eine weitere Quelle einführt.

## Klauselreferenz {icon="search"}

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

Die beiden Klauseln für gelöschte Datensätze schließen sich gegenseitig aus. Normale Abfragen geben nur aktive Datensätze zurück.

`from view` beginnt mit der Abfrage der gespeicherten Ansicht und wendet anschließend die neuen Klauseln an. Das ist nützlich, wenn ein geprüftes Dataset bereits den richtigen Ausgangspunkt bildet. Nicht jede GQL-Abfrage lässt sich als verschachtelte Quelle verwenden: Eine gespeicherte Abfrage mit Relation-Joins, Vergleichen zwischen Feldern oder einem Offset ist beispielsweise nicht als `from view`-Quelle verfügbar. Grids lehnt solche Referenzen ab, statt ihre Filter wegzulassen. Führe die gespeicherte Abfrage direkt aus oder beginne mit ihrer Tabelle und übernimm die benötigten Klauseln ausdrücklich. Auch eine Ansicht, die nach Datensatzmetadaten filtert, kann nicht als Quelle einer anderen Ansicht dienen.

## Namen, Aliasse und Werte {icon="point"}

- Nutze lesbare Namen von Tabellen, Ansichten und Feldern, wenn sie eindeutig sind.
- Setze Namen mit Leerzeichen oder Satzzeichen in doppelte Anführungszeichen.
- Nutze einfache Anführungszeichen für Textliterale.
- Nutze nach Joins Quellenaliasse, zum Beispiel `customer.Name`.
- Nutze öffentliche IDs in geschweiften Klammern, wenn generierte Konfigurationen oder eine Migration eine unveränderliche Referenz benötigen.
- Verwende keine entfernten `#field`-Aliasse.

Aliasse nach `as` müssen mit einem Buchstaben oder Unterstrich beginnen. Danach dürfen sie Buchstaben, Zahlen und Unterstriche enthalten und höchstens 64 Zeichen lang sein. Ein Alias darf kein GQL-Schlüsselwort, logischer Operator oder reserviertes Literal sein. Bei späteren Referenzen auf Aliasse spielt die Groß- und Kleinschreibung keine Rolle.

Fehlt `from` in einem Tabellen- oder Ansichts-Abfrageeditor, kann die aktuelle Seite die Quelle vorgeben. Schreibe die Klausel ausdrücklich, wenn die Abfrage außerhalb dieser Seite verständlich bleiben soll.

## Bedingungen und Hilfsfunktionen {icon="search"}

Nutze `=`, `!=`, `>`, `>=`, `<` und `<=` für Vergleiche. Kombiniere Bedingungen mit `and`, `or`, `not` und Klammern:

```gql
from table Inventory
where (Status = 'Available' or Status = 'Reserved') and Quantity > 0
sort Name asc
```

Nutze die Operatoren zwischen Ausdrücken. Schreibe keine Funktionsformen wie `AND(...)`, `OR(...)` oder `NOT(...)`.

Texthilfen sind `contains`, `startswith`, `endswith` sowie die Varianten `icontains`, `istartswith` und `iendswith`, die Groß- und Kleinschreibung nicht beachten. Mitgliedschaftshilfen unterstützen kontrollierte Felder und Felder mit mehreren Werten:

- `oneof(Field, 'a', 'b')`
- `noneof(Field, 'a', 'b')`
- `containsall(Field, 'a', 'b')`

Nutze `null` für einen fehlenden Wert. Die Sortierung erfolgt standardmäßig aufsteigend und ordnet fehlende Werte zuletzt ein. Ergänze `desc`, `nulls first` oder `nulls last`, wenn eine andere Reihenfolge erforderlich ist.

Eine Bedingung kann auch eine Formel sein:

```gql
from table Products
where Price <= "Purchase price" * 1.10
select Name, Price, "Purchase price"
```

Öffne **Formeln** für die Ausdruckssyntax und den vollständigen Funktionskatalog.

## Kontext einer Grids App verwenden {icon="app-window"}

Abfragen in Grids Apps erhalten automatisch einen typisierten Anfragekontext. Werte werden getrennt vom Abfragetext gebunden.

| Referenz | Wert |
| --- | --- |
| `@auth.id` | UUID des aktuellen Kontos oder `null` für anonyme Besucher |
| `@auth.subjects` | Flache UUID-Liste mit der aktuellen Person und allen wirksamen direkten oder verschachtelten Gruppen; für anonyme Besucher leer |
| `@params.<name>` | Ein deklarierter und validierter Seitenparameter |
| `@page.id`, `@page.title`, `@page.url` | Identität und kanonische relative URL der aktuellen Seite |
| `@app.id`, `@app.name` | Identität der veröffentlichten Grids App |
| `@base.id`, `@base.name` | Identität der zugehörigen Basis |
| `@time.now`, `@time.today`, `@time.timeZone` | Ein Anfragezeitpunkt, das lokale Datum und die IANA-Zeitzone |

Nutze `@auth.id != null`, wenn eine Abfrage ein angemeldetes Konto erfordert. Eine anonyme App-Anfrage kann ausdrücklich mit `@auth.id = null` erkannt werden. Unbekannte Namensräume und nicht deklarierte Parameter führen zu Veröffentlichungsfehlern.

Nutze `oneof(Participants, @auth.subjects)`, wenn ein Principal-Feld der aktuellen Person oder einer ihrer wirksamen Gruppen Zugriff auf einen Datensatz gewährt. Wirksame Gruppenmitgliedschaften werden serverseitig aufgelöst. Die Abfrage erhält weder Gruppenmitglieder noch Gruppennamen. `@auth.subjects` ist eine Liste und deshalb nur in den Mitgliedschaftsprädikaten `oneof`, `noneof` oder `containsall` gültig.

```gql
from table Loans
where oneof(Participants, @auth.subjects)
```

```gql
from table Loans
where record.createdBy = @auth.id and Status = 'Active'
limit 100
```

Regeln für `availableWhen` auf Seiten, Blöcken, Formularen und Aktionen verwenden denselben Kontext. Sie sind nur verfügbar, wenn ihre begrenzte Abfrage mindestens eine Zeile zurückgibt. Fehler, fehlende Werte, Zeitüberschreitungen, Abbrüche und ein leeres Ergebnis bedeuten jeweils nicht verfügbar.

```gql
from table Loans
where record.id = @params.loan_id and Status = 'Active'
limit 1
```

### Kompatibilität von Prädikaten

Die folgenden einfachen Feldprädikate sind am klarsten, wenn sie passen. Eine boolesche Formel kann Felder oder berechnete Ausdrücke vergleichen, wenn ein direktes Prädikat nicht ausreicht.

| Feldwert | Unterstützte direkte Prädikate |
| --- | --- |
| Text, Langtext, ID | `=`, `!=`, `contains`, `startswith`, `endswith`, `icontains`, `istartswith`, `iendswith` |
| Zahl, Prozent, Dauer | `=`, `!=`, `<`, `<=`, `>`, `>=` |
| Datum | `=`, `!=`, `<`, `<=`, `>`, `>=`; schreibe Datums- und Datum-Uhrzeit-Werte als ISO-Werte in einfachen Anführungszeichen |
| Boolean | `= true`, `= false`, `!= true`, `!= false` oder nur das Feld |
| Auswahl | `=`, `!=`, `oneof`, `noneof`, `containsall`; Werte können Optionsbezeichnungen oder Options-IDs sein |
| Relation | `=`, `!=`, `oneof`, `noneof`, `containsall`; Werte sind öffentliche IDs verknüpfter Datensätze |

Der Vergleich eines filterbaren Felds mit `null` verwendet `=` für leer und `!=` für nicht leer. Andere Vergleiche mit `null` sind ungültig. Skalare Ausgaben von Formeln, Lookups und Rollups können an einer unterstützten Wahr/Falsch-Formel teilnehmen. JSON- und Dateifelder können nicht direkt gefiltert werden.

### Datensatzmetadaten

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

Metadatenfilter können mit `and` kombiniert, aber nicht in einem `or`-Zweig platziert werden. Personenwerte sind UUIDs; Datensatzwerte sind öffentliche IDs und keine Anzeigenamen.
`awaitingReview` bedeutet, dass eine aktuelle Vier-Augen-Anfrage weiterhin zur Datensatzversion und Tabellenrichtlinie passt. Abgelehnte und ersetzte Anfragen gehören zum Verlauf und sind keine aktuellen Datensatzstatus.
Eine Tabelle ohne aktivierte Finalisierung enthält keine Datensätze im Status `draft`.

## Referenz für Gruppierung und Aggregate {icon="chart-bar"}

`group by` gibt eine Zeile pro unterschiedlichem Wert zurück. Datumsfelder können zusätzlich `by day`, `week`, `month`, `quarter` oder `year` verwenden. Jedes Nicht-Aggregatfeld, das eine gruppierte Sortierung verwendet, muss auch in `group by` erscheinen. Aggregataliasse können direkt sortiert werden.

Jedes Aggregat benötigt einen Ausgabealias:

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

Aggregiere einen berechneten Wert mit `aggregate sum(formula(Quantity * Price)) as revenue`. Die Formel wird für jeden Quelldatensatz ausgewertet, bevor das Aggregat die Ergebnisse kombiniert.

Lasse `group by` weg, um eine Zusammenfassungszeile für die gesamte passende Menge zu berechnen:

```gql
from table Orders
where Status = 'Paid'
aggregate count(*) as orders, sum(Total) as revenue
having orders >= 1
```

Eine reine Aggregatabfrage kann mit `having` ihre Zusammenfassungszeile behalten oder entfernen. Sie kann nicht zugleich Datensatzfelder auswählen oder ihre einzelne Ergebniszeile sortieren. Ergänze `group by`, wenn du mehrere sortierbare Zusammenfassungszeilen benötigst.

## Seitennavigation und Ergebnisgrenzen {icon="point"}

Ohne `limit` kann eine Ergebnisansicht alle passenden Zeilen seitenweise durchlaufen. Mit `limit 100` endet das vollständige Ergebnis nach 100 Zeilen, auch wenn die Oberfläche es in kleineren Seiten darstellt.

Eine Änderung der Abfrage beginnt wieder auf der ersten Seite. Seiten zeigen aktuelle Daten statt eines eingefrorenen Ergebnisses. Datensätze, die sich zwischen Seitenanfragen ändern, können deshalb zwischen Seiten wechseln.

Für automatisierte Lesevorgänge kann die CLI mit `--page-size` eine begrenzte Seite anfordern oder mit `--all --max-rows N` fortfahren.

## Berechtigungen und unterstützte Abfragen {icon="shield-lock"}

Unmittelbare Grids-Abfragen erfordern Leseberechtigung für die Basis und können die vollständige Basis lesen. Veröffentlichte Abfragen einer Grids App laufen stattdessen über den unveränderlichen Capability-Snapshot der App. Sie können nicht auf nicht deklarierte Quellen oder Felder ausweichen.

Die Autovervollständigung folgt derselben Grenze: Der unmittelbare Editor verwendet das aktuelle Schema der Basis, ein Editor in einer Grids App dagegen einen reinen Schemakatalog für diese App-Definition. Er führt keine Abfragen aus und gibt keine andere Basis preis.

GQL unterstützt bewusst keine beliebigen Join-Bedingungen, Unterabfragen, Common Table Expressions, Fensterfunktionen oder uneingeschränkten Ausdrücke. Eine nicht unterstützte Abfrage scheitert mit einer Diagnose, statt erraten oder nur teilweise angewendet zu werden.

## Ansichten und Abfrageergebnisse {icon="search"}

Zeilenförmige Tabellen- und Ansichtsergebnisse können wie Datensätze dargestellt und seitenweise durchlaufen werden. Gruppierte und reine Aggregatergebnisse verwenden eine Zusammenfassungstabelle und sind nicht bearbeitbar. Kompatible Abfrageergebnisse können als Ansichten gespeichert und von Grids Apps, Dokumenten und Exporten wiederverwendet werden.

Nutze eine gespeicherte Ansicht, wenn Personen das Ergebnis im unmittelbaren Arbeitsbereich der Basis wiederholt öffnen. Halte GQL lokal in einem Block der Grids App oder einem Dokument, wenn die Abfrage nur für diese Ressource existiert.

## Eine Abfrage reparieren {icon="lifebuoy"}

:::reference
- **Unbekannte Quelle oder unbekanntes Feld:** Prüfe Schreibweise, Anführungszeichen, aktuelle Basis und Zugriff.
- **Mehrdeutiger Name:** Ergänze einen Quellenalias oder nutze ein eingegrenztes Feld wie `customer.Name`.
- **Ein Join muss auf eine ID zeigen:** Verbinde das Relationsfeld mit `.id` des verbundenen Alias.
- **Eine gruppierte Sortierung wird abgelehnt:** Sortiere nach einer Gruppierungs- oder Aggregatausgabe, die in der Zusammenfassung vorhanden ist.
- **Fehlende Zeilen:** Prüfe `where`, `search`, die Quellansicht, den Löschmodus und `limit`.
- **Instabile Seitenreihenfolge:** Ergänze eine fachliche Sortierung, bevor du Seiten durchläufst oder `offset` verwendest.
:::

:::note GQL ist kein zweites Datenmodell
GQL strukturiert gespeicherte Daten. Es kopiert keine Datensätze und umgeht keine Zugriffs-, Feld- oder Relationsregeln der Basis.
:::
