# Grids Workflow-Exporte: Abnahme

Stand: 12. September 2026. Kein Commit, kein Deployment, kein Bankauftrag.
Der Implementierungsplan bleibt die Anforderungsquelle. Diese Liste trennt
nachgewiesenes Verhalten von noch fehlender Abnahme.

## Prüfläufe

- Vollständiger lokaler Lauf `grids-verification-0JkDkO`: 2.858 Tests,
  null Fehler und null Skips über acht Phasen. Enthält isoliertes PostgreSQL,
  NATS, echte Gotenberg-PDFs, Evidence, Recovery und DOM-Interaktionen.
- Danach: Ergebnis-Completion samt Binder/API 6 Tests/18 Assertions;
  gruppiertes PDF und Ausgabe-Compiler 12/63; tatsächlicher PDF-Starter 2/12.
- Kernel-Nachweis erweitert: PDF/CSV/JSON/XML aus demselben Capture,
  Replay und neuer geplanter Bericht 1/33. PDF-Transport in diesem Test
  ersetzt; HTML-Rendering, Workflow-Kernel und Speicherung sind echt.
- Autoren-ID-Grenze ausdrücklich geprüft: Normalisierung 5/33.
- Neuer vollständiger Lauf `grids-verification-NaJwFv`: 2.867 Tests über
  acht Phasen, null Fehler und null Skips, terminal abgeschlossen.
- Danach: zusammenhängender Zwei-Kostenstellen-Finanzexport samt Bestätigung
  und geschütztem Aggregatdownload 1 Test/41 Assertions erfolgreich.
  Abschließender ungefilterter Grids-Typecheck ebenfalls erfolgreich.
- Visuelle PDF-Abnahme am 12. September: gezielter echter Gotenberg-Lauf
  1/151 erfolgreich; alle sechs Seiten und die leere Auswahl mit Poppler
  gerendert und einzeln angesehen. Keine abgeschnittenen Zeilen oder
  überlappenden Texte; wiederholte Tabellenköpfe, Seitenzahlen, Sonderzeichen
  und alle drei Hauptabschnitte lesbar. Temporäre Ansichtsexemplare:
  `/tmp/grids-export-pdf-review-CD5re8/multi-record.pdf` und `empty.pdf`.

Alle nachfolgenden Pfade sind relativ zu `packages/grids/src`.

## Die 20 Szenarien

| Nr. | Nachweis | Stand |
| --- | --- | --- |
| 1 | `service/document-table-output.test.ts`: Aliase, Auswahl, Reihenfolge, exakte CSV-Bytes; Kernel erzeugt umbenannte Spalte. | Belegt |
| 2 | Derselbe Serializer-Test: JSON mit null, bool, exakten Dezimalstrings, verschachtelten Werten; GQL-Capture in `service/workflow-query-data.integration.test.ts`. | Belegt |
| 3 | `service/document-xml.test.ts`: Text/Attribute, Quotes, Unicode, Namespaces, verbotene Entities und Markup. | Belegt |
| 4 | `service/document-query-pdf.integration.test.ts`: echtes mehrseitiges PDF, drei Records, 135 Unterposten, wiederholte Kopfzeilen; jede Position im extrahierten PDF. | Belegt |
| 5 | `service/document-query-pdf.test.ts`: sortierte flache Zeilen, vom Autor gruppiert, zwei Überschriften und alle drei Positionen, genau einmal maskiert. | Belegt |
| 6 | `service/workflow-actions.integration.test.ts`: ein kompilierter Workflow, vier Ausgaben, identische query_data_id, genau ein PDF-Render trotz Replay. | Belegt |
| 7 | Derselbe Kernel-Test: neuer Run mit schedule-Kanal erzeugt vier neue Dateien aus aktuellem Capture; kein finanzieller Doppelschutz für freie Berichte. | Belegt |
| 8 | Serializer-/XML-Tests und echter PDF-Test enthalten leere Auswahl; Finanzschemas verlangen nichtleere Zeilen. | Belegt |
| 9 | `document-profiles/datev-csv.test.ts`: mehrere Zeilen eines Vorgangs, exakte Beträge und 125 Spalten. | Belegt |
| 10 | DATEV-Test enthält eigene Korrektur-ID mit Gegenrichtung; `service/document-issuance.integration.test.ts` erhält Original und eingefrorene Rechnungssummen. | Belegt |
| 11 | `service/workflow-actions.integration.test.ts`: zwei Kostenstellen in einem bestätigten SEPA-Export, exakte Kontrollsumme 24,60; autorisierter Download liefert die gespeicherten Bytes, fremder Actor erhält 403. Ergänzend prüfen Capture und veröffentlichte Custom-App-Freigabe ihre Zugriffsgrenzen. Dies ersetzt keine visuelle Abnahme der rollenabhängigen Demo. | Belegt |
| 12 | `service/document-financial-output.test.ts`: identische deklarierte Zeilen-ID abgelehnt, verschiedene Zeilen-IDs mit gleichen Werten akzeptiert; keine wirtschaftliche Interpretation. | Belegt |
| 13 | `service/document-financial-issuance.integration.test.ts`, „business claims survive workflow revisions“: ausgestellter Beleg, spätere fehlgeschlagene Run-Zustände und geänderte Workflow-/Output-Version erlauben keine zweite Ausgabe derselben businessId. Ergänzend parallele Reservierung und atomarer Rollback im Claims-Test. | Belegt |
| 14 | Derselbe Issuance-Test stellt mit neuer businessId ein zweites Dokument aus und prüft beide erhaltenen Claims; alle übrigen Werte dürfen gleich bleiben. Autor muss Identitäten stabil halten. | Belegt |
| 15 | `service/workflow-query-data.integration.test.ts`: explizites Limit, vollständige begrenzte Erfassung und konsistenter Snapshot; keine stillen Teilergebnisse. | Belegt |
| 16 | Query-Store-Rollback, Journal-Replay, persistierte Bytes und Renderfehler-/Receipt-Recovery in Store-, Actions- und Issuance-Integrationstests. | Belegt |
| 17 | Capture-, Financial-Issuance-, Custom-App- und Downloadtests prüfen Rechteentzug; insbesondere erneute Autorisierung vor Commit und Bestätigung. | Belegt |
| 18 | Tabellen-/XML-/Finanzserializer testen Schlüsselkonflikte, CSV-Formeln, Precision-Verlust, Entities, ungültige Zeichen und Größenlimits. | Belegt |
| 19 | Vollsuite enthält bestehende E-Rechnung, rootlose PDF-Links, Migration, Evidence und Holds; gespeicherte Daten werden nicht neu gerendert. | Belegt |
| 20 | `service/workflow-actions.integration.test.ts`, „a stale manifest cannot capture data or issue a document“: echter Grids-Kernel endet mit WORKFLOW_MODULE_MISMATCH/needs_attention, ohne Step, Capture, Receipt oder Dokument. Kein stiller Manifest-Fallback; Source-/Binder-/API-/CLI-Tests prüfen den einheitlichen Vertrag. | Belegt |

## Weitere Grenzen und offene Abnahme

- Die Editor-Führung verwendet bestehende GQL-/Workflow-Editoren. Vorschauwerte
  bleiben flüchtig; Startparameter sind typisiert; Ausgaben bleiben normale
  deaktivierte Workflow-Entwürfe. Erweiterte Optionen sind eingeklappt.
- EN/DE-Hilfe und CLI-Referenz beschreiben Formatoptionen, Freigabe, Herkunft,
  Grenzen und Wiederholung. Der unveränderte Help-Startgrößencheck besteht.
- Finanzvorschau maskiert IBANs und bindet Bestätigung an Actor/Run/Hash.
  Fehler, Abbruch und Rechteentzug sind durch DOM/API/Kernel geprüft.
- Noch zu bestätigen: aktuelle private Demo mit dem neuen Exportablauf und
  visuelle Abnahme der tatsächlich ausgelieferten Autorenoberfläche.
- Keine Bank-/ADDISON-/DATEV-Importannahme behauptet. Lokale Schema- und
  Formatprüfung ist kein Zahlungs-, Buchungs- oder Rechtskonformitätsnachweis.
- Der Nutzer hat sich am 12. September in Chrome angemeldet. Die verfügbare
  Browsersteuerung listet jedoch weiterhin ausschließlich den In-App-Browser;
  Chrome liefert „Browser is not available“, nativer Zugriff zweimal
  „timeoutReached“. Der Blocker ist daher die Browser-Verbindung, nicht eine
  fehlende Nutzeranmeldung. Die private Demo und ausgelieferten Dialoge bleiben
  unbestätigt; keine weiteren Testläufe als Ersatz für diese Sichtprüfung.
- Abschluss erst nach Demo/UX-Abnahme. Keine pauschale Produktionsfreigabe
  aus Testzahlen.
