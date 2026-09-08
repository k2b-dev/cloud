---
id: grids-tables-fields
title: Tabellen und Felder
icon: ti ti-table
description: Wähle Feldtypen und verwalte den Lebenszyklus gespeicherter Datensätze.
order: 110
---
Eine Tabelle speichert eine bestimmte Art von Datensätzen. Ihre Felder bestimmen, welche Informationen jeder Datensatz enthalten kann und wie Grids diese Werte in Tabellen, Formularen, Filtern, Formeln, Dokumenten, Workflows und Exporten verarbeitet.

Wähle den Feldtyp nach der Bedeutung des Werts, nicht nur nach seinem gewünschten Aussehen.

Personen mit Administratorrechten für eine Basis können **Basiseinstellungen → Tabellen** öffnen, Tabellen anhand ihres Namens oder ihrer öffentlichen ID finden und Struktur sowie Schutzeinstellungen an einer Stelle vergleichen. Die Übersicht zeigt die Anzahl aller Felder, indexierten Felder und eindeutigen Felder zusammen mit dem nachweisbaren Verlauf, der Finalisierung und den erlaubten Schreibwegen. Sie berechnet keine Anzahl der Datensätze. Öffne die Tabelle, um ihre Datensätze, ihr Schema oder die Einstellungen unter **Verlauf und Schutz** aufzurufen.

## Felder für eingegebene Werte {icon="table"}

| Feldtyp | Verwendung | Wichtiges Verhalten |
| --- | --- | --- |
| Text | Namen, Codes, E-Mail-Adressen und kurze Bezeichnungen | Einzeiliger Text; eine gute Vorgabe für die Datensatzbezeichnung |
| Langtext | Notizen und Beschreibungen | Kann bei entsprechender Konfiguration Markdown darstellen |
| Zahl | Mengen, Preise, Messwerte und exakte Dezimalberechnungen | Kann eine Einheit und Dezimalstellen anzeigen |
| Prozent | Prozentwerte | Verwendet standardmäßig 0–100; ein Feld kann stattdessen die Bruchskala 0–1 verwenden |
| Ja/Nein | Ja/Nein-Angaben | Speichert wahr, falsch oder bei optionalen Feldern keinen Wert |
| Datum | Einen Tag oder einen genauen Zeitpunkt | Werte vom Typ Datum und Uhrzeit stellen einen Zeitpunkt dar; die Vorgabe für die aktuelle Zeit verwendet den Zeitpunkt, zu dem ein neuer Datensatz gespeichert wird |
| Dauer | Verstrichene Zeit | Wird in Sekunden gespeichert; akzeptiert Sekunden, `MM:SS` oder `HH:MM:SS` |
| Auswahl | Einen Wert aus einer festgelegten Liste | Optionen können Bezeichnungen, Farben und Beschreibungen haben; eine Auswahl kann mehrere Werte zulassen |
| Personen und Gruppen | Eine oder mehrere verantwortliche Personen oder Gruppen | Speichert typisierte Verweise auf Cloud-Personen und -Gruppen; die Auswahl zeigt nur Identitäten, die das aktuelle Konto finden darf |
| JSON | Strukturierte Daten, die keine eigenen Grids-Felder benötigen | Sparsam einsetzen; einzelne Eigenschaften lassen sich weniger bequem filtern und erklären |
| Datei | Anhänge und Bilder | Das Feld steuert akzeptierte Dateitypen und die Dateianzahl; Grids setzt die konfigurierte Obergrenze für Uploads durch |

Nutze **Erforderlich**, wenn ein fehlender Wert einen Datensatz ungültig machen würde. Ein **Standardwert** ergänzt einen Wert nur, wenn ein neuer Datensatz dieses Feld auslässt. Nutze **Eindeutige Werte** für Kennungen, die sich nicht wiederholen dürfen, etwa eine Inventarnummer oder Rechnungsnummer.

Die Darstellung von Werten vom Typ Datum und Uhrzeit, datumsbezogene Filter, Formeln, Exporte und Dokumentordner verwenden nach Möglichkeit die Zeitzone des Browsers und sonst die Zeitzone der Cloud-Anwendung. Reine Datumswerte bleiben Kalendertage. Geplante Workflows verwenden die in ihrer YAML-Datei angegebene IANA-Zeitzone und standardmäßig UTC, wenn sie fehlt.

## Verknüpfte oder berechnete Felder {icon="table"}

- **Relation** verknüpft einen Datensatz mit einem oder mehreren Datensätzen in einer anderen Tabelle. Die Datensatzbezeichnung der Zieltabelle erscheint in Auswahlfeldern und Zellen.
- **Personen und Gruppen** weist einem Datensatz eine oder mehrere Cloud-Personen oder -Gruppen zu. Nutze das Feld für Beteiligte, Verantwortliche, Prüfende oder zuständige Teams, statt Namen oder E-Mail-Adressen in Geschäftsdaten zu kopieren.
- **Lookup** zeigt ein Feld aus einem verknüpften Datensatz an, ohne es zu kopieren.
- **Rollup** fasst Werte zusammen, die über eine Relation erreichbar sind.
- **Formel** berechnet bei jedem Lesen eines Datensatzes einen Wert aus den Feldern dieses Datensatzes.
- **HTML-Vorlage** rendert Liquid und optionales CSS zu einem HTML-String je Datensatz. Sie kann normale Felder sowie Ergebnisse aus Lookup, Rollup und Formel verwenden. Werte werden standardmäßig maskiert. Prüfe die Vorschau, bevor du `raw` verwendest.
- **ID** erstellt eine stabile, generierte Kennung. Sequence- und Date-sequence-IDs verwenden eine dauerhafte Zahlenreihe, die Grids beim Erstellen eines Datensatzes zuweist. Die Werte steigen atomar und werden nie wiederverwendet; Rollbacks und technische Fehler können Lücken hinterlassen. Änderungen an Präfix oder Format betreffen nur zukünftige Datensätze.
- **Erstellt am, Erstellt von, Geändert am und Geändert von** sind systemverwaltete Felder. Sie beschreiben die Aktivität eines Datensatzes und können nicht wie gewöhnliche Geschäftswerte eingegeben werden.

Wähle eine Relation, wenn das Ziel eigene Details oder einen eigenen Lebenszyklus hat. Ein Kundenname, der in jede Rechnung eingetragen wird, ist nur Text. Eine Relation zum Kunden hält die Rechnung verbunden, wenn sich die Kundendaten ändern.

Die Live-Detailansicht eines Datensatzes zeigt neben seinen ausgehenden Relationen bis zu fünf Ergebnisse unter **Referenziert von**. Die Ergebnisse sind nach Quelltabelle und Relationsfeld gruppiert. **Weitere laden** lädt die nächste begrenzte Seite. Die Liste folgt den aktuellen Leseberechtigungen und ergänzt die Felddaten des Datensatzes nie um eingehende Verknüpfungen.

In der CLI nutzt du `cld grids records referenced-by <table-id> <record-id> --limit 5 --json`. Kommentare sind über `records comments list|create|update|delete` verfügbar: mit `--body-file` für Markdown und `--yes` zum Löschen. Beide Listen akzeptieren `--cursor` und liefern `nextCursor`. Diese Befehle verwenden öffentliche IDs und behalten die Base-, Autoren- und Moderationsberechtigungen der Detailansicht bei.

Werte in Feldern für Personen und Gruppen verwenden das Cloud-Identitätsverzeichnis, werden dadurch aber nicht zu Cloud-Berechtigungen. Vollständige Konten können aus dem Verzeichnis auswählen. Gastkonten können sich selbst und ihre direkten oder verschachtelten Gruppen auswählen, aber keine anderen Personen oder Gruppenmitglieder finden. Der Server prüft dieselbe Sichtbarkeit beim Speichern erneut, sodass eine verborgene UUID nicht über die API erraten werden kann.

HTML-Vorlagenfelder sind schreibgeschützte Ausgabespalten, keine Dokumente. Nutze sie, wenn jeder Datensatz einen E-Mail-Text, eine Artikelbeschreibung, einen Produktausschnitt oder einen Exportwert benötigt. Nutze Dokumente, wenn die Ausgabe einen unveränderlichen Snapshot, Download oder eine PDF-Datei braucht. Tabellen können den maskierten Quelltext zeigen. Damit langes Markup die anderen Felder nicht verdeckt, zeigt die Detailansicht eines Datensatzes nur die Aktion **Vorschau**. Vorschauen öffnen sich in einem isolierten Frame. Grids fügt den Wert nie direkt in die Datensatzseite ein.

Vorlagen lesen stabile öffentliche Feld-IDs wie `{{ record.data.aB12xZ }}`. Der Editor zeigt den zugehörigen Feldnamen in der Autovervollständigung. Andere HTML-Vorlagenfelder sind absichtlich nicht verfügbar, damit Vorlagen sich nicht rekursiv aufrufen können. HTML-Vorlagenfelder sind nur in gespeicherten Tabellen verfügbar. Sie können nicht gefiltert, sortiert, gruppiert, aggregiert, in Formeln verwendet oder über einen Relation-Lookup ausgewählt werden.

## Formeln in einer Tabelle {icon="table"}

Formelfelder verwenden dieselbe Ausdruckssprache wie berechnete Abfragespalten. Verweise anhand ihres Namens auf Felder, setze Namen mit Leerzeichen in doppelte Anführungszeichen und Textliterale in einfache Anführungszeichen.

**Zeilensumme**

```text
"Unit price" * Quantity
```

**Lesbarer Ersatzwert**

```text
IFEMPTY(Notes, 'No notes')
```

**Tage bis zur Fälligkeit**

```text
DATEDIFF(TODAY(), "Due date", 'days')
```

Öffne **Formeln**, um die vollständige Funktionsreferenz zu sehen. Nutze `IFERROR` nur, wenn ein Fehler ein erwarteter Fall ist, etwa eine Division durch null. Lass den Fehler andernfalls auf eine fehlerhafte Formel hinweisen.

## Suche, Filter und Indizes {icon="search"}

Text, Langtext, IDs, Zahlen, Prozentwerte, Zeitspannen, Datumswerte, Ja/Nein-Werte, Auswahlbezeichnungen und lesbare Relationsbezeichnungen nehmen an der allgemeinen Suche teil. Nutze Filter für genaue Bedingungen sowie Regeln für berechnete Werte, Lookups, Rollups, Dateien oder leere Werte.

Ein Index hilft bei Feldern, die häufig für Filter, Sortierungen, Suchen, Joins oder Eindeutigkeitsprüfungen verwendet werden. Jeder Index verursacht auch zusätzliche Arbeit beim Schreiben. Füge daher einen Index für ein beobachtetes Zugriffsmuster hinzu, nicht für jedes Feld.

## Identität und Verlauf von Datensätzen {icon="table"}

Wähle für jede Tabelle eine kurze, verständliche **Datensatzbezeichnung**. Sie dient als Titel in Relationsauswahlfeldern und Detailansichten. Eine lange Beschreibung ist meist eine schlechte Bezeichnung, selbst wenn sie eindeutig ist.

Ändert eine andere Person oder ein anderer Tab einen Datensatz, bevor deine Bearbeitung gespeichert wird, lehnt Grids die ältere Bearbeitung ab, statt neuere Daten stillschweigend zu überschreiben. Lade den Datensatz neu, prüfe die neueren Werte und wende deine Änderung erneut an.

Das Verschieben eines Datensatzes in den Papierkorb ist umkehrbar. Beim Wiederherstellen entsteht ein neuer Verlaufseintrag; der Eintrag zur Löschung bleibt erhalten.

Dateien haben unabhängig von ihrer aktuellen Zuordnung zu einem Feld einen eigenen Lebenszyklus. **Datei ersetzen** tauscht den aktuellen Anhang atomar aus. **Aus Datensatz entfernen** trennt ihn vom Datensatz und speichert handelnde Person, Zeitpunkt, Feld sowie unveränderliche Dateimetadaten im Verlauf. Eine geschützte Revision oder ein erzeugtes Artefakt kann die exakten Bytes nach der Trennung aufbewahren; eine ungeschützte Datei kann bereinigt werden. Das Entfernen eines Anhangs verspricht daher weder eine physische Löschung noch eine dauerhafte Aufbewahrung. Grids behauptet nicht, dass der Dateiverlauf allein rechtliche Vorgaben erfüllt.

### Dauerhafte Datensatz-Versionen aufbewahren

Eine Person mit Administratorrechten für eine Basis kann **Tabelleneinstellungen → Verlauf und Schutz** öffnen und **Nachweisbarer Verlauf** für eine gespeicherte Tabelle aktivieren. Die Aktivierung ist dauerhaft. Sie erstellt einen Ausgangsstand der zu diesem Zeitpunkt vorhandenen Datensätze und bewahrt danach jeden Erstellungs-, Änderungs-, Lösch-, Wiederherstellungs-, Relations- und Dateizustand als nur anfügbaren Versionsstand auf.

Dieser Ausgangsstand ist der früheste Zustand, den Grids belegen kann. Er rekonstruiert keine Änderungen vor der Aktivierung. Bei größeren Tabellen schützt Grids den Ausgangsstand in fortsetzbaren Batches. Gewöhnliche Schreibvorgänge bleiben verfügbar und werden atomar erfasst, während der Ausgangsstand erstellt wird.

Personen mit Lesezugriff auf einen aktuellen Datensatz können in seiner Detailansicht **Datensatzversionen** öffnen. Eine Version zeigt die damals gültigen Bedeutungen der Felder und ermöglicht den Download genau der Dateien, die diese Version aufbewahrt. Der nachweisbare Verlauf erhöht den Speicherbedarf, kann nicht deaktiviert werden und ist für sich genommen kein Nachweis der Einhaltung rechtlicher oder regulatorischer Vorgaben. Er ist nicht über normale Datensatzlisten oder Grids Apps verfügbar.

### Datensätze finalisieren

Nachdem der nachweisbare Verlauf seinen Ausgangsstand fertiggestellt hat, kann eine Person mit Administratorrechten für die Basis im selben Abschnitt **Verlauf und Schutz** die **Finalisierung von Datensätzen** aktivieren. Bestehende und neue Datensätze bleiben im Status Entwurf, bis jemand sie ausdrücklich finalisiert. Die Einstellung gehört zu einer gespeicherten Tabelle und bietet zwei Modi:

- **Direkt:** Eine Person mit Schreibzugriff kann den Datensatz selbst finalisieren.
- **Vier-Augen-Prinzip:** Eine Person mit Schreibzugriff fordert die Finalisierung der exakt aktuellen Datensatzversion an. Eine andere Person benötigt weiterhin Schreibzugriff und muss aktuell Mitglied der konfigurierten Prüfgruppe sein, um die Anfrage zu genehmigen und den Datensatz zu finalisieren.

Die Auswahl einer Prüfgruppe gewährt keinen Zugriff. Modus und Gruppe werden bei der Aktivierung der Finalisierung atomar gespeichert. Eine für das Vier-Augen-Prinzip vorgesehene Tabelle ist daher nie vorübergehend im direkten Modus verfügbar. Eine Änderung des Modus oder der Prüfgruppe macht offene Anfragen ungültig, damit eine alte Prüfung keine Arbeit nach einer neuen Richtlinie genehmigt. Änderungen an Werten, Relationen oder angehängten Dateien sowie das Verschieben eines Datensatzes in oder aus dem Papierkorb machen seine Anfrage ebenfalls ungültig. Reiche den aktuellen Stand erneut ein. Anfrage, Genehmigung, Ablehnung und die endgültige Sperre des Datensatzes bleiben im Audit-Verlauf sichtbar.

Jede Anfrage hat eine kurze öffentliche ID. Genehmigung und Ablehnung über die CLI erfordern genau diese ID. Eine Bestätigung kann sich daher nie auf eine neuere Ersatzanfrage beziehen.

Bei der Finalisierung prüft Grids jedes Pflichtfeld, weist alle für **Bei Finalisierung** konfigurierten fortlaufenden IDs zu, speichert die endgültige Version und sperrt den Datensatz anschließend dauerhaft in einem Vorgang. Seine Felder, Relationen, Dateien, sein Papierkorbstatus und seine endgültige Nummer können nicht mehr geändert werden. Ein erneuter Versuch gibt denselben finalisierten Datensatz zurück und weist nie eine zweite Nummer zu.

Bevor der erste Datensatz finalisiert wurde, kann eine Person mit Administratorrechten die Funktion deaktivieren, nachdem alle bei der Finalisierung zugewiesenen ID-Felder wieder auf **Bei Erstellung des Datensatzes** umgestellt wurden. Nach dem ersten finalisierten Datensatz ist die Tabelleneinstellung dauerhaft. Grids ergänzt keine fachliche Bedeutung für Rechnungen, Stornierungen, Korrekturen oder Compliance. Bilde diese mit gewöhnlichen Feldern, Relationen und Workflows ab.

## Kontext für Änderungen verlangen {icon="point"}

Unter **Tabelleneinstellungen → Datenintegrität** kann eine Person mit Administratorrechten Antworten vor sensiblen Feldänderungen, dem Verschieben von Datensätzen in den Papierkorb oder ihrer Wiederherstellung verlangen. Fragen können bei jeder Änderung oder nur bei Änderungen ausgewählter Felder gelten.

Die eingereichten Antworten werden mit dem Datensatzverlauf gespeichert. Grids kopiert Fragen und Optionsbezeichnungen in den Verlaufseintrag, damit ältere Einträge nach einer Änderung der Richtlinie verständlich bleiben.

## Ausgangspunkte für Datensatzänderungen wählen {icon="route"}

Unter **Tabelleneinstellungen → Datenintegrität → Datensatzänderungen** kann eine Person mit Administratorrechten für die Basis wählen, welche Bereiche von Grids eine gespeicherte Tabelle ändern dürfen. **Alle** ist die Vorgabe und behält das normale Verhalten bestehender Tabellen bei.

Ist **Alle** deaktiviert, wähle eine oder mehrere Quellen:

- **Direkte Bearbeitung und Datensatz-API** umfasst Bearbeitungen in der Basis oder einer Grids App, den Datensatzeditor, API, CLI und Importe.
- **Formulare** umfasst aktive Formulare einschließlich der in einer Grids App veröffentlichten Formulare.
- **Workflows und Aktionen** umfasst aktivierte Workflows, Ausführungsoptionen und veröffentlichte Aktionen von Grids Apps.

Die Richtlinie gilt für das Erstellen, Bearbeiten, Löschen und Wiederherstellen von Datensätzen sowie für Änderungen an Relationen und Dateien. Bevor eine Person mit Administratorrechten Formulare oder Workflows und Aktionen entfernt, zeigt Grids die aktiven Einstiegspunkte, die dann keine Änderungen mehr an der Tabelle vornehmen können. Wird eine Tabelle von sehr vielen Workflows verwendet, weist die Vorschau ausdrücklich darauf hin, wenn mehr betroffen sein könnten, als sie auflisten kann.

Ohne ausgewählte Quelle bleiben Datensatzänderungen gesperrt, bis eine Person mit Administratorrechten wieder eine Quelle erlaubt. Bestehende Datensätze bleiben lesbar. Die Richtlinie ersetzt weder Berechtigungen, Feldregeln, Audit-Anforderungen, den nachweisbaren Verlauf noch die Finalisierung und ist für sich genommen keine Garantie für die Einhaltung rechtlicher oder regulatorischer Vorgaben.

:::note Erst modellieren, dann darstellen
Der Feldtyp bestimmt die gespeicherte Bedeutung. Ansichten und Spalteneinstellungen bestimmen, wie der Wert in einem bestimmten Kontext dargestellt wird.
:::

:::note Begrenzte HTML-Exporte
CSV- und JSON-Exporte lassen HTML-Vorlagenfelder standardmäßig aus. Wähle ein solches Feld ausdrücklich aus und setze ein Abfragelimit von höchstens 1.000 Datensätzen, wenn der gerenderte HTML-Inhalt in den Export gehört.

Ein Lesevorgang oder Export rendert höchstens 2.000 HTML-Zellen und insgesamt 32 MiB HTML-Ausgabe. Zellen oberhalb dieses gemeinsamen Budgets zeigen einen Renderfehler, statt den Server zu überlasten. Fordere weniger Datensätze oder HTML-Felder an.
:::
