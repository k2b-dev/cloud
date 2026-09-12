# Grids: GQL-basierte Dokument- und Dateierzeugung in Workflows

Stand: 11. September 2026. **Implementierung im Goal-Modus freigegeben und begonnen**.
Dieser Plan ersetzt die frühere Beschränkung auf zwei separate Finanzexport-Aktionen.

### Implementierungsstand

Gemeinsamer Kernel-Nachweis erweitert und bestanden (1/33): kompilierter
Workflow erzeugt PDF/CSV/JSON/XML aus einem Capture, Replay rendert nicht
erneut, neuer schedule-Run darf aktuelle Daten als neuen freien Bericht
exportieren. PDF-Transport injiziert, echte PDF-Prüfung separat unverändert.
Explizite Autoren-ID-Grenze 5/33 grün. Roher Typecheck 87667 grün.
Pakete A–D in Dex mit Nachweisen abgeschlossen; Gesamt-Abnahme bleibt offen.
Neue Matrix: `plans/grids-workflow-export-acceptance.md`.
Neuer voller Lauf abgeschlossen: 2.867 Tests, null Fehler und Skips,
Reports `grids-verification-NaJwFv`. Danach Zwei-Kostenstellen-Finanzexport
mit exakter Kontrollsumme und autorisiertem Aggregatdownload 1/41 bestanden;
abschließender roher Typecheck und gezielter Biome-Check ebenfalls grün.
Noch zu erledigen: private Demo/visuelle Autoren-UX-Abnahme. Der lokale
Browser erreicht die Anmeldung; angemeldete Sitzung beim Nutzer angefragt.
Kein Commit/Neustart. Voriger Goal-Turn und dieser Turn sind Fortschritt.

Gesamtlauf 30288 vollständig grün: 2.858 Tests ohne Skips (Standard 2774,
DOM 59, Outbox 9, Sync 6, Evidence 6, Bundle 1, echtes PDF 1, Recovery 2).
Reports `grids-verification-0JkDkO`; kein Testprozess mehr aktiv.
Danach Ergebnis-Vorschläge für `generateDocument.data` im bestehenden
Grids-Completer ergänzt: strikter YAML-Parser, vorherige Namen, lokale
Branch-/Loop-Sichtbarkeit, keine späteren/schwesterlichen Ergebnisse.
Inputs bleiben im getrennten inputs-Namensraum. Compiler/Binder bleiben
autoritativ. API-/Scope-/Katalogtest 15/45, abschließend Scope/API 6/18 grün.
Help-Budget mit EN/DE-Hinweis grün; Typecheck 54122 und Biome grün.

Zusätzlicher Abnahmetest für gruppierte flache Join-Zeilen fand doppelte
HTML-Maskierung im neu hinzugefügten Starter: escape-Filter entfernt, da der
bestehende Renderer automatisch maskiert. Hinweis korrigiert, tatsächliche
Starter-Vorlage über Renderer geprüft (SSR/Renderer 2/12). Gruppen-PDF plus
Compiler 12/63 grün. Renderer-Sicherheitsregeln unverändert.
Offen: vollständige Szenario-/Anforderungsmatrix, insbesondere direkter
PDF-und-CSV-aus-einem-Capture-Nachweis (CSV/JSON/XML gemeinsam und echtes
PDF separat bereits belegt). Keine Commits/Neustarts; Goal weiter aktiv.

Weitere Ausgabeoptionen sind formatabhängig eingeklappt verfügbar: CSV mit
Pipe-Trennzeichen, verschachtelten JSON-Werten und expliziter Warnung vor
ungeschütztem Text; JSON mit optionalem Zeilenschlüssel; PDF mit Kopfzeile,
Fußzeile und CSS. Die Standardansicht und sicheren Defaults bleiben erhalten.
Compiler-/Quelltexttests 9/49 und kombinierte Starter-DOM-Tests 2/38 bestanden;
roher Typecheck 2463 und Biome der drei geänderten Dateien grün. Keine Commits.
Neuer vollständiger Verifier 30288 läuft, Reports `grids-verification-0JkDkO`.
Noch offen: Ergebnis dieses Laufs und Abgleich der ursprünglichen
Autoren-/Szenario-Abnahmepunkte; nicht als vollständig abgeschlossen werten.
Vorschau-Navigation ergänzt: von späteren Seiten zurück zur ersten Seite,
ohne Cursor-Historie oder zusätzlichen Daten-Cache. DOM 1/30 und Typecheck
78547 bestanden; Biome und Diff-Check grün. Noch konkrete Autoren-UX-Lücke:
`generateDocument.data` bietet im YAML-Editor keine vorherigen benannten
Query-Ergebnisse an. Gemeinsamer Manifest-Completer bietet dort nur Root-Keys;
gezielt im bestehenden Grids-Owner ergänzen, mit Scope-/Reihenfolge-Tests.
Wiederverwendung selbst ist in workflow-actions.integration.test.ts durch
drei Ausgaben aus einem Capture samt Replay belegt.

Geführte skalare Startparameter ergänzt (text, number, decimal, boolean,
date, dateTime). Vorschauwerte bleiben flüchtig; erzeugte Workflow-Inputs
binden über bestehende typisierte Query-Parameter. Dezimalwerte nutzen
Texteingaben. Bestehende GQL-Preview/Execute-API akzeptiert nur `parameters`
im `params`-Namensraum, mit 100 Namen/20.000 JSON-Zeichen/10.000 Listenelementen;
keine Auth-/Page-Overrides. CLI run/preview: parameters/file/stdin, Referenz
und CLI-Skill ergänzt. Tests: Schema+Starter 13/53, API/Postgres inklusive
Cursorwechsel und Rechteentzug 1/9, CLI 2/7, kombinierte Starter-DOM 2/33.
Eingabefokus bleibt erhalten, Samples landen nicht im Workflow. Typecheck
65308 grün; letzter UI-Hinweis-Check 35776 läuft. Help-Budget nach Kürzung
doppelter Einstiegserklärungen wieder grün (2/16), Grenze unverändert.

Gesamtlauf 45824 terminal: Standard 2767/19644, Outbox 9/38, Sync 6/20,
Evidence 6/121, Browser-Bundle 1/2, echtes PDF 1/151, Recovery 2/2 bestanden,
jeweils ohne Skips. DOM 58 Pass/1 Fail plus unhandled wegen fehlender
Popover-Testumgebung im neuen Starter-Test; Testsetup korrigiert, kombiniert
grün. Reports `grids-verification-i84gea`. Nicht als Gesamtnachweis der später
ergänzten Parameterfunktion werten. Keine laufende vollständige Suite mehr.
Offen: erweiterte Ausgabeoptionen, vollständige Autoren-UX-/Anforderungsabnahme
und abschließende Regression. Kein Commit/Neustart.

Autoren-Einstieg implementiert: „Datei aus einer Abfrage erstellen“ im
Workflow-Starter. Bestehender GQL-Editor mit Schemahilfe, typisierte und
paginierbare Vorschau, danach CSV/JSON/PDF/XML mit formatabhängigen Feldern.
Abfrageänderungen verwerfen die Vorschau; Fehler blockieren den Folgeschritt.
Ausgabe ist normaler deaktivierter Workflow-Quelltext mit benanntem Ergebnis
`report`, kein zweites Modell. YAML-Serialisierung schützt Textgrenzen.
Compiler-/Quelltexttests 5/28, kombinierte API-/SSR-/Quelltextprüfung 48/157,
DOM 1/16, Hilfe/SSR 3/24 bestanden; roher Typecheck und Biome 8 Dateien grün.
Geführte Parameter, erweiterte Formatoptionen und vollständige UX-Abnahme
bleiben offen. EN/DE-Hilfe nennt den Einstieg und die Live-Sample-Grenze.

Lauf 76734 terminal: 2755 Pass/6 Fail, ausschließlich die inzwischen
korrigierten Collection-Erwartungen. Frühere Migrations-/unzugeordnete Fehler
nicht erneut beobachtet; keine pauschale Timeout-Erhöhung. Nächster kompletter
Verifier 45824 läuft inklusive neuer Autoren-Tests (DOM separat registriert).
Der fehlerhafte Type-Import in der Collection-Testfixture wurde auf
`z.infer<typeof PublicDocumentSchema>` korrigiert, Typecheck danach grün.

Aktueller Lauf deckte zusätzlich veraltete Collection-API-Erwartungen auf:
`dataSnapshot: null` fehlte für Record-Dokumente. Fixture korrigiert und mit
`PublicDocument` typisiert. Fokussiert **42 Tests/121 Assertions bestanden**.
Lauf 76734 enthält noch die alten Erwartungen, weiter für weitere Befunde
auswerten; nicht als abschließenden grünen Lauf werten.

Gesamtlauf 36610 beendet: 2755 Pass, 2 Fail/1 Error laut Bun,
JUnit nennt davon nur einen Migrationstest-Timeout (30s), keine Skips.
Report: `grids-verification-U6zch7/database-and-standard.xml`.
Unveränderte isolierte Reproduktion dieses Tests: 1 Pass/17 Assertions,
6,0s; Timeout daher nicht pauschal erhöht. Zweiter Fehler noch ungeklärt.
Verifier bewahrt nun vollständige stdout/stderr-Logs je Phase, weil JUnit
Fehler außerhalb von Testfällen nicht vollständig abbildet. Typecheck grün.
Neuer Gesamtlauf 76734 aktiv, Reports/Logs in `grids-verification-d7GJEg`;
Outbox bereits bestanden, Standardphase läuft. Enthält die aktuellen
Dokument-Metadaten. GQL-/freie-Ausgaben-Autorenführung bleibt offen.

Dokument-Herkunft ergänzt: öffentliche `dataSnapshot`-Metadaten mit Zeilenanzahl
und Erfassungszeit für Workflow-Ausgaben, null für Record-Vorlagen. Ein
gebündelter Read auf bestehende Snapshot-Spalten, keine Payloads/Query-Inhalte
oder internen IDs und keine Live-Neuberechnung. Detaildialog zeigt Quelle und
Datenstand getrennt vom Dateidatum. API-/SSR-/Locale-/Help-Prüfung 13/100,
Dokument-DOM 5/39, echte SEPA-Ausstellung plus öffentliche Projektion 1/16
bestanden. CLI-Skill korrigiert (nicht jedes Document ist Record-/Template-
gebunden); EN/DE-Hilfe ergänzt und bleibt innerhalb der Startgrenze.
Roher Typecheck nach Entfernung eines ungeeigneten verschachtelten
Message-Objekts bestanden; abschließender Wiederholungslauf aktiv. Gesamtlauf
36610 weiter aktiv; er startete vor dieser letzten Metadaten-Erweiterung.
Als funktionale UX-Abnahme bleibt die GQL-/freie-Ausgaben-Autorenführung.

Vorlagen-Aufteilung bestätigt: alle drei vollständigen Vorlagen inklusive
leerer Varianten bestehen, 3 Tests/218 Assertions (39,8s/28,3s/38,9s).
Assertions unverändert; gemeinsames 90s-Budget war für sechs Base-Anlagen zu
klein. Dritter Gesamtlauf mit korrigierten Phasen und Poppler-Pfad gestartet.

Gezielte Timeout-Reproduktion: Inventar-Workflow 1 Pass (52,5s), kompletter
Vorlagen-Sammeltest erneut am 90s-Limit. Dieser erstellt sechs vollständige
Bases. Nun pro Vorlage ein eigener Test mit unveränderten Assertions und
90s-Budget; laufender Nachweis Handle 50854. Kein Produkt-Performance-Pass
behauptet und Inventar-Testbudget nicht erhöht.

Letzter Gesamtlauf beendet: Standardphase **2757 Pass, 9 Skip, 2 Fail**,
Report `grids-verification-WGLM3d/database-and-standard.xml`. Verbleibende
Fehler: Vorlagen-Instanziierung 90s und Inventar-Workflow-Szenario 60s Timeout.
Fokussierte Reproduktion beider Szenarien läuft, keine Budgeterhöhung als
Ersatz für Diagnose. Die neun Skips sind unten beschrieben und im Runner
behoben. Nachfolgende Phasen wurden wegen Abbruch noch nicht ausgeführt.
Letzter roher Grids-Typecheck und fokussierter Biome-/Diff-Check bestanden.

Fortsetzung: Kombinierte Dokument-/Finanzdialog-DOM-Prüfung 7 Tests/60
Assertions grün, Help/Katalog/Workflow-Beispiele 10/498 grün. Erneuter echter
Gotenberg-Test 1/151 grün. Runner-Audit fand zusätzlich neun Skips im ersten
JUnit: acht Object-List-/Prozentfeld-DOM-Tests in falscher Serverphase und
den nicht aktivierten PDF-Test. DOM-Zuordnung korrigiert, separat 8/58 grün;
PDF erhält eigene aktivierte Phase und frühe pdftotext-Prüfung. Für diesen
Host PDFTOTEXT auf das gebündelte Poppler-Executable setzen. Zweiter bereits
laufender Gesamtprozess 8033 nutzt noch die alte Phasenliste und meldet
einen 90s-Timeout bei kompletter Vorlagen-Instanziierung; noch auswerten.
Offene Abnahme-Punkte: verständliche Quellen-/Datenstand-Zusammenfassung im
Workflow-Dokumentdetail sowie Autorenführung für GQL und freie Ausgaben
gegen Abschnitt 10 prüfen/ergänzen. Starter allein erfüllen das noch nicht.

Aktuell: Erster voller Standardlauf terminal mit 2714 Pass/14 Fail
(`/tmp`-Systempfad `grids-verification-IgMyfZ/database-and-standard.xml`).
Funde: 5s-DB-/Hook-Timeouts, ein 15s-Four-eyes-Test, doppelte Evidence-Sync-
Initialisierung, veraltete OpenAPI-required-Reihenfolge, Skill-Paritätsannahme
und nur im Gesamtlauf fehlschlagender Browser-Bundle-Test. OpenAPI 1/33 und
Audit-Bundle separat grün; isolierter Four-eyes-Test bei unverändertem 15s-
Testbudget 1/38 in 6s bestanden. Browser-Build erhält sauberen eigenen Prozess;
konkrete Ursache der Suite-Interferenz noch nicht bewiesen. Wiederholung des
Gesamtlaufs aktiv: Handle 8033, Outbox bereits 9/0.
Finanzvorschau maskiert IBANs, berechtigte Prüfer blenden sie ausdrücklich
ein/aus; Originaldaten/Hash unverändert, DOM 1/8 bestanden. Test im DOM-Lauf
registriert. Hilfe ergänzt; redundante Root-Key-Tabellen entfernt, da sie
die benachbarten Vertrags-/Detailabschnitte wiederholen. Katalog-Recheck läuft.

Zwei im Gesamtlauf bei 5s abgebrochene Durable-History-Tests mit explizitem
30s-Budget isoliert wiederholt: 2/47 bestanden, echte Laufzeiten 26,6s/23s.
Kein Performance-Pass: mehrschrittige DB-/Schema-/History-Szenarien.
Runner gibt der Standard-DB- und Evidence-Phase deshalb 30s Standardbudget;
explizite Testbudgets bleiben bestehen. PostgreSQL-Stichprobe im isolierten
Verifikations-DB zeigte keine Lock-Waiter, längste aktive Query 10ms.
Vollprüfung 96145 läuft noch mit altem Budget und muss danach wiederholt
werden. Neuester roher Typecheck 96979 ebenfalls bestanden.

Vollprüfung noch NICHT grün: laufender isolierter Standardlauf (96145)
meldet mehrere 5s-DB-Test-/Hook-Timeouts, außerdem doppelte Sync-Bindung im
Evidence-Test. Evidence erhält für Wiederholung eine eigene Phase ohne
Preload, da er seine Verbindung selbst verwaltet. Kompletter Bericht noch
auszuwerten; keine Timeouts als bestanden werten. Korrigierter Skill-Test
plus Formula-Katalog 7/108 grün. Letzter fokussierter Biome-/Diff-Check grün.

Abnahme-Ergänzung: CSV/JSON/XML-Primärartefakte haben jetzt eine sichere,
erst auf Wunsch geladene Unterdialog-Vorschau über FileView/CodeDisplay.
Gemeinsame 2-MiB-Grenze; CSV als Originaltext statt geratenem Trennzeichen.
Bestehender autorisierter Artefakt-Endpunkt, Abort beim Schließen.
SSR 5/28, CSV/XML-DOM-Markup-Sicherheit 1/9, Hilfe-Katalog 2/16 und roher
Typecheck bestanden. EN/DE-Dokumenthilfe aktualisiert. Vollprüfung läuft
noch (Handle 96145): Outbox-Phase nach Entfernung doppeltem Sync-Preload
weitergelaufen. Veralteten Assistant-Dokumentationstest korrigiert: LIST_*
werden im Evaluator separat behandelt; Engine/Katalog-Parität bleibt im
bereits bestehenden function-catalog.test.ts, Skill-Test prüft weiterhin
jede Signatur. Nicht als fehlende Skill-Funktion missverstehen.

Aktuell: Starter-DOM-Interaktion 1/13 bestanden (ungültige IBAN blockiert,
Fokus auf erstem Fehler, Zurück/Vorwärts erhält Eingaben, gültiger Entwurf
bleibt deaktiviert). Im dedizierten DOM-Prüflauf registriert. Roher Typecheck
nach Scanner-Erweiterung bestanden. Echte veröffentlichte Custom App samt
Scanner-Launcher → Kernel → HTTP-Vorschau/Bestätigung → eine SEPA-Datei
1/13 bestanden; entzogenes App-Recht blockiert Bestätigung mit 403 und ohne
Ausgabe. Rechnungsprofil-Test jetzt zusätzlich mit exaktem UI-Starter durch
Compiler/Invocation/Kernel: gespeicherte Kontierungsfelder und 0,02-Summe
bleiben nach Live-Änderung erhalten, bestätigte DATEV-Bytes: insgesamt 1/15.
PDF-Transport dabei injiziert, NATS-Liveupdates nicht verbunden. Ein Fixture
verlor zunächst die erforderliche Record-Version; korrigiert. Migrations-
Setup-Hook überschritt einmal die Standard-5s; für die beiden betroffenen
Integrationsdateien explizit 30s eingerichtet, keine Fachtests übersprungen.
Vollständiger isolierter Grids-Prüflauf und abschließender Soll/Ist-Abgleich
laufen noch. Frühere Absätze darunter sind chronologische Nachweise.

Starter-Zielkonfiguration nutzt nun dieselben browserfähigen DATEV-/SEPA-
Header-Schemas wie der Server; die bestehenden Schemas aus den Renderern
verschoben, keine parallelen IBAN-/Periodenregeln. DATEV-Fiskalzeitraum wird
über `safeExtend` in vollständigen Batches beibehalten. Lokalisierte Hinweise
und markierte Felder verhindern Übergabe ungültiger Konfiguration. Format- /
Normalisierungs-/SSR-Regression 13/107; Header-Parität, Browser-Bundle ohne
Servermodule und Starter-Compiler 5/30 bestanden. Starter werden als lesbares
YAML serialisiert; automatische Alias-Anker ausdrücklich ausgeschaltet,
nachdem der strikte Compiler sie im ersten Test zurückwies. `yaml` nutzt den
bestehenden Workspace-Katalog; Dependency-Policy für 30 Workspaces grün.
Ein Test nutzte zunächst die nicht typisierte Bun.build-Option `write`; entfernt.
Roher Typecheck-Wiederholungslauf aktuell Handle 3965. Keine Commits/Neustarts.

Letzter roher Grids-Typecheck und Diff-Check bestanden. Nach Ergänzung der
Starter-Hilfe überschritt der Katalog zunächst seine Startgrenze; redundante
Einleitungen gekürzt, unveränderte Grenze danach wieder 2/16 grün.

Finanz-Starter jetzt an „Neuer Workflow“ angeschlossen: zweistufige Auswahl
Quelle/Felder → Zielkonfiguration, deaktivierter prüfbarer Workflow, vorhandener
Launcher-Speicherpfad und Verwerfen-Schutz. Textfelder für Kontierung/IBAN;
verpflichtendes eindeutiges Textfeld als Erstattungsidentität. UI-/Starter-
Regression 11/61 bestanden; Workflow-Hilfe plus Compiler 10/498 bestanden.
Echter Erstattungsstarter durch Resolver, Finalisierung und Kernel: Entwurf
abgelehnt, finalisierter Record → Vorschau → bestätigte gespeicherte SEPA-Bytes
1/7 bestanden. Fand eine echte Alias-Kollision mit Quellfeldern; Starter erzeugt
jetzt kollisionsfreie Aliase anhand aller Feldnamen/IDs. NATS-Liveevents sind
in diesem DB-Test nicht verbunden, also nicht mitverifiziert. CLI und beide
In-App-Hilfen ergänzt. Noch ausstehend: komplette UI-Interaktion/Validierung,
Rechnungsstarter-End-to-End (Issuance-Kette separat bewiesen), eingebettete
Custom-App-/Scanner-Bestätigung und Gesamtregression. JSON-Workflowquellen
sind gültiges YAML, aber noch auf ergonomische Editor-Darstellung zu prüfen.

Finanz-Starter begonnen: zwei parametrisierte Quelldefinitionen im bestehenden
Workflow-Frontend-Owner. Rechnung liest ausgestelltes Document inklusive
abgeleiteter Summe und expliziter Kontierungsfelder; Erstattung prüft zuerst
die gesamte ausgewählte Menge auf offene Finalisierung, erfasst anschließend
finalisierte Zeilen und bindet `sourceVersions: data`. Stabile eindeutige
Erstattungsnummer ist ausdrücklich zu wählen. Noch nicht an die Auswahl-UI
angeschlossen; vollständiger Resolver-/DB-Lauf und Feldvoraussetzungen sind
noch zu prüfen. Tests prüfen Compiler/Binder und tatsächlichen GQL-Parser,
nicht eine simulierte vollständige Ausführung.

Neu verifiziert: tatsächlich ausgestelltes Rechnungsprofil → gespeicherte
Document-Quelle → Bestätigung → ausgestelltes DATEV-Dokument mit gespeicherten
CSV-Bytes und identischem Replay (1/11). Vor Bestätigung bleibt allein die
Rechnung gespeichert. PDF-Transport ist in diesem Test injiziert; Profil,
XML-Prüfung, Datenbank und Finanz-Issuance sind real. Ein erster Durchlauf
traf eine kollidierende Test-Short-ID; auf zufällige Fixture-IDs korrigiert.
Ungültige abgeleitete Profilwerte (NaN, undefined, Zyklus, über 5 MiB)
werden ohne Document abgelehnt; korrigierter Retry nutzt dieselbe Nummer,
nachträgliche Mutation des Rückgabeobjekts verändert nichts (1/14).
Freigabelinks bleiben ausschließlich für PDF möglich, auch im Dry-run:
Query-PDF erlaubt, JSON/CSV/XML abgelehnt und keine Persistenz; bestehender
Record-PDF-Plan weiterhin erlaubt (2/20). Die frühere Dry-run-Erweiterung
war für JSON zu weit gefasst und ist korrigiert.
Offen bleiben sichere Finanz-Starter, die tatsächliche eingebettete
Custom-App-/Scanner-Bestätigung und abschließende Gesamtregression.

Profilergebnisse implementiert: optionales `DocumentProfile.issue().output`
wird kanonisch als JSON (maximal 5 MiB) geprüft, kopiert und gemeinsam mit
den Artefakten in `documents.profile_output` gespeichert. Bestehende Zeilen
bleiben unverändert/NULL; der bestehende Immutable-Trigger schützt das Feld.
Beide Issuance-Pfade reichen es an denselben Speicher-Owner weiter. Document-
Quellen bieten es unter `output` an, einschließlich Byte-Vorabgrenze; fehlende
Pfade alter Documents scheitern ohne Nachberechnung.
Die deutschen Rechnungsprofile liefern exakt gerundete `netAmount`,
`taxAmount`, `grossAmount`, `currency` und `taxGroups` aus derselben Rechnung
wie PDF/XML. Profil-/Projektionsprüfung: 13/79. Echte Profile-Issuance mit
XSD-Prüfung und injiziertem PDF-Transport, Round-trip als Dezimalwert,
Quellenänderung, Mutationsverbot und Replay: 1/6 bestanden. CLI/EN/DE-Hilfe
ergänzt; Hilfekatalog 2/16 und roher Typecheck/Biome bestanden.
Gesamte Issuance-Datei: fünf Tests bestanden, historischer Mehrfach-Migrations-
Fall überschritt sein eigenes 30-s-Limit. Mit 60-s-Limit besteht der isolierte
Wiederholungslauf (1/49; 28,3 s Testdauer). Ein erster neuer Test hatte fehlende Käufer-USt-ID, ein zweiter hing
an einer nicht gestarteten lazy SQL-Assertion; beide Fixtureprobleme korrigiert.
Noch offen: tatsächliche Finanz-Dateierzeugung aus diesen Rechnungssummen,
Starter, kompletter Custom-App-Scanner-Pfad und Gesamtregression.

Zusätzliche Vertragsprüfung: Query-Dokumente lassen sich jetzt auch im Dry-run
verknüpfen (nullable Quell-Record-/Tabellen-IDs statt SQL-Abfrage mit geplanter
ID). Fehler zunächst im echten Kernel reproduziert, dann behoben. Bestehende
Record-Dokument-Planung bleibt grün. Finanzielle `sourceVersions` werden bei
Record-Template-Erzeugung auch im Run-/Plan-Handler abgelehnt statt ignoriert.
Drei gezielte Kerneltests mit 14 Assertions bestanden; ein anfänglicher Test
musste den vorhandenen Dry-run-Issue-Vertrag statt Execute-Fehlerform prüfen.

Nächster Rechnungsstarter-Befund: `einvoice-de.calculate` berechnet gerundete
Netto-/Steuer-/Bruttosummen für PDF/XML, aber `profile_snapshot` enthält nur
die ursprünglichen Eingaben. Der neue Document-Quellenadapter liest diese
unveränderlichen Eingaben, keine abgeleiteten Summen. Vor einem echten
Rechnungsstarter muss die autoritative, profilberechnete Summe als Teil des
ausgestellten Datenstands verfügbar sein. Keine unabhängige Starter-
Nachberechnung, keine PDF-Extraktion und keine Umschreibung alter Documents.
Noch keine Entscheidung zur konkreten Speicherung implementiert.

Scanner-Status und Run-Detail liefern jetzt optionale wartende Export-Metadaten;
Listen bekommen keine zusätzlichen Vorschau-Abfragen. Die gemeinsame Scanner-
Oberfläche öffnet über „Export prüfen“ denselben Bestätigungsdialog und lädt
danach denselben Lauf nach. Dispose schließt den Dialog, ohne einen neuen Lauf
zu starten. Echter SEPA-Kernel-/HTTP-Test inklusive Status, fremder Leserechte
und Entfernen der Metadaten nach Abschluss: 1/34 bestanden. Roher Typecheck
bestanden. Noch offen: tatsächliche Custom-App-Scanner-Finanzintegration,
Starter, Rechnungsprofildaten und Gesamtregression. Kein Gesamtabschluss.

`sourceVersions: data` leitet die Liste nun direkt aus eingefrorenen GQL-
Zeilenmetadaten ab. Optional gespeicherte Versionen ändern alte Capture-Hashes
nicht; alte Captures ohne diese Metadaten bleiben lesbar, erlauben aber keine
automatische Versionsprüfung. Eindeutige Root-Zeilen einer einzelnen Quelle
sind erforderlich; Joins einschließlich Self-Joins und mehrdeutige Herkunft
scheitern. Lookups/Unterdatensätze sind ausdrücklich nicht rekursiv geschützt.
Kernel samt Dry-run und Änderungs-Konflikt 1/6; echte konkurrierende UPDATE-
Sperre und Bestätigungs-/Ausstellungs-Konflikte 1/11; Capture-/Store-Regression
5/44 bestanden. Eine parallel gestartete Testmigration verursachte zunächst
einen DDL-Deadlock; der isolierte Sperrtest bestand. Manifest/Schema 7/27,
roher Typecheck und Diff-Check bestanden. CLI ergänzt, Hilfe nach Erreichen
der unveränderten Startgrenze durch Kürzung redundanter Finanztexte gestrafft.
Als Nächstes: Starter, vollständiger Finanz-Custom-App-/Scanner-Pfad und
echte Rechnungsprofildaten im Finanzexport, anschließend Gesamtregression.

Finanzexporte akzeptieren jetzt optionale `sourceVersions` mit öffentlichen
Tabellen-/Record-IDs und exakten Versionen. Derselbe Issuance-Owner prüft sie
bei Reservierung, Vorschau/Bestätigung und innerhalb der finalen Transaktion;
Records werden dabei geordnet gesperrt. Änderung vor oder nach Bestätigung
verhindert die Datei (neuer DB-Test 1/9). Die gesamte Finanz-Issuance-Regression
besteht mit 5/52, Binder/Manifest/Eingabeschema mit 39/170. Kein zweiter
Freigabe-Interpreter: Autor prüft fachliche Freigabe vor Erfassung und bindet
alle relevanten Versionen. CLI und beide Hilfen erklären die Grenze. Noch
gezielt zu prüfen: ergonomische, vertrauenswürdige Ableitung der Versionsliste
aus Workflow-/Query-Daten, Kernel-/Custom-App-Weitergabe und Sperr-Races.
Der Test fand zunächst falsche JSON-Parameterkodierung; korrigiert auf den
vorhandenen Bun-SQL-Objektvertrag. Kein Gesamtabschluss.

Manuelle Record-Snapshots sind als `data.snapshots` angeschlossen. API und
Workflow nutzen dieselbe in den Service verschobene Public-ID-Projektion und
dieselbe Relations-Redaktion. Ein echter Kernel-Test prüft historische Root-/
Relationswerte, verweigerte Root-Rechte, redigierte Ziele und JSON-Dateibytes
(1/12). Die anfänglichen Fehler lagen im Fixture: Relationsdaten müssen in
`record_links` stehen; unveränderliche Snapshots behalten ihre Base auch nach
fehlgeschlagenen Assertions. Keine Schutztrigger wurden gelockert. API-/Binder-/
Quellentests 43/178; Binder plus vollständige Hilfe-/YAML-Prüfung 43/645;
roher Grids-Typecheck, fokussiertes Biome und Diff-Check bestanden. CLI und
beide Hilfen unterscheiden manuelle Snapshots von ausgestellten Dokumenten.
Offen: fachliche Freigabe-/Frischebedingungen, echte Rechnungsprofil-Exporte,
Finanz-Custom-App-/Scanner-Abschluss, Starter und abschließende Regression.

Die Kette „Dokument erzeugen → Document-Snapshot exportieren“ funktioniert jetzt
auch im Dry-run, ohne Platzhalter-IDs an SQL zu senden. Bestehende Quellen werden
geprüft; erst geplante Inhalte erhalten einen ausdrücklichen Hinweis im Ergebnis.
Der echte Kernel-Test prüft beide Modi und Dateiinhalte (1/6). Dabei wurde ein
realer Vertragsfehler behoben: `shortId` war im Binder erlaubt, fehlte aber im
ausgeführten Ergebnis. Binder-Felder stimmen nun mit `number` und
`primaryArtifactKey` überein; nicht gelieferte `documentNumber`, `snapshotId`
und `workflowRunId` werden nicht mehr angeboten. Kein gespeichertes Dokument
oder Journal wurde umgeschrieben. Zwei erste Testversuche scheiterten am
5-s-Migrations-Setup; mit 30-s-Test-Timeout bestand der tatsächliche Kettentest.

Dokument-Snapshot-Quelle hinzugefügt: `data.documents` wählt eindeutige öffentliche
Document-IDs derselben Base. Typisierte Spalten mit festen Eigenschaftspfaden
projizieren gespeicherte Render-/Profileingaben ohne Live-Abfrage oder implizite
Array-Auflösung. Quellenbytes werden vor dem Laden auf 5 MiB begrenzt. Die
bestehende unveränderliche Capture-Ablage hält Werte und Document-Herkunft.
Binder-/Projektions-/Manifesttests 39/162; echter Kernel samt Replay,
Base-Trennung und fehlender Auswahl 1/17; roher Typecheck und Biome bestanden.
CLI und beide Hilfen ergänzt; Katalog-/YAML-Prüfung 10/494 bestanden nach
weiterer Kürzung wiederholter Erklärungen. Noch zu prüfen/ergänzen: Dry-run
mit erst zuvor geplanten Documents, echte Rechnungsprofildaten im Finanzexport,
Record-Snapshot-Quellen sowie die weiteren offenen Punkte.

Neu: `generateDocument.data` akzeptiert explizit typisierte Workflow-Zeilen
zusätzlich zur GQL-Referenz. Derselbe Capture-/Document-Owner speichert sie
einmalig, mit ehrlicher Werte-Herkunft statt erfundener GQL-Metadaten.
Exakte Dezimalstrings, Boolean und JSON bleiben erhalten; fehlende/fremde
Zellen und dynamische Spaltendefinitionen werden abgelehnt. Der echte Kernel-Test
prüft Dry-run ohne Capture, Dateibytes und Replay (1/10). Binder-/Vertragstests
38/164, rohe Typprüfung und vollständige Hilfeprüfung 10/490 bestanden.
Die Hilfe passt nach Kürzung wiederholter Erklärungen unter die unveränderte
Startgrenze. Snapshot-Quellen und die weiteren unten genannten Punkte bleiben offen.

Aktueller Zusatzstand: Finanz-Metadaten, Binder, Bestätigungs-API, CLI sowie
Workflow-Dialog und Custom-App-Aktionen sind angeschlossen. Vier Datenbanktests
mit 43 Assertions prüfen DATEV/SEPA-Issuance, konkurrierende Bestätigung und
Wiederholung sowie Rechte-/Abbruchfälle. Ein eigener Kernel-DB-Test prüft die
transaktionale Worker-Generation-Sperre. Finanz-Mappings verwenden GQL-Aliase,
nicht interne `q_col_*`-Schlüssel. Datums-Eingaben sind im Header-Binder erlaubt.
Ein echter Gotenberg-Test mit 151 Assertions erzeugt sechs Seiten mit 135
Unterposten sowie eine leere Übersicht; alle sieben Seiten wurden visuell geprüft.
CSV-Spaltenauswahl und Umbenennung sowie JSON-Wrapper mit vorhandenen typisierten
Workflow-Ausdrücken sind implementiert. Der echte Kernel-Test für CSV/JSON/XML
besteht mit Dry-run, gespeicherten Dateiinhalten und Wiederaufnahme (1/21).
Die zunächst fehlende Übergabe der JSON-Optionen an das Profil wurde dabei gefunden
und korrigiert. Zwei Kernel-DB-Tests prüfen Übernahmesperre und Abbruch vor Writes
(2/9). Die zweisprachige Hilfe wurde gestrafft, damit der vollständige Katalog
unter der unveränderten Startgrenze bleibt; Katalog-/Manifest-/YAML-Prüfungen
bestehen mit 10 Tests/476 Assertions. CLI-Referenz und beide Hilfen enthalten nun
Finanzprofile, Bestätigung, CSV-Zuordnung und JSON-Wrapper.
Zusätzliche Regression: 61 fokussierte Tests/260 Assertions bestanden.
Der echte SEPA-Kernelpfad prüft Warten ohne Datei, falschen/richtigen Hash,
Freeze trotz Quellenänderung, Replay und Doppelschutz über neue Läufe. Er nutzt
auch die echten HTTP-Routen für Vorschau/Bestätigung und prüft fremden Actor,
No-store und den vollständigen öffentlichen Vertrag (1/28).
Custom-App-Abbruch schließt die Exportprüfung über das vorhandene Dialog-Signal;
Dialog-Requests werden beim Dispose abgebrochen, der Serverlauf bleibt erhalten
(Client 9/26). Das gilt auch beim Wechsel/Schließen des Workflow-Detailpanels.
Die bestehende Dialog-Abbruch-/Stack-Regression besteht im vorgesehenen
Browser-DOM-Testmodus (9/32); der erste Aufruf ohne Browser-Conditions war ein
Testaufruf-Fehler, kein Produktfehler. Exportprofil und Version erscheinen in
Vorschau, API und CLI. CLI/Normalisierung 17/125; roher Grids-Typecheck,
Biome der zwölf berührten Dateien und Diff-Whitespace-Prüfung bestanden.
Offen bleiben weitere Datenquellen, vollständige Finanz-Dokumentation
und Starter sowie abschließende Integration und Regression. Nachfolgende
Prüfstände dokumentieren die vorherigen Teilschritte, nicht einen Gesamtabschluss.

Die gemeinsame Artefaktprüfung, exakte JSON-/CSV-Serialisierung und typisierte
GQL-Parameterbindung sind implementiert. GQL-Daten können innerhalb eines
konsistenten Read-only-Snapshots erfasst werden; technische Abschneidung wird
abgelehnt. Die interne Ablage `grids.workflow_query_data` speichert das Ergebnis
unveränderlich je Lauf/Schritt. Der deklarierte `query`-Schritt schreibt diese
Ablage und die kleine Journalreferenz in derselben Kernel-Transaktion.
Veröffentlichung bindet autorisierte Tabellen/Felder und typisierte Parameter;
Ausführung prüft Schema und aktuelle Rechte erneut. Dry-runs lesen das Schema,
speichern aber keine Ergebniszeilen. Die Ablage ist additiv, ohne Versions-Reset.

Query-Randfälle sind abgesichert: Leere Record-Listen in
`oneof(record.id, @params.selected)` ergeben null Treffer bei unveränderter
Rechteprüfung. Ein Dry-run kann einen zuvor geplanten neuen Record als Parameter
verwenden, ohne dessen temporäre ID an SQL zu übergeben. Echte Ausführung
akzeptiert solche Platzhalter weiterhin nicht. CLI-Referenz und bilinguale
Workflow-Hilfe beschreiben den Query-Vertrag und die Dateierzeugung.

Documents deklarieren jetzt `primaryArtifactKey`; Profile deklarieren dazu
`primaryArtifact: { key, mediaType }`. Dieselbe Issuance kann damit auch eine
Nicht-PDF-Hauptdatei speichern und unverändert wiederholen. Der generische
Download, Detaildialog und Evidence-Export verwenden diese Metadaten.
Öffentliche Freigabelinks bleiben auf PDF-Hauptdateien begrenzt. Bestehende
PDF-Dokumente erhalten den bisherigen Schlüssel additiv, ohne Bytes oder
unveränderliche Zeilen umzuschreiben. Profileingaben erfinden keinen PDF-Dateinamen;
der endgültige Dateiname stammt vom erzeugten Artefakt.

Das bestehende Document-Quellmodell erlaubt jetzt einen vollständigen Record-Bezug
oder ausschließlich einen Workflow-Lauf, ohne Dummy-Record oder zweites Modell.
SQL und öffentliche Schemas lehnen Teilbindungen ab. Neue Workflow-Bindungen
müssen zur selben Base gehören; referenzierte Laufprofile bleiben erhalten.
API-Projektion, Custom-App-Grenzen und Detaildialog berücksichtigen fehlende
Record-Bezüge. Die Base-Ordneransicht gruppiert solche Dokumente nach Workflow
und Jahr; SSR liefert die tatsächliche Base-Schreibberechtigung für Aktionen.
`generateDocument` verarbeitet nun `data` + `output` oder weiterhin `template` +
`record`, ohne die Quellen zu vermischen. CSV, JSON, PDF und freies XML sind
angeschlossen. Alle verwenden dieselbe Receipt-/Datei-/Document-Speicherung.
Query-Zeilen werden nicht in Receipts, Dokumentmetadaten oder das Laufjournal
kopiert; Fremdschlüssel halten den einmal erfassten Query-Payload verfügbar.
Sammel-PDF verwendet den bestehenden Liquid-/Gotenberg-Renderer. XML verwendet
Liquid mit Text-/Attribut-Escaping und eingeschränkten Interpolationskontexten;
`@xmldom/xmldom@0.9.12` prüft das Ergebnis ohne DTD-/Entity-Auflösung. Ungültige
Zeichenreferenzen werden zusätzlich geprüft, da der Parser allein etwa `&#0;`
akzeptiert. Vorlagenfehler werden nach Möglichkeit bereits beim Binden gemeldet.

Die isolierten Finanz-Serializer sind hinzugekommen, aber noch nicht als
ausführbare Workflow-Profile freigeschaltet: DATEV 700/13 mit EUR, UTF-8/BOM,
31 Headerfeldern/125 Spalten und explizitem Festschreibeflag; SEPA
pain.001.001.09 mit lokal gepinntem DK-GBIC-5-XSD, libxml2-wasm und IBAN-Prüfung.
DATEV: 4 Tests/36 Assertions; SEPA: 3 Tests/34 Assertions. Die Prüfung ersetzt
weder einen ADDISON-Importtest noch eine Bankannahmeprüfung.

Die Normalisierung und der bestätigte Query-Issuance-Pfad sind inzwischen intern
angeschlossen. Derselbe eingefrorene Input liefert Vorschau und Datei. Bestätigung
bindet Hash, Workflowversion, Aufrufkontext und Actor; automatische Finanzläufe
werden abgelehnt. Eine neue Reservierungstabelle schützt Geschäftsvorfall-IDs pro
Base, Ziel und Zweck. Drei DB-Tests prüfen atomare Konkurrenz, unveränderliche
Bestätigung und Freigabe nur nach effektfreiem Abbruch. Drei weitere DB-Tests
prüfen DATEV-Issuance, paralleles Replay, falschen Hash/Actor, Rechteentzug,
Abbruch und Doppelexport. Die Workflow-Metadaten, API, UI und CLI sind noch nicht
vollständig angeschlossen; Finanzprofile stehen deshalb nicht in der normalen
Template-/Artefaktvorschau-Registry. Das ist keine zweite Document-Speicherung.

Noch offen: Anbindung finanzieller Profile, Bestätigung und Doppelschutz, weitere im Plan
genannte Datenquellen/Zuordnungen sowie die vollständige UX-/CLI-/Hilfefertigstellung.
Sammel-PDF braucht noch echte Rendering-/Layout-Verifikation. Exportierte Evidence
Bundles nehmen den referenzierten Query-Payload jetzt einmalig mit, auch für
workflowgebundene Documents ohne einzelnen Quell-Record (2 DB-Tests/23 Assertions).
Rechte-/Lease-/Retry-
Fehlerfälle der neuen Issuance benötigen weitere gezielte Tests.
Der Epic ist ausdrücklich nicht abgeschlossen.

Verifikation dieses Quellmodell-Schritts: sieben Browse-Datenbanktests mit
66 Assertions bestanden, einschließlich negativer Bindungen und Base-Trennung.
Die später ergänzte PDF-Freigabeprüfung ist inzwischen bestanden. Ein erneuter
isolierter Migrationstest bleibt offen. API-, Capability-Manifest-, Dialog- und SSR-Prüfungen bestanden; die
Capability-Datenbanktests waren in diesem Unit-Lauf bewusst nicht aktiviert.
Der abschließende API-/Mapper-/SSR-Lauf besteht mit 53 Tests und 166 Assertions;
der rohe Grids-Typecheck, betroffene Biome-Prüfungen und Diff-Check sind grün.

Aktuelle Dateierzeugungs-Verifikation: echter Kernel-Lauf für CSV/JSON/XML aus
einem Capture einschließlich Dry-run ohne Dateien, exakten Dateiinhalten, fehlenden
Zeilenkopien im Document, Wiederholung nach Live-Datenänderung und Löschschutz:
1 Test/21 Assertions bestanden. Bestehende Issuance-/Browse-/Link-Datenbanktests:
13 Tests/192 Assertions bestanden, einschließlich historischer Receipts.
PDF-Renderer-Vertrag mit mehreren Zeilen/Unterposten und Escape-Prüfung:
2 Tests/10 Assertions bestanden, PDF-Antwort dabei simuliert. XML-Grenzen:
4 Tests/37 Assertions bestanden. Abhängigkeitenprüfung besteht. Roher Typecheck
nach XML und Evidence-Erweiterung bestanden. Kein Commit/Neustart.

Breiter Workflow-Lauf: 32 bestanden, 3 fehlgeschlagen. Nachprüfung zeigt
`WORKFLOW_MODULE_MISMATCH`: Der laufende Entwicklungsworker mit altem Manifest
übernimmt neue Testläufe. Zwei Wiederholungen bestanden direkt; der No-op-Test
besteht ebenfalls, wenn seine unabhängigen Läufe unmittelbar nacheinander
erzeugt und ausgeführt werden. Kein Abschwächen der Manifestprüfung. Ein
abschließender vollständiger Lauf unter konsistentem Worker-Stand bleibt offen.

Das erweiterte Workflow-Manifest hat einen neuen Hash. Bestehende Definitionen
müssen vor erneuter Ausführung neu veröffentlicht werden; der Kernel verweigert
alte Pläne mit `WORKFLOW_MODULE_MISMATCH`. Alte Pläne oder Journale werden nicht
umgeschrieben. Die bisherige lokale Inventur zeigte keine aktiven Läufe in den
zugänglichen Demo-Bases; die Berechtigungsgrenze der Inventur bleibt bestehen.

Verifiziert: fokussierte Unit-Tests, Grids-Typecheck, echte Kernel-Läufe für
Query-Freeze/Replay, Rechteentzug, Schemaänderung, öffentliche Record-Parameter
und nicht persistierende Dry-runs, bestehende Dokument-Replays
und Datenbanktests für exakte Zahlen, parallele Änderungen, Vollständigkeit,
Scope-Trennung, Rollback und unveränderliche Wiederholung. Datenbanktests mit
dem bestehenden GQL-Fixture müssen sequenziell in einem Prozess laufen, da
das Fixture feste Feld-Short-IDs verwendet.

Weitere Verifikation des Hauptdatei-Vertrags: fünf Issuance-DB-Tests einschließlich
Nicht-PDF-Erzeugung und historischer Receipts, sechs Browse-Tests, zwei Link-Tests,
fünf Evidence-Tests und zwei Custom-App-DB-Tests bestanden. Die Dokumentdialoge
bestehen vier DOM-Tests; E-Rechnungsprofile und öffentliche Download-Routen
bleiben grün. Der gesamte Migrationstestlauf hatte nur die veraltete Tabellenzahl
als Fehler; nach Anpassung auf die zusätzliche Query-Ablage besteht auch dieser
Test. Die gezielte Upgrade-Prüfung erhält gespeicherte Dokumente, Artefakte und
Dateien. Grids-Typecheck, betroffene Biome-Prüfungen, Diff-Check und bilingualer
Hilfekatalog-Test bestehen. Der Custom-App-Test prüft keine Live-Invalidierung;
seine Metadaten-Publish-Warnungen stammen von der dort fehlenden NATS-Bindung.

## 1. Zielbild und verbindliche Entscheidungen

Ein gemeinsamer Ablauf:

**GQL ausführen → typisiertes Ergebnis festhalten → Dokument erzeugen → gespeicherte Datei verwenden.**

Zwei öffentliche Workflow-Bausteine (vorgeschlagene Namen):
- `query`: GQL mit gebundenen Eingaben ausführen; ein unveränderliches Resultat für diesen Lauf liefern.
- `generateDocument`: dieses Resultat oder vorhandene typisierte Daten mit einer Ausgabe-Konfiguration verarbeiten.

Sechs neue/vereinheitlichte Ausgabeoptionen: PDF, CSV, JSON, XML, SEPA-XML,
DATEV-CSV. Die vorhandenen E-Rechnungsprofile bleiben zusätzlich erhalten:
ein PDF mit eingebettetem XML ist nicht dasselbe wie freie XML-Ausgabe.

PDF kann eine beliebige begrenzte Auswahl mehrerer Records samt Unterposten
darstellen. Kein verpflichtender Dummy-Root-Record, keine manuell anzulegende
Export-Tabelle, kein zweites öffentliches Dokumentmodell.

GQL übernimmt Filter, Joins, Spaltenauswahl, Aliase, Sortierung und Berechnungen.
Ausgabeprofile übernehmen Serialisierung und ihre ausdrücklich definierten
Prüfregeln. Workflow-Autoren verantworten Fachlogik und korrekte Abfragen.

### Alpha und Breaking Changes

Workflow-YAML, Aktionen, Binder, Typen, API, CLI und interne Speicherung dürfen
grundsätzlich vereinfacht oder verändert werden. Bestehende Formen sind
keine Kompatibilitätsvorgabe. Keine Legacy-Aliase, Shims oder zwei Interpreter.

Trotzdem nur Änderungen, die dieses Ziel einfacher und robuster machen:
bestehende Laufhistorie, Effektjournal, Rechteprüfung und Dateiverwaltung nicht
vorsorglich neu erfinden. Alle realen Consumer, Starter, Tests und Dokumente
werden im selben Schnitt umgestellt.

Breaking Contracts sind keine automatische Erlaubnis zum Datenverlust:
gespeicherte Dokumentbytes, Hashes und Nachvollziehbarkeit bewahren.
In-flight Runs und gespeicherte Workflow-Definitionen vor der Umstellung
inventarisieren: explizite Konvertierung oder klarer Neuveröffentlichungsbedarf,
niemals still mit anderer Semantik fortsetzen. Kein Datenbankreset.

## 2. Verantwortungen

| Workflow-Autor | Grids |
| --- | --- |
| Richtige Quellen, Filter, Joins, Gruppen und Summen | Autorisierte Ausführung, Typen, Limits und Fehler |
| Kontierung, Steuerbehandlung, Betragsbedeutung | Exakte Werteübertragung, deklarierte Formatregeln |
| Passende Gruppierung von PDF-Haupt-/Unterposten | Dokumentierte Datenstruktur, sichere Vorlagen und Rendering |
| Stabile Geschäftsvorfall- und Zeilenidentitäten | Deklarierte Identitäten prüfen und atomar reservieren |
| Fachliche Freigabe-/Finalisierungsbedingungen | Konfigurierte Bedingungen serverseitig erzwingen |
| Auswahl eines zum Ziel passenden Profils | Gepinnte Version, reproduzierbare Bytes und Prüfnachweis |

Grids analysiert keine beliebigen Queries auf buchhalterische Richtigkeit.
Ein falsch gewählter Join kann fachlich falsche Summen erzeugen, obwohl alle
Typen und Formate korrekt sind. Vorschau und gespeicherte Query/Ergebnisse
machen dies prüfbar; sie sind keine Garantie korrekter Kontierung.

Kein automatischer Zwang, jede Finanzquelle müsse ein bestimmter Grids-
Recordtyp oder nativ finalisiert sein. Diese bisherige Planvorgabe entfällt.
Sichere mitgelieferte Rechnungs-/Erstattungs-Starter verwenden ausgestellte
Documents bzw. echte Finalisierung; Autoren dürfen andere ausdrückliche
fachliche Regeln konfigurieren. Es gibt keinen stillen Sicherheits-Override:
eine konfigurierte Regel wird bei Ausführung verbindlich geprüft.

DATEV-Export bedeutet nicht Buchungsimport. SEPA-Datei bedeutet nicht Zahlung.
Grids kennt den externen Status nicht und behauptet keine Zertifizierung.

## 3. Bestehende Owner und nötige Änderungen

- `workflows/action-metadata.ts`, `workflows.ts`: generateDocument,
  plan/run, ctx.effectKey, aktuelle Autorisierung.
- `workflows/binder.ts`, `service/workflow-catalog.ts`: gebundene
  Ressourcen, Eingabewerte und Ausgabetypen; vorhandene Expression-Semantik.
- `query-dsl/`, `api/gql-public.ts`: Parser, Resolver, typisierte Spalten,
  Werte und öffentliche IDs. Keine eigene Workflow-GQL-Variante.
- `document-profiles.ts`: versionierte Profile, Zod, Decimal, Artefakte.
- `service/document-issuance.ts`: Freeze, Idempotenz, geschützte Bytes,
  Hashes und Audit; derzeit globale PDF-Pflicht.
- `contracts.ts`, Dokument-API/CLI/UI: derzeit einzelner Record und Template
  verpflichtend; PDF-spezifische Download-/Freigabeannahmen.
- `packages/cloud/src/workflows`: vorhandener Kernel für Revisionen,
  Journaling, Recovery, Leases und Budgets, kein neuer Job-/Workflow-Kernel.

Aktuelle Größenordnungen: Workflow-recordList bis 10.000, Profilinput
5 MiB, acht Artefakte und zusammen 100 MiB pro Erzeugung.
Diese Grenzen sind Ausgangspunkt, keine zugesagte Kapazität für jede Query.
Resultat-, Render-, Query- und Laufbudgets zusammen prüfen und öffentlich
dokumentieren. Keine unmotivierte Anhebung zur Umgehung eines Größenfehlers.

## 4. GQL als wiederverwendbarer Workflow-Schritt

### Vertrag

`query` erhält:
- GQL-Quelltext oder eine explizit gepinnte View-Definition;
- deklarierte typisierte Parameter aus Workflow-Eingaben;
- `saveAs` als Referenz für spätere Schritte.

V1 reicht Inline-GQL. Falls gespeicherte Views unterstützt werden, beim
Veröffentlichen deren konkrete Definition binden, nicht beim Retry die
inzwischen veränderte Live-View verwenden. Keine zwei Abfrage-Implementierungen.

Parameter über den vorhandenen Parser/Resolver typisiert binden.
Keine rohe Liquid-/String-Interpolation in SQL oder GQL.
Nicht vorhandene Workflow-Parameterbindung ist eine explizite Erweiterung
am GQL-Kontext-Owner, kein Escaping-Workaround.

GQL wird beim Veröffentlichen syntaktisch/semantisch geprüft. Bei Ausführung
gelten aktuelle Rechte und erreichbare Schema-Kompatibilität.
Umbenannte Felder werden über stabile Bindungen erkannt; gelöschte/inkompatible
Felder erzeugen einen verständlichen Fehler statt einer anderen Spalte.

### Ergebnis

Ein `grids.queryResult` hat:
- geordnete Spalten mit stabilem Schlüssel, Ausgabename/Alias und Typ;
- Zeilen mit typisierten Werten, nicht nur gerenderten Zelltexten;
- rowCount, Erfassungszeit, Hash und Aussage zur Vollständigkeit;
- intern Query-/Bindings-/Kontextversion und notwendige Autorisierungsscope.

Schlüssel und sichtbarer Spaltenname nicht verwechseln. Doppelte Ausgabenamen
bei JSON-Objekten werden abgelehnt, nicht still überschrieben. CSV-Ausgabe
verwendet eindeutige, geordnete Spalten. IDs bleiben IDs, Labels bleiben Labels.

Decimal-Werte bleiben exakte Strings, boolesche Werte bleiben boolesch,
null bleibt null, Arrays bleiben Arrays. Interne UUIDs nicht versehentlich
als öffentliche Referenzen transportieren. Datum und Zeitpunkt unterscheiden.

Das vollständige Resultat wird einmal pro Schritt dauerhaft festgehalten.
Das allgemeine Laufjournal enthält nur die kleine Referenz plus Metadaten;
keine zweite Kopie großer Tabellen oder Bankdaten. Dafür vorhandene
persistente Workflow-/Dokument-Payloadspeicherung prüfen und minimal erweitern,
keinen neuen benutzersichtbaren Dataset-Katalog bauen.

Eine mutable Query ist **nicht pure**. Die Resultatreservierung/Materialisierung
muss mit stabilem step effectKey recoverbar sein. Vor erstem erfolgreichem Freeze
kann eine fehlgeschlagene Abfrage wiederholt werden; danach liefern alle
Consumer/Retry dasselbe Ergebnis. Zwei Dateischritte verwenden dieselbe Referenz.

Rechte werden bei Query, Verwendung und späterem Zugriff erneut geprüft.
Ein Snapshot ist kein zeitlich unbegrenzter Berechtigungsnachweis.

### Vollständigkeit, Reihenfolge und Zeit

Serverseitige Materialisierung in einem konsistenten DB-Snapshot; nicht
unabhängige Cursorseiten aus sich verändernden Daten zusammenkleben.
Bei erforderlicher Pagination bestehende Query-Owner entsprechend erweitern.

Explizites GQL-LIMIT bedeutet bewusst begrenzte Auswahl und wird in der
Vorschau benannt. Technische Seiten-/Byte-/Timeout-Grenzen dürfen nicht als
erfolgreich vollständiger Export durchgehen. Bei Überschreitung vollständig
abbrechen, keinen Teilbestand exportieren. Finanzstarter warnen besonders
deutlich vor expliziten Auswahlgrenzen.

Exportreihenfolge entspricht GQL-Sortierung. Ohne Sortierung ist sie fachlich
nicht zugesichert, aber der einmal gespeicherte Lauf behält exakt seine Reihenfolge.
Zeit-/Auth-Kontext wird pro Query-Erfassung festgehalten; keine wechselnden
NOW-Werte pro Seite. Abbruch und Leaseverlust dürfen keinen alten Worker
nachträglich veröffentlichen lassen.

## 5. Eine Aktion zur Dateierzeugung

Konzeptueller Vertrag, noch keine ausführbare YAML-API:

`generateDocument({ data, output, filename?, tags?, saveAs? })`

`output` ist eine strikt diskriminierte Konfiguration:
- pdf: HTML/CSS-Vorlage bzw. gebundene vorhandene Vorlage;
- csv: Spaltenauswahl/Überschriften und CSV-Optionen;
- json: Zeilenobjekte oder explizite strukturierte Zuordnung;
- xml: XML-Vorlage;
- datev-csv: gepinnte Profilversion, Header, Mapping und Exportidentitäten;
- sepa-xml: gepinnte Profilversion, Auftraggeber, Ausführungstag, Mapping
  und Exportidentitäten.

Die Registry darf vorhandene E-Rechnungsprofile weiterhin ausdrücken.
Keine parallelen exportDatev/exportSepa-Aktionen als zusätzliche API.
Fachlich passende Buttontexte sind Presentation derselben Aktion.

`data` verweist auf Query-Ergebnisse, Record-/Document-Snapshots oder
gebundene typisierte Workflow-Werte. Keine implizite erneute Query in der
Vorlage. Eine neue Ausgabevorlage kann daher ohne zwingende einzelne tableId
arbeiten. Direkte Record-Erzeugung und Workflow-Erzeugung erreichen denselben
Normalisierer und Issuance-Service; weder doppelte Templatesyntax noch
zweiter Renderpfad.

Resultat: normale Document-Referenz, primäres Artefakt, MIME-Typ, Dateiname,
Größe, Hash und kleine profilabhängige Zusammenfassung. Kein Base64 und
keine sensitiven Rohzeilen im allgemeinen Log oder Capability-Result.
Schema, Binder, Autocomplete, UI und CLI müssen dieselben Felder kennen.

## 6. Die sechs Ausgabeoptionen

### PDF

Mehrere Records in einem PDF, beispielsweise Erstattungen mit jeweiligen
Positionen, Lieferschein mit mehreren Aufträgen oder Monatsübersicht.

Datenstruktur bewusst:
- Object-List-Spalte: direkt pro Hauptzeile die enthaltenen Positionen iterieren.
- Flache Join-Zeilen: Autor sortiert nach Haupt-/Unterposten; vorhandene
  Liquid-Gruppierung/Iteration benutzen oder Hauptüberschrift bei Schlüsselwechsel.
- Kein automatisches „Relationen in Baum verwandeln“. Keine erfundene GQL-
  Nested-Select-Syntax. Ein tatsächlich fehlendes benötigtes Template-Primitive
  als kleine dokumentierte Ergänzung, nicht neue Transformationssprache.

Die Vorlage bekommt die festgehaltenen rows/columns beziehungsweise dokumentierte
benannte Datenwerte. Datenherkunft liegt getrennt davon und verschmutzt nicht
die sichtbaren Tabellen. HTML-Escaping, begrenzte Schleifen, Renderbudget,
kontrollierte Asset-Ladewege und bestehende PDF-Infrastruktur weiterverwenden.
Teste lange Listen, mehrseitige Unterposten, wiederholte Tabellenköpfe,
Seitenumbrüche, Sonderzeichen und leere Auswahl.
Ein Sammel-PDF ist Rendering des Gesamtergebnisses, nicht zwangsläufig
Zusammenkleben einzelner PDFs.

### Freies CSV

Standard: GQL-Spaltenreihenfolge und Alias als Header; Zeilen als Werte.
Optional Spalten auslassen/umbenennen, Trennzeichen und dokumentiertes
Zeilenende/Encoding wählen. V1 UTF-8; zusätzliche Encodings nur bei belegtem
Bedarf, DATEV besitzt unabhängig seinen vorgeschriebenen Serializer.

CSV-Escaping und Quotes zentral, keine Liquid-Schleife für Delimiter.
Null wird standardmäßig leeres Feld; dieser verlustbehaftete CSV-Vertrag wird
erklärt. Verschachtelte Werte müssen explizit als JSON-Zellwert oder durch
Query-Projektion behandelt werden; kein implizites "[object Object]".
Exakte Zahlendarstellung unabhängig von UI-Locale.
Spreadsheet-Formelinjektion: sicherer Standard behandelt gefährliche
Textzellen ausdrücklich und zeigt Änderungen an; unveränderte Rohtextausgabe
nur als bewusste Autorenoption mit Warnung. Nicht Zahlenwerte blind umschreiben.

### Freies JSON

Standard: Array von Objekten mit eindeutigen Spaltenaliasen als Schlüssel.
Optional vorhandene strukturierte Wertezuordnung für einen Wrapper.
JSON-Serializer statt Texttemplate. Decimal-Strings bleiben Strings; keine
stille Number-Konvertierung. Native Arrays/null/bool bleiben erhalten.
Keine doppelte JSON-Kodierung. Schema-Validierung nur, wenn ausdrücklich
konfiguriert; kein universeller JSON-Schema-Editor in V1.

### Freies XML

Vorlage definiert Root, Elemente, Attribute, Namespaces und Schleifen.
Werte werden kontextgerecht XML-escaped, nicht bloß HTML-escaped.
Sichere Interpolation nur in unterstützten Text-/Attributkontexten; keine
beliebigen dynamischen Tagnamen, DTDs, Entities, Raw-XML-Injektion oder
Netzwerkauflösung. Nicht unterstützte Vorlagenkonstrukte klar ablehnen.

Vorlagenparser/Serializer-Lösung anhand der vorhandenen Liquid-Infrastruktur
prüfen; Sicherheit nicht allein durch nachträgliche Wohlgeformtheitsprüfung
behaupten. Ergebnis mit sicherem XML-Parser auf genau ein Wurzelelement,
Namespaces, ungültige Zeichen und Wohlgeformtheit prüfen.
Freies XML ist ohne festes Fachprofil nicht „SEPA-konform“ oder „E-Rechnung“.
Keine beliebigen Remote-XSDs oder Plugin-Uploads als beiläufiges Feature.

### DATEV-CSV

Fester versionierter EUR-Buchungsstapel, ein konfiguriertes Buchhaltungsziel
und Wirtschaftsjahr je Datei. Autor ordnet Belegdatum/-nummer, exakten Betrag,
Soll/Haben, Konto/Gegenkonto und benötigte Steuer-/Kostenstellenfelder zu.
Konten als Strings; führende Nullen erhalten. Eine fachliche Quelle darf
mehrere eindeutig bezeichnete Buchungszeilen liefern.

Kein automatisches Kontieren oder Erraten von Netto/Brutto/Steuer.
Keine automatische Stammkontenanlage, DATEV-Cloud-API oder Belegtransfer.
Aktuelle offizielle Spezifikation bestimmt Header, Spaltenversion, Zeichensatz,
Feldlängen, Datum und Festschreibeflag. Letzteres ist nicht Grids-Finalisierung.
Unbekannte Felder, Precision-Verlust und Zeichensatzverlust ablehnen.
Korrekturen/Stornos sind ausdrücklich konfigurierte neue Geschäftsvorfälle.

### SEPA-XML

Fester versionierter EUR-SCT-Vertrag. Kandidat pain.001.001.09; tatsächliches
DK-Subset und Bankakzeptanz vor Profilabschluss bestätigen.
Ein Auftraggeberkonto/Ausführungstag pro Datei; positive exakte Beträge,
Empfängername, IBAN, Verwendungszweck und Zahlungsidentität.

Keine Lastschrift, Echtzeit-/sonstige Auslandszahlung, Bankübermittlung,
automatische IBAN-Eigentümerprüfung oder Zahlungsbestätigung.
IBAN-Struktur/Prüfsumme, Profilfelder, Transaktionsanzahl und Kontrollsumme prüfen;
keine stillen Kürzungen, Rundungen oder Datumskorrekturen.
Message-/Payment-/EndToEnd-IDs vor Rendering dauerhaft vergeben.
XML lokal gegen gepinntes Schema/Subset und zusätzliche Formatregeln validieren.
Schema-valid ist nicht garantierte Bankannahme.

## 7. Finanzielle Herkunft: expliziter Autorenvertrag

GQL mit Joins/Gruppen bleibt auch für Finanzprofile zulässig.
Kein Grids-Provenance-Compiler, der beliebige Aggregationen buchhalterisch
beweisen soll. Der Autor muss folgende Werte ausdrücklich zuordnen:

- `destinationKey`: dauerhaftes Buchhaltungs-/Zahlungsziel; kein frei
  wechselndes Endnutzer-Argument;
- `businessId`: stabiler fachlicher Vorgang, nicht zufällige Query-Zeilennummer,
  Betrag, IBAN, Workflow-ID oder bei jedem Rendering neue Document-ID;
- `entryId`: eindeutige Zeile innerhalb des Vorgangs, wenn mehrere entstehen;
- optional autorisierte Quellreferenzen für nachvollziehbare Links;
- Beträge/Direction und weitere Profilfelder.

Grids prüft nichtleere IDs, Eindeutigkeit von (businessId, entryId) innerhalb
des Laufs sowie bestehende Reservierungen. Mehrere DATEV-Zeilen desselben
Vorgangs sind erlaubt und werden gemeinsam beansprucht. SEPA hat in V1 eine
Zahlung je businessId; mehrere zusammengefasste Verpflichtungen verlangen
eine vom Autor verwaltete stabile Settlement-Identität.

Eine Aggregation, die viele Vorgänge in einem neuen Schlüssel zusammenfasst,
kann Überschneidungen zu einem anderen Schlüssel verdecken. V1 verspricht
dafür **keine automatische Erkennung**. Die mitgelieferten Starter exportieren
deshalb pro realem Vorgang, nicht mit täglich neu gebildeten Aggregat-IDs.
Mehrere Quellen vollständig und sinnvoll zu identifizieren ist Autorenpflicht.
Automatische Teilzahlungen/Restbeträge sind nicht Bestandteil dieses Features.

Nur die explizit angegebenen Referenzen werden als Zeilenherkunft angezeigt.
Bei Aggregaten ohne Einzelreferenzen bleibt nachvollziehbar: Query,
Parameter, gebundene Quellen, Ergebnis, IDs und Mapping. Nicht behaupten,
Grids habe die exakte rückwärtige Zeilenherkunft bewiesen.

Rechnungsstarter verwenden konkrete ausgestellte Document-Snapshots, nicht
aktuelle mutable Rechnungszeilen oder PDF-Textextraktion. Hierzu vorhandene
Document-/Workflow-Wertebindung verwenden; GQL bekommt nicht beiläufig
eine neue Document-Tabellenwelt. businessId bleibt der fachliche Rechnungsvorgang,
während die Document-ID den verwendeten Datenstand identifiziert.

Autoren können durch absichtlich falsche IDs/Konfiguration den fachlichen
Doppelschutz unterlaufen. Das ist transparent zu dokumentieren, nicht als
systemweite Garantie „niemals doppelt bezahlt“ zu verkaufen.

## 8. Freeze, Vorschau und Retry

### Normale Berichte

Queries einmal festhalten, daraus beliebig mehrere Dateischritte.
Ein Retry derselben Aktion liefert dasselbe Document/Artefakt; ein bewusst
neuer Lauf darf neue CSV/JSON/XML/PDFs aus denselben Quellen erzeugen.
Keine fachliche Quellenreservierung für freie Formate.
Zeitgesteuerte Berichte dürfen ohne jedesmalige Bestätigung laufen, sofern
der veröffentlichte Workflow und seine Rechte das erlauben.

### Finanzprofile

Interaktive Vorschau ist auf die **normalisierten Ausgabewerte** bezogen.
Sie enthält auch Ziel, Profilversion, IDs, Zeilenzahl, Summen und Datenstand.
Nicht nur eine erste Tabellenseite als bestätigten Gesamtinhalt behandeln.

Implementierungsweg: Der vorhandene Workflow-Kernel hält am finanziellen
Dokumentschritt mit einer Abhängigkeit an. Das vorhandene Issuance-Receipt hält
Query-Referenz, Profil/Mapping, normalisierten Hash, stabile Zahlungs-IDs und
Aufrufbindung. Der Bestätigungsdialog liest daraus die normalisierten Werte;
Bestätigung speichert Actor/Zeit und weckt den Lauf atomar. Kein zweiter
Preview-Interpreter oder separater Launcher-Ausführungslauf. Der persistierte
Kernel-Impuls behandelt auch eine Bestätigung unmittelbar vor dem Parken.

Vor der Annahme aktuelle Rechte und konfigurierte Freigabe-/Frischebedingungen
prüfen. Bei vom Autor deklarierter sourceVersion- oder Freigabebedingung
führt Änderung zum Konflikt. Kein pauschaler, nicht implementierbarer
Frischebeweis für jede aggregierte GQL-Abfrage.
Die Vorschau zeigt den Zeitpunkt des Snapshots; Quellenänderungen werden
nicht heimlich in eine bereits bestätigte Datei übernommen.

V1 automatische Finanzexport-Auslösung nicht implizit freischalten.
Falls automatische Erstellung gewünscht wird, benötigt sie später eine
explizite veröffentlichte Freigabepolicy; eine generische Schedule darf die
interaktive Schranke nicht beiläufig umgehen.
Keine Universalsperre für automatische freie Reports.

### Dauerhafter Doppelschutz

Atomare Reservierung auf (Base, destinationKey, Profilzweck, businessId).
Profilzweck trennt Buchhaltung von Zahlung, nicht jede neue Formatversion.
Workflow-Kopie, Revision oder anderes Idempotency-Key heben Sperren nicht auf.
Alle Vorgänge eines Stapels reservieren oder keinen; kein stilles Skippen.
Bestehende Datei nur mit erlaubter Referenz nennen.

Freeze + Reservierungen atomar; Renderer außerhalb langer Quellsperren.
Document, Artefaktreferenzen und abgeschlossene Reservierungen gemeinsam
veröffentlichen. Recovery nach Crash, Leaseverlust und Abbruch über den
bestehenden Kernel. Nachweislich effektfrei abgebrochene Reservierungen
nur atomar und gegen alte Worker gefenced freigeben.

Nach Veröffentlichung keine automatische Freigabe durch Löschen/Fehler
eines späteren Schrittes. Wiederherunterladen liefert identische Bytes.
Kein V1-„nochmal zahlen“-Override. Ersatz nach Bankablehnung erfordert einen
gesonderten kontrollierten Prozess; zweimaliger manueller Upload derselben
SEPA-Datei kann Grids nicht verhindern.

## 9. Ein Document-Modell und klare Zugriffsgrenzen

Profile deklarieren primäres Artefakt und Dateityp. PDF bleibt für PDF- und
E-Rechnungsprofile erforderlich, nicht global für jedes Document.
Unveränderlicher Ursprung: Record-Template oder Workflow-Datenstand, mit
eindeutiger Struktur statt widersprüchlicher optionaler IDs.
Vorhandene Issuance-/Artefakt-/Audit-/Retention-Owner weiterverwenden.

Katalog, Suche, Ordner, Detail und CLI behandeln alle Formate. Benannte
Vorlagen/Workflow-Familien und Jahr statt künstlicher Tabellenwurzel.
Detail: Dateiname, Typ, Quellenzusammenfassung, Datenstand und Download;
technische Infos im Submodal. CSV/JSON/XML-Vorschau als sicher gerenderter
Text beziehungsweise Tabelle, nie aktives HTML/XML. Kein Zwang zum PDF-Merge.
Mehrfachausgabe ergibt mehrere Documents mit derselben Query-Referenz.

Sammeldateien sind unteilbar: Zugriff auf einen enthaltenen Record ist
niemals Zugriff auf die gesamte Datei. Base-Vertrag bleibt maßgeblich;
App-only-Nutzer benötigen explizite veröffentlichte Ausgabe-/Laufberechtigung
für die ganze Ergebnismenge. Auch Counts, Suchtreffer, Resultatreferenzen und
Fehler dürfen keine fremden Empfänger/Beträge offenlegen.

Keine neuen öffentlichen Freigabelinks für CSV/JSON/XML/Finanzdateien in V1.
Bestehende PDF-Links bewahren; Sammel-PDFs nur explizit nach vollständiger
Ausgabeberechtigung teilbar, nicht durch bloße Quell-Record-Freigabe.

Große Payloads und Bankdaten nicht ins allgemeine Journal oder Logs kopieren.
Prepared-Resultate haben begrenzte Lebensdauer; angehängte Resultate bleiben
solange erhalten, wie Document-/Run-/Hold-Verträge sie benötigen.
Löschen eines Workflows entfernt weder Dokumente noch Finanzreservierungen.
Abgeleitete Daten behalten Schutz-/Retention-Zuordnung, kein Retention-Bypass.

## 10. UX, CLI und Agentenwissen

Autoren:
1. GQL-Schritt anlegen; vorhandenen Editor mit Schemahilfe und Parametern nutzen.
2. Typisierte Vorschau einschließlich Aliase, Reihenfolge und Umfang.
3. Datei-Schritt hinzufügen, benanntes Ergebnis wählen.
4. Ausgabeformat wählen; nur dessen erforderliche Optionen zeigen.
5. CSV/JSON sofort sinnvoll vorbelegen; PDF/XML Vorlage und Datenpfade zeigen.
6. DATEV/SEPA Fachmapping, IDs und Zielkonfiguration ausdrücklich einrichten.

Nutzer:
- Ein Button mit fachlichem Namen, keine technische Profilverwaltung.
- Finanzvorschau mit vollständigem Umfang, Summen, Ziel und Datenstand.
- Fehler mit Zeile/Spalte und konkretem Handlungsschritt; keine rohe SQL-/Zod-Ausgabe.
- Nach Bestätigung vorhandene Run-Fortschrittsansicht, danach Download.
- „Datei erstellt; Import/Zahlung nicht durch Grids bestätigt.“
- Bei Konflikt vorhandenen Export öffnen oder neue Vorschau; niemals blindes Retry mit neuem Schlüssel.

k2b/ui, DE/EN, Tastaturbedienung, mobile Layouts, SSR für erste Daten,
Loading/Empty/Error/Conflict und Focus-Verhalten sind Abnahmekriterien.
IBAN in Übersichten maskieren, für berechtigte Prüfer bewusst vollständig
sichtbar machen. Keine doppelte Fehlermeldung und kein JSON-Dump im normalen UI.

CLI: dieselben Schema-/Validierungs-, Preview-/Confirm-, Run-/Downloadwege.
Maschinenresultate enthalten typisierte Werte oder referenzierte Daten,
nicht UI-Markup. Neue Optionen vollständig in generierter Custom-App-
Referenz, Workflow-Catalog/Completion, In-App Help und cloud-cli-Grids-Skill.
Assistant-Skill erklärt Ablauf und verweist auf Help; keine zweite Vollkopie.
Kein neuer unrestricted Query-/Workflow-Admin-Capability-Weg für App-Leser.

## 11. Konkrete Szenarien zur Abnahme

1. Inventarliste: GQL wählt drei Spalten, benennt sie um → CSV in genau dieser Reihenfolge.
2. CRM: gefilterte Kontakte → JSON, null/bool/Decimal ohne Typverlust.
3. Technischer XML-Austausch mit Umlauten, Quotes und Namespaces.
4. Monats-PDF mit vielen Erstattungen und Object-List-Unterposten.
5. PDF aus flachen Join-Zeilen mit korrekt vom Autor gruppierten Hauptabschnitten.
6. Derselbe Query-Schritt erzeugt PDF und CSV ohne neue Datenabfrage.
7. Zeitgesteuerter Wochenbericht darf dieselben Records nächste Woche wieder exportieren.
8. Leere freie Auswahl → CSV mit Header, JSON [], PDF/XML nach Vorlage;
   leeres Finanzprofil → klarer Fehler, keine leere Zahlungsdatei.
9. DATEV-Rechnung mit mehreren Buchungszeilen und stabiler businessId/entryId.
10. Rechnungskorrektur als eigener Vorgang, Original unverändert.
11. SEPA-Auslagen mehrerer Kostenstellen, aber nur autorisierter Finanzer erhält Gesamtdownload.
12. Fachlich schlechter Join: nicht automatisch „repariert“; doppelte deklarierte entryId wird
    abgelehnt, eindeutige aber fachlich falsche Summen bleiben Autorenverantwortung.
13. Neue Formatversion/Workflowkopie erlaubt keine zweite Reservierung derselben IDs.
14. Falsche/wechselnde Autoren-IDs: Grenze explizit demonstrieren, kein falsches Sicherheitsversprechen.
15. Query-Limit versus technische Abschneidung; konsistentes mehrseitiges Ergebnis.
16. Query-/Render-Crash und Retry; gespeicherte Ergebnisse/Bytes bleiben identisch.
17. Rechteverlust zwischen Vorschau, Start, Verwendung und Download.
18. JSON-Schlüsselkonflikte, CSV-Formelinjektion, XML-Entities/Raw-Injection,
    ungültige Unicode-Zeichen und Formatlimits.
19. Bestehende PDF/E-Invoice-Documents, öffentliche Altlinks, Evidence und Holds.
20. Breaking-Change-Umstellung von YAML, Binder, APIs, CLI, Startern und offenen Runs;
    kein alter Vertrag bleibt als stiller Fallback übrig.

Tests: fokussierte Serializer-/Parser-/Binder-Units, PostgreSQL-Transaktions-
und Concurrencytests, Workflow-Recovery, API/CLI/App-Rechte sowie kleine
visuelle Abnahme für Multi-Record-PDF und Exportdialogs. Keine breite
Browser-Testkampagne als Ritual. Keine Tests nötig für diese reine Planänderung.

## 12. Arbeitspakete und Reihenfolge

A. Gemeinsame Daten-/Document-/Workflow-Verträge vereinfachen:
   QueryResult, primäres Artefakt, mehrzeiliger Ursprung, Breaking-Change-Cut,
   alle Consumer und Rechtepfade inventarisieren.

B. GQL-Schritt und freie Ausgaben end-to-end:
   dauerhafter Query-Freeze, PDF/CSV/JSON/XML auf einer generateDocument-Aktion,
   Multi-Record-PDF, Limits, sichere Serializer, Recovery und UI/CLI.

C. Gemeinsame Finanzschicht und DATEV:
   Prepared Preview, deklarierte businessId/entryId, atomare Reservierungen,
   feste DATEV-Version/Mapping, Rechnungs-/Erstattungs-Starter.

D. SEPA-Profil:
   gleiche Finanzschicht, gepinntes Schema, Auftraggeber/Empfänger,
   stabile IDs/Summen, sichere Finanzer-Oberfläche.

E. Gesamtintegration, Dokumentation und Abnahme:
   vollständige API-/CLI-/Skill-/Help-Story, alle sechs Optionen,
   bestehende E-Rechnungsprofile und private Demo.

Abhängigkeiten: A → B → C → D → E.
Empfohlener erster großer Slice: **A+B**, mit echter GQL-basierten PDF-
Übersicht samt Unterposten plus CSV/JSON/XML. Damit wird das gemeinsame Modell
belegt, bevor DATEV-/SEPA-Spezifika hinzukommen. Kein eigenes Exportprodukt,
keine neue allgemeine Transformationssprache, kein Plattform-Neubau.

## 13. Offene Spezifikationen und Grenzen

- Aktuelle verbindliche DATEV-Buchungsstapel-Spezifikation/Version beschaffen;
  frühere Webabfrage des DATEV-Developer-Portals war nicht lesbar.
- Tatsächliches ADDISON-/DATEV-Ziel, Kontierungs- und Mandantenparameter.
- Bankprogramm und akzeptiertes pain.001-/DK-Profil; kein Bankpasswort nötig.
- Vor Implementierung QueryResult-/Preview-Payload-Budget mit Kernelgrenzen
  abgleichen; keine willkürlichen unbeschränkten Ergebnisarrays.
- Konkrete sichere XML-Template-Integration anhand bestehender Bibliotheken
  festlegen. Kein pauschales „Liquid autoescape reicht“.
- Keine Bibliothek ungeprüft festgelegt. Zod/Decimal, bestehender PDF- und
  XML-Prüfpfad zuerst; neue Abhängigkeiten nach Lizenz, Wartung, Bun-Kompatibilität.
- Offizielle technische Validierung lokal, keine externen Zertifikate nötig.
  Zielsystem-Testimport nur ausdrücklich autorisiert mit Testdaten. Ohne
  Zieltest nur technisch geprüft, nicht für diese Installation bestätigt.

## Quellen und Planungsstand

Source-Owner in Abschnitt 3 sowie kanonische Checkout-Dokumentation:
`docs-site/docs/en/automation/workflow-overview.md`,
`effects-retry-and-reconciliation.md`, Grids Workflow-/Dokumenten-/GQL-Hilfe.
Der lokale MCP war bei der Aktualisierung zunächst nicht erreichbar;
reduzierter Dokumentationsmodus mit aktuellem Checkout, keine neue Behauptung
zur aktuellen DATEV-/Bankversionslage.

Formatquellen aus der vorigen Recherche, vor Implementierung erneut lesen:
- [DATEV Datenschnittstellen](https://www.datev.de/dnlexom/v2/content/documents/1080789/pdf)
- [DATEV Formatportal](https://developer.datev.de/portal/de/dtvf)
- [DK gültige Anlage 3](https://www.ebics.de/de/datenformate/gueltige-version)
- [DK SEPA-Schemata/Beispiele](https://www.ebics.de/de/datenformate/ergaenzende-dokumente)

Umsetzung nach dem Go vom 11. September 2026. Keine Produktionsänderungen,
echten Finanzexporte oder Commits ohne gesonderte Freigabe.
