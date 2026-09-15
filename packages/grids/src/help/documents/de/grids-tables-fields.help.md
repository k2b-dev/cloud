---
id: grids-tables-fields
title: Tabellen und Felder
icon: ti ti-table
description: Wähle Feldtypen und verwalte den Lebenszyklus gespeicherter Datensätze.
order: 110
---
Eine Tabelle speichert eine Art von Datensätzen. Wähle Feldtypen nach ihrer Bedeutung, nicht nur nach ihrem Aussehen.

Unter **Basiseinstellungen → Tabellen** suchen Administratoren nach Namen oder öffentlicher ID und vergleichen Feld-, Index- und Eindeutigkeitsanzahlen, Verlauf, Finalisierung und Schreibwege. Für Datensätze und Einstellungen öffnest du die Tabelle; die Übersicht zählt keine Datensätze.

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
| Objektliste | Typisierte Zeilen dieses Datensatzes, etwa Rechnungspositionen | Gemeinsame Validierung, berechnete Spalten und atomare Finalisierung |
| Datei | Anhänge und Bilder | Das Feld steuert akzeptierte Dateitypen und die Dateianzahl; Grids setzt die konfigurierte Obergrenze für Uploads durch |

Nutze **Erforderlich**, wenn ein fehlender Wert einen Datensatz ungültig machen würde. Ein **Standardwert** ergänzt einen Wert nur, wenn ein neuer Datensatz dieses Feld auslässt. Nutze **Eindeutige Werte** für Kennungen, die sich nicht wiederholen dürfen, etwa eine Inventarnummer oder Rechnungsnummer.

Die Darstellung von Werten vom Typ Datum und Uhrzeit, datumsbezogene Filter, Formeln, Exporte und Dokumentordner verwenden nach Möglichkeit die Zeitzone des Browsers und sonst die Zeitzone der Cloud-Anwendung. Reine Datumswerte bleiben Kalendertage. Geplante Workflows verwenden die in ihrer YAML-Datei angegebene IANA-Zeitzone und standardmäßig UTC, wenn sie fehlt.

## Verknüpfte oder berechnete Felder {icon="table"}

- **Relation** verknüpft einen Datensatz mit einem oder mehreren Datensätzen in einer anderen Tabelle. Die Datensatzbezeichnung der Zieltabelle erscheint in Auswahlfeldern und Zellen.
- **Lookup** zeigt ein Feld aus einem verknüpften Datensatz an, ohne es zu kopieren.
- **Rollup** fasst Werte zusammen, die über eine Relation erreichbar sind.
- **Formel** berechnet aus den Feldern des aktuellen Entwurfs einen Wert. Die Finalisierung schreibt ihn fest.
- **HTML-Vorlage** rendert Liquid und optionales CSS zu einem HTML-String je Datensatz. Sie kann normale Felder sowie Ergebnisse aus Lookup, Rollup und Formel verwenden. Werte werden standardmäßig maskiert. Prüfe die Vorschau, bevor du `raw` verwendest.
- **ID** erstellt eine stabile, generierte Kennung. Sequence- und Date-sequence-IDs verwenden eine dauerhafte Zahlenreihe, standardmäßig beim Erstellen oder auf Wunsch erst beim Finalisieren. Die Werte steigen atomar und werden nie wiederverwendet; Rollbacks und technische Fehler können Lücken hinterlassen. Änderungen an Präfix oder Format betreffen nur zukünftige Datensätze. Alle Optionen stehen in der [Feldkonfiguration](/app/grids/help/grids-field-configuration).
- **Erstellt am, Erstellt von, Geändert am und Geändert von** sind systemverwaltete Felder. Sie beschreiben die Aktivität eines Datensatzes und können nicht wie gewöhnliche Geschäftswerte eingegeben werden.

Wähle eine Relation, wenn das Ziel eigene Details oder einen eigenen Lebenszyklus hat. Ein Kundenname, der in jede Rechnung eingetragen wird, ist nur Text. Eine Relation zum Kunden hält die Rechnung verbunden, wenn sich die Kundendaten ändern.

Die Live-Detailansicht eines Datensatzes zeigt neben seinen ausgehenden Relationen bis zu fünf Ergebnisse unter **Referenziert von**. Die Ergebnisse sind nach Quelltabelle und Relationsfeld gruppiert. **Weitere laden** lädt die nächste begrenzte Seite. Die Liste folgt den aktuellen Leseberechtigungen und ergänzt die Felddaten des Datensatzes nie um eingehende Verknüpfungen.

In der CLI nutzt du `cld grids records referenced-by <table-id> <record-id> --limit 5 --json`. Kommentare sind über `records comments list|create|update|delete` verfügbar: mit `--body-file` für Markdown und `--yes` zum Löschen. Beide Listen akzeptieren `--cursor` und liefern `nextCursor`. Diese Befehle verwenden öffentliche IDs und behalten die Base-, Autoren- und Moderationsberechtigungen der Detailansicht bei.

Personen- und Gruppenwerte vergeben keine Zugriffsrechte. Vollständige Konten nutzen das Verzeichnis; Gäste wählen nur sich selbst und ihre direkten/verschachtelten Gruppen, keine anderen Personen oder Gruppenmitglieder. Speichern prüft die Sichtbarkeit erneut, auch über die API.

HTML-Vorlagenfelder sind schreibgeschützte Ausgaben je Datensatz, keine unveränderlichen Dokumente oder PDFs. Tabellen zeigen maskierten Quelltext; die Detailansicht bietet eine isolierte **Vorschau**, ohne HTML in die Datensatzseite einzufügen.

Vorlagen nutzen öffentliche Feld-IDs wie `{{ record.data.aB12xZ }}`; die Autovervollständigung zeigt Namen. Andere HTML-Vorlagenfelder sind gegen Rekursion gesperrt. Diese Felder erfordern gespeicherte Tabellen und unterstützen keine Filter, Sortierung, Gruppierung, Aggregate, Formeln oder Relation-Lookups.

## Formeln in einer Tabelle {icon="table"}

Die [Formelreferenz](/app/grids/help/grids-formulas) erklärt Syntax, Beispiele und Fehler. Ein Formelfeld gehört zu jedem Datensatz; eine berechnete Abfragespalte nur zur jeweiligen Abfrage.

## Zeilen innerhalb eines Datensatzes {icon="table"}

Wähle **Objektliste** für Positionen ohne eigene Berechtigungen oder eigenen Lebenszyklus, sonst eine Relation. Unter **Regeln und Berechnung** stehen Regeln und Formeln mit Geschwisterspalten. Auswahlspalten und Regex-Regeln sind nur für Eingaben verfügbar. Verschachtelte Objekte, Relationen und Listen sind nicht erlaubt.

Bearbeite Zeilen auf Seiten mit je 25 Zeilen; Eingaben und gültige Vorschauen bleiben erhalten. Speichern prüft und ersetzt die Liste mit Versionsschutz. Standard: 0–100 Zeilen; Grenzen: 1.000 Zeilen, 200 Spalten, 256 KiB. Entfernte Spalten werden in Entwürfen ausgeblendet; gespeicherte Historie bleibt erhalten. Spalten mit finalisierten Werten können nicht entfernt werden.

`LIST_SUM(Items, 'Amount')` bildet eine Summe. `LIST_AVG`, `LIST_MIN` und `LIST_MAX` nutzen dieselben Argumente; `LIST_COUNT(Items)` zählt Zeilen. Eine leere Liste ergibt bei Summe/Anzahl `0`, sonst `null`; eine fehlende Liste ergibt immer `null`. Die Finalisierung schreibt Zeilen und berechnete Werte gemeinsam fest und erhält exakte Beträge und Typen.

## Suche, Filter und Indizes {icon="search"}

Text, Langtext, IDs, Zahlen, Prozentwerte, Zeitspannen, Datumswerte, Ja/Nein-Werte, Auswahlbezeichnungen und lesbare Relationsbezeichnungen nehmen an der allgemeinen Suche teil. Nutze Filter für genaue Bedingungen sowie Regeln für berechnete Werte, Lookups, Rollups, Dateien oder leere Werte.

Ein Index hilft bei Feldern, die häufig für Filter, Sortierungen, Suchen, Joins oder Eindeutigkeitsprüfungen verwendet werden. Jeder Index verursacht auch zusätzliche Arbeit beim Schreiben. Füge daher einen Index für ein beobachtetes Zugriffsmuster hinzu, nicht für jedes Feld.

## Identität und Verlauf von Datensätzen {icon="table"}

Wähle für jede Tabelle eine kurze, verständliche **Datensatzbezeichnung**. Sie dient als Titel in Relationsauswahlfeldern und Detailansichten. Eine lange Beschreibung ist meist eine schlechte Bezeichnung, selbst wenn sie eindeutig ist.

Ändert eine andere Person oder ein anderer Tab einen Datensatz, bevor deine Bearbeitung gespeichert wird, lehnt Grids die ältere Bearbeitung ab, statt neuere Daten stillschweigend zu überschreiben. Lade den Datensatz neu, prüfe die neueren Werte und wende deine Änderung erneut an.

Das Verschieben eines Datensatzes in den Papierkorb ist umkehrbar. Beim Wiederherstellen entsteht ein neuer Verlaufseintrag; der Eintrag zur Löschung bleibt erhalten.

**Datei ersetzen** tauscht einen Anhang atomar aus. **Aus Datensatz entfernen** trennt ihn und protokolliert Person, Zeitpunkt, Feld und unveränderliche Dateimetadaten. Geschützte Revisionen oder Artefakte bewahren seine Bytes; ungeschützte Dateien können bereinigt werden. Die Trennung verspricht weder physische Löschung noch dauerhafte Aufbewahrung. Der Dateiverlauf allein belegt keine rechtliche Konformität.

### Dauerhafte Datensatz-Versionen aufbewahren

Basis-Administratoren können unter **Tabelleneinstellungen → Verlauf und Schutz** den **Nachweisbaren Verlauf** dauerhaft aktivieren. Er erfasst bestehende Datensätze und fügt danach jeden Erstellungs-, Änderungs-, Lösch-, Wiederherstellungs-, Relations- und Dateizustand als Version an.

Der Ausgangsstand rekonstruiert keine früheren Änderungen. Große Tabellen verwenden fortsetzbare Batches; gewöhnliche Schreibvorgänge bleiben verfügbar und werden währenddessen atomar erfasst.

Personen mit Lesezugriff auf einen aktuellen Datensatz können in seiner Detailansicht **Datensatzversionen** öffnen. Eine Version zeigt die damals gültigen Bedeutungen der Felder und ermöglicht den Download genau der Dateien, die diese Version aufbewahrt. Der nachweisbare Verlauf erhöht den Speicherbedarf, kann nicht deaktiviert werden und ist für sich genommen kein Nachweis der Einhaltung rechtlicher oder regulatorischer Vorgaben. Er ist nicht über normale Datensatzlisten oder Grids Apps verfügbar.

### Datensätze finalisieren

Nachdem der nachweisbare Verlauf seinen Ausgangsstand fertiggestellt hat, kann eine Person mit Administratorrechten für die Basis im selben Abschnitt **Verlauf und Schutz** die **Finalisierung von Datensätzen** aktivieren. Bestehende und neue Datensätze bleiben im Status Entwurf, bis jemand sie ausdrücklich finalisiert. Die Einstellung gehört zu einer gespeicherten Tabelle und bietet zwei Modi:

- **Direkt:** Eine Person mit Schreibzugriff kann den Datensatz selbst finalisieren.
- **Vier-Augen-Prinzip:** Eine Person mit Schreibzugriff fordert die Finalisierung der exakt aktuellen Datensatzversion an. Eine andere Person benötigt weiterhin Schreibzugriff und muss aktuell Mitglied der konfigurierten Prüfgruppe sein, um die Anfrage zu genehmigen und den Datensatz zu finalisieren.

Die Prüfgruppe gewährt keinen Zugriff. Modus und Gruppe werden atomar aktiviert, ohne zwischenzeitlichen Direktmodus. Richtlinienänderungen machen offene Anfragen ungültig. Geänderte Werte, Relationen, Dateien, Papierkorbzustände oder aktive Felddefinitionen erfordern ebenfalls eine neue Anfrage. Das gilt auch für Feldnamen: Geprüft wird die Bedeutung des ganzen Datensatzes, nicht nur seine Summe. Anfragen, Entscheidungen und Finalisierung bleiben im Audit-Verlauf sichtbar.

Jede Anfrage hat eine kurze öffentliche ID. Genehmigung und Ablehnung über die CLI erfordern genau diese ID. Eine Bestätigung kann sich daher nie auf eine neuere Ersatzanfrage beziehen.

Die Finalisierung prüft Pflichtfelder, vergibt IDs für **Bei Finalisierung**, schreibt typisierte Formel-, Lookup-, Rollup- und Listenwerte fest und sperrt den Datensatz atomar. Exakte Dezimalwerte bleiben berechenbar. Felder, Relationen, Dateien, Papierkorbstatus und endgültige Nummer sind unveränderlich. Wiederholungen geben denselben Datensatz zurück, ohne eine weitere Nummer zu vergeben.

Nur gespeicherte Berechnungen sind historische Werte. Nach der Finalisierung hinzugefügte Felder haben kein gespeichertes Ergebnis. Grids rekonstruiert es nicht mit heutigen Formeln. Fehlende Ergebnisse sind keine Nullbeträge; verwende unvollständige Summen nicht für Finanzexporte.

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
