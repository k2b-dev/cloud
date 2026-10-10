---
id: grids-tables-fields
title: Tabellen und Felder
icon: ti ti-table
description: Wähle Feldtypen und steuere den Lebenszyklus gespeicherter Datensätze.
order: 110
---
Eine Tabelle speichert eine Art von Datensätzen. Wähle Feldtypen nach ihrer Bedeutung, nicht nur nach ihrem Aussehen.

Die [Feldkonfiguration](/app/grids/help/grids-field-configuration) beschreibt alle Konfigurationsschlüssel, Standardwerte, ID-Strategien und Spalten von Objektlisten.

Unter **Base-Einstellungen → Tabellen** suchen Personen mit Zugriff **Verwalten** nach Name oder öffentlicher ID. Sie vergleichen die Anzahl der Felder, Indizes und eindeutigen Felder sowie Verlauf, Finalisierung und Schreibwege. Öffne eine Tabelle für ihre Datensätze und Einstellungen. Die Übersicht zählt keine Datensätze.

## Eingegebene Werte speichern {icon="table"}

| Feldtyp | Verwendung | Wichtiges Verhalten |
| --- | --- | --- |
| Text | Namen, Codes, E-Mail-Adressen und kurze Bezeichnungen | Einzeiliger Text; eine gute Vorgabe für die Datensatzbezeichnung |
| Langtext | Notizen und Beschreibungen | Kann bei entsprechender Konfiguration Markdown darstellen |
| Zahl | Mengen, Preise, Messwerte und exakte Dezimalberechnungen | Kann eine Einheit und Dezimalstellen anzeigen |
| Prozent | Prozentwerte | Verwendet standardmäßig 0–100; ein Feld kann stattdessen die Bruchskala 0–1 verwenden |
| Ja/Nein | Ja/Nein-Angaben | Speichert wahr, falsch oder bei optionalen Feldern keinen Wert |
| Datum | Einen Tag oder einen genauen Zeitpunkt | Ein Wert mit Datum und Uhrzeit ist ein Zeitpunkt; die Vorgabe für die aktuelle Zeit verwendet den Zeitpunkt, zu dem ein neuer Datensatz gespeichert wird |
| Dauer | Verstrichene Zeit | Wird in Sekunden gespeichert; akzeptiert Sekunden, `MM:SS` oder `HH:MM:SS` |
| Auswahl | Einen Wert aus einer festgelegten Liste | Optionen können Bezeichnungen, Farben und Beschreibungen haben; eine Auswahl kann mehrere Werte zulassen |
| Personen und Gruppen | Eine oder mehrere verantwortliche Personen oder Gruppen | Speichert typisierte Verweise auf Cloud-Personen und -Gruppen; die Auswahl zeigt nur Identitäten, die das aktuelle Konto finden kann |
| JSON | Strukturierte Daten, die keine eigenen Grids-Felder brauchen | Sparsam einsetzen; einzelne Eigenschaften lassen sich schwerer filtern und erklären |
| Objektliste | Typisierte Zeilen, die zu diesem Datensatz gehören, etwa Rechnungspositionen | Gemeinsame Validierung, berechnete Spalten und atomare Finalisierung |
| Datei | Anhänge und Bilder | Das Feld steuert akzeptierte Dateitypen und die Dateianzahl; Grids setzt die konfigurierte Obergrenze für Uploads durch |

Nutze **Erforderlich**, wenn ein leerer Wert einen Datensatz ungültig macht. Ein **Standardwert** füllt einen Wert nur, wenn ein neuer Datensatz dieses Feld auslässt. Nutze **Eindeutige Werte** für Kennungen, die sich nicht wiederholen dürfen, etwa eine Inventarnummer oder eine Rechnungsnummer.

Anzeige von Datum und Uhrzeit, datumsbezogene Filter, Formeln, Exporte und Dokumentordner verwenden die Zeitzone des Browsers, wenn sie verfügbar ist. Sonst verwenden sie die Zeitzone der Cloud. Reine Datumswerte bleiben Kalendertage. Geplante Workflows verwenden die IANA-Zeitzone aus ihrem YAML und UTC, wenn sie fehlt.

## Werte verknüpfen oder berechnen {icon="table"}

- **Relation** verknüpft einen Datensatz mit einem oder mehreren Datensätzen einer anderen Tabelle. Zellen, Karten, Auswahlfelder und Filter zeigen die Datensatzbezeichnung der Zieltabelle.
- **Lookup** zeigt ein Feld aus einem verknüpften Datensatz, ohne es zu kopieren.
- **Rollup** fasst Werte zusammen, die eine Relation erreicht.
- **Formel** berechnet einen Wert aus den Feldern des aktuellen Entwurfs. Die Finalisierung friert das Ergebnis ein.
- **HTML-Vorlage** rendert Liquid und optionales CSS zu einem HTML-String je Datensatz. Sie kann normale Felder und die Ergebnisse von Lookups, Rollups und Formeln verwenden. Werte werden standardmäßig maskiert. Prüfe die Vorschau, bevor du `raw` verwendest.
- **ID** erstellt eine stabile, erzeugte Kennung. Sequence- und Date-sequence-IDs verwenden eine dauerhafte Nummernfolge. Grids vergibt die Nummer standardmäßig beim Erstellen oder, wenn so konfiguriert, beim Finalisieren. Die Werte steigen atomar und werden nie wiederverwendet. Rollbacks und technische Fehler können Lücken hinterlassen. Änderungen an Präfix oder Format betreffen nur künftige Datensätze. Alle Optionen beschreibt die [Feldkonfiguration](/app/grids/help/grids-field-configuration).
- **Erstellt am**, **Erstellt von**, **Geändert am** und **Geändert von** sind Felder, die das System füllt. Sie beschreiben die Aktivität eines Datensatzes. Personen können sie nicht als gewöhnliche Geschäftswerte eingeben.

Wähle eine Relation, wenn das Ziel eigene Details oder einen eigenen Lebenszyklus hat. Ein Kundenname, der in jede Rechnung getippt wird, ist nur Text. Eine Relation zum Kunden hält die Rechnung verbunden, wenn sich die Kundendaten ändern.

Die Live-Detailansicht eines Datensatzes zeigt neben seinen ausgehenden Relationen bis zu fünf Ergebnisse unter **Referenziert von**. Grids gruppiert die Ergebnisse nach Quelltabelle und Relationsfeld. **Weitere laden** lädt die nächste begrenzte Seite. Die Liste zeigt nur Datensätze, die du aktuell lesen kannst. Sie ergänzt die Felddaten des Datensatzes nie um eingehende Verknüpfungen.

In der CLI nutzt du `cld grids records referenced-by <table-id> <record-id> --limit 5 --json`. Kommentare zu Datensätzen sind über `records comments list|create|update|delete` verfügbar. Nutze `--body-file` für Markdown und `--yes` zum Löschen. Beide Listen akzeptieren `--cursor` und liefern `nextCursor`. Diese Befehle verwenden öffentliche IDs. Sie behalten dieselben Zugriffsregeln für Base, Autoren und Moderation wie die Detailansicht.

Werte vom Typ Personen und Gruppen geben keinen Zugriff. Vollständige Konten können das Verzeichnis nutzen. Gäste können nur sich selbst und ihre direkten oder verschachtelten Gruppen wählen, keine anderen Personen und keine Gruppenmitglieder. Beim Speichern prüft Grids die Sichtbarkeit erneut, auch bei Übermittlungen über die API.

HTML-Vorlagenfelder sind schreibgeschützte Ausgaben je Datensatz. Sie sind keine unveränderlichen Dokumente oder PDFs. Tabellen zeigen den maskierten Quelltext. Die Detailansicht bietet eine isolierte **Vorschau** und fügt nie HTML in die Datensatzseite ein.

Vorlagen verwenden öffentliche Feld-IDs, etwa `{{ record.data.aB12xZ }}`, und die Autovervollständigung zeigt die Namen. Andere HTML-Vorlagenfelder sind in einer Vorlage nicht verfügbar, um Rekursion zu verhindern. Diese Felder brauchen gespeicherte Tabellen. Sie unterstützen keine Filter, Sortierung, Gruppierung, Aggregate, Formeln oder Relation-Lookups.

## Formeln in einer Tabelle verwenden {icon="table"}

Die gemeinsame [Formelreferenz](/app/grids/help/grids-formulas) erklärt Syntax, Beispiele und Fehler. Eine Tabellenformel gehört zu jedem Datensatz. Eine berechnete Abfragespalte gehört nur zu ihrer Abfrage.

## Zeilen innerhalb eines Datensatzes speichern {icon="table"}

Wähle **Objektliste** für Positionen ohne eigenen Zugriff und ohne eigenen Lebenszyklus. Nutze sonst eine Relation. Klappe **Regeln und Berechnung** für Regeln oder Formeln auf, die Nachbarspalten verwenden. Auswahlspalten und Regex-Regeln gelten nur für Eingaben. Eine Zeile kann keine verschachtelten Objekte, Relationen oder Listen enthalten.

Bearbeite Zeilen auf Seiten mit je 25 Zeilen, ohne Änderungen oder gültige Vorschauen zu verlieren. Speichern validiert die Liste und ersetzt sie mit Versionsschutz. Standard sind 0–100 Zeilen. Die Grenzen sind 1.000 Zeilen, 200 Spalten und 256 KiB. Entfernte Spalten werden in Entwürfen ausgeblendet. Der gespeicherte Verlauf bleibt unverändert. Eine Spalte mit finalisierten Werten kannst du nicht entfernen.

`LIST_SUM(Items, 'Amount')` bildet eine Summe. `LIST_AVG`, `LIST_MIN` und `LIST_MAX` verwenden dieselben Argumente. `LIST_COUNT(Items)` zählt Zeilen. Eine leere Liste ergibt bei Summe und Anzahl `0`, bei anderen Auswertungen `null`. Eine fehlende Liste ergibt immer `null`. Die Finalisierung friert Zeilen und berechnete Werte gemeinsam ein und erhält exakte Beträge und Typen.

## Suchen, filtern und indizieren {icon="search"}

Die allgemeine Suche umfasst Text, Langtext, IDs, Zahlen, Prozentwerte, Zeitspannen, Datumswerte, Ja/Nein-Werte, Auswahlbezeichnungen und lesbare Relationsbezeichnungen. Nutze Filter für exakte Bedingungen und für Regeln zu berechneten Werten, Lookups, Rollups, Dateien oder leeren Werten.

Ein Index hilft bei Feldern, die oft zum Filtern, Sortieren, Suchen, für Joins oder Eindeutigkeitsprüfungen dienen. Jeder Index macht Schreibvorgänge aufwendiger. Lege einen Index für ein beobachtetes Zugriffsmuster an, nicht für jedes Feld.

## Identität und Verlauf von Datensätzen bewahren {icon="table"}

Wähle für jede Tabelle eine kurze, verständliche **Datensatzbezeichnung**. Sie ist der Titel in Relationsauswahlfeldern und Detailansichten. Eine lange Beschreibung ist meist eine schlechte Bezeichnung, auch wenn sie eindeutig ist.

Ändert eine andere Person oder ein anderer Tab einen Datensatz, bevor deine Bearbeitung gespeichert ist, lehnt Grids deine ältere Bearbeitung ab und überschreibt die neueren Daten nicht. Lade den Datensatz neu, prüfe die neueren Werte und wende deine Änderung erneut an.

Das Verschieben eines Datensatzes in den Papierkorb lässt sich rückgängig machen. Das Wiederherstellen erzeugt einen neuen Verlaufseintrag. Den Eintrag zur Löschung entfernt es nicht.

### Dateien anhängen

Um Dateien anzuhängen, wähle **Hochladen** oder ziehe Dateien von deinem Gerät auf das Feld im geöffneten Datensatz. Dateien, die nicht zu den erlaubten Typen oder zur Dateianzahl des Felds passen, nennt Grids und lässt sie weg. **Datei ersetzen** tauscht einen Anhang atomar aus. **Aus Datensatz entfernen** löst ihn und protokolliert Person, Zeitpunkt, Feld und unveränderliche Dateimetadaten.

Geschützte Revisionen oder Artefakte behalten die Bytes einer gelösten Datei. Ungeschützte Dateien kann Grids bereinigen. Das Lösen verspricht weder physische Löschung noch dauerhafte Aufbewahrung. Der Dateiverlauf allein belegt keine rechtliche Konformität.

### Dauerhafte Datensatzversionen aufbewahren

Du brauchst Zugriff **Verwalten** auf die Base.

:::warning Du kannst den dauerhaften Verlauf nicht ausschalten
Der dauerhafte Verlauf ist endgültig. Er behält jede Version eines Datensatzes und braucht mit der Zeit mehr Speicher.
:::

:::steps
1. Öffne **Tabelleneinstellungen → Verlauf und Schutz**.
2. Wähle **Dauerhaften Verlauf aktivieren**.
3. Wähle in der Bestätigung noch einmal **Dauerhaften Verlauf aktivieren**.
:::

Grids erfasst zuerst die bestehenden Datensätze als Ausgangsstand. Danach fügt es jeden Zustand nach Erstellen, Ändern, Löschen, Wiederherstellen sowie jeden Relations- und Dateizustand an. Der Ausgangsstand kann frühere Änderungen nicht rekonstruieren. Große Tabellen verwenden fortsetzbare Durchgänge. Normale Schreibvorgänge bleiben währenddessen verfügbar und werden atomar erfasst.

Personen, die einen aktuellen Datensatz lesen können, öffnen in seiner Detailansicht **Datensatzversionen**. Eine Version zeigt die Bedeutung der Felder zu ihrer Zeit. Du kannst genau die Dateien herunterladen, die diese Version behält. Der dauerhafte Verlauf ist für sich allein kein Nachweis rechtlicher oder regulatorischer Konformität. Normale Datensatzlisten und Grids Apps zeigen ihn nicht.

### Datensätze finalisieren

Nachdem der dauerhafte Verlauf seinen Ausgangsstand fertiggestellt hat, kann eine Person mit Zugriff **Verwalten** auf die Base im selben Abschnitt **Verlauf und Schutz** die **Finalisierung von Datensätzen** aktivieren. Bestehende und neue Datensätze bleiben Entwürfe, bis jemand einen ausdrücklich finalisiert. Die Einstellung gehört zu einer gespeicherten Tabelle und bietet zwei Modi:

- **Direkt:** Eine Person mit Zugriff **Bearbeiten** kann den Datensatz selbst finalisieren.
- **Vier-Augen-Prinzip:** Eine Person mit Zugriff **Bearbeiten** fordert die Finalisierung der exakt aktuellen Datensatzversion an. Eine andere Person genehmigt und finalisiert sie. Diese Person braucht weiterhin Zugriff **Bearbeiten** und muss aktuelles Mitglied der konfigurierten **Freigabegruppe** sein.

Die Freigabegruppe gibt keinen Zugriff. Modus und Gruppe werden atomar aktiviert, ohne zwischenzeitlichen Direktmodus. Eine Änderung der Regel macht offene Anfragen ungültig. Geänderte Werte, Relationen, Dateien, Papierkorbzustände oder aktive Felddefinitionen erfordern ebenfalls eine neue Anfrage. Das gilt auch für Feldnamen: Die prüfende Person genehmigt die Bedeutung des ganzen Datensatzes, nicht nur seine Summen. Anfragen, Entscheidungen und Finalisierung bleiben im Audit-Verlauf.

Jede Anfrage hat eine kurze öffentliche ID. Genehmigung und Ablehnung in der CLI erfordern genau diese ID. Eine Bestätigung kann sich deshalb nie auf eine neuere Ersatzanfrage beziehen.

Die Finalisierung prüft Pflichtfelder und vergibt IDs, die auf **Bei der Finalisierung** stehen. Sie friert typisierte Ergebnisse von Formeln, Lookups, Rollups und Listen ein. Danach sperrt sie den Datensatz atomar. Exakte Dezimalwerte bleiben für Berechnungen nutzbar. Felder, Relationen, Dateien, Papierkorbzustand und endgültige Nummern können sich nicht mehr ändern. Eine Wiederholung liefert denselben Datensatz und vergibt keine weitere Nummer.

Nur erfasste Berechnungen sind historische Werte. Ein Feld, das nach der Finalisierung hinzukommt, hat kein gespeichertes Ergebnis, und Grids rekonstruiert es nicht mit heutigen Formeln. Lies ein fehlendes Ergebnis nicht als Null. Verwende unvollständige Summen nicht für Finanzexporte.

:::warning Mit dem ersten finalisierten Datensatz wird die Finalisierung endgültig
Bevor der erste Datensatz finalisiert ist, kann eine Person mit Zugriff **Verwalten** die Funktion deaktivieren. Vorher muss sie alle ID-Felder, die bei der Finalisierung vergeben werden, wieder auf **Beim Erstellen des Datensatzes** stellen. Nach dem ersten finalisierten Datensatz ist die Tabelleneinstellung dauerhaft.
:::

Grids ergänzt keine fachliche Bedeutung für Rechnungen, Stornierungen, Korrekturen oder Compliance. Bilde sie mit gewöhnlichen Feldern, Relationen und Workflows ab.

## Kontext für Änderungen verlangen {icon="point"}

Unter **Tabelleneinstellungen → Datenintegrität** kann eine Person mit Zugriff **Verwalten** Antworten verlangen: vor sensiblen Feldänderungen, vor dem Verschieben von Datensätzen in den Papierkorb oder vor ihrer Wiederherstellung. Fragen können bei jeder Änderung gelten oder nur, wenn sich ausgewählte Felder ändern.

Grids speichert die eingereichten Antworten mit dem Datensatzverlauf. Es kopiert Fragen und Optionsbezeichnungen in den Verlaufseintrag. Ältere Einträge bleiben deshalb verständlich, wenn sich die Richtlinie ändert.

## Festlegen, wo Datensatzänderungen beginnen können {icon="route"}

Eine Person mit Zugriff **Verwalten** auf die Base kann **Tabelleneinstellungen → Datenintegrität → Datensatzänderungen** öffnen. Dort wählt sie, welche Bereiche von Grids eine gespeicherte Tabelle ändern können. **Alle** ist die Vorgabe und behält das normale Verhalten bestehender Tabellen bei.

Ist **Alle** ausgeschaltet, wähle eine oder mehrere Quellen:

- **Direkte Bearbeitung und Datensatz-API** umfasst Bearbeitungen in der Base oder in einer Grids App, den Datensatzeditor, die API, die CLI und Importe.
- **Formulare** umfasst aktive Formulare, auch Formulare, die in einer Grids App veröffentlicht sind.
- **Workflows und Aktionen** umfasst aktivierte Workflows, Ausführungsoptionen und veröffentlichte Aktionen von Grids Apps.

Die Richtlinie gilt für das Erstellen, Bearbeiten, Löschen und Wiederherstellen von Datensätzen und für Änderungen an Relationen und Dateien. Bevor jemand **Formulare** oder **Workflows und Aktionen** entfernt, zeigt Grids die aktiven Einstiegspunkte, die die Tabelle dann nicht mehr ändern. Bei einer Tabelle, die sehr viele Workflows verwenden, sagt die Vorschau ausdrücklich, wenn mehr betroffen sein können, als sie auflisten kann.

Ohne ausgewählte Quelle bleiben Datensatzänderungen gesperrt, bis eine Person mit Zugriff **Verwalten** wieder eine Quelle erlaubt. Bestehende Datensätze bleiben lesbar. Die Richtlinie ersetzt weder Zugriff noch Feldregeln, Audit-Anforderungen, den dauerhaften Verlauf oder die Finalisierung. Sie ist für sich allein keine Garantie für rechtliche oder regulatorische Vorgaben.

:::note Erst modellieren, dann darstellen
Der Feldtyp bestimmt die gespeicherte Bedeutung. Ansichten und Spalteneinstellungen bestimmen, wie ein Wert in einem bestimmten Kontext erscheint.
:::

:::note Begrenzte HTML-Exporte
CSV- und JSON-Exporte lassen HTML-Vorlagenfelder standardmäßig weg. Gehört das gerenderte HTML in einen Export, wähle das Feld ausdrücklich aus und setze ein Abfragelimit von höchstens 1.000 Datensätzen.

Ein Lesevorgang oder Export rendert höchstens 2.000 HTML-Zellen. Sie teilen sich ein Budget von insgesamt 32 MiB HTML-Ausgabe und 2 Sekunden Template-Rendering. Zellen jenseits dieses Budgets zeigen einen Renderfehler, statt den Server zu überlasten. Fordere weniger Datensätze oder HTML-Felder an.
:::
