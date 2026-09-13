# Grids: gezielter Alpha-Hard-Cut

Stand: 12. September 2026. Implementierung freigegeben; keine Lösch- oder Rollout-Freigabe.
Ausgangspunkt: Commit `191486f21`; Review-Remediation vollständig geprüft.

## Empfehlung und Umfang

Ein gezielter Cut vor der ersten produktiven Nutzung dieser Funktionen ist sinnvoll.
Er entfernt mehrere konkurrierende Hash-/Binding-Verträge, nicht die Unterstützung
für reguläre historische Dokumente. Kein vollständiger Grids-Reset und kein
pauschaler Neuaufbau der allgemeinen Datenmigrationen.

Größenordnung nach Source-Lektüre: etwa 150–300 netto entfernbarer Zeilen
Laufzeit-/Migrationscode und 150–250 Zeilen Altformat-Tests. Das ist eine Schätzung,
keine gemessene Patchgröße; moderne Regressionen ersetzen Teile der alten Tests.
Die Suche nach hashVersion/hash_version/schemaHashVersion findet 68 Fundstellen
in zwölf produktiven TS-Dateien, aber nicht jede davon ist löschbarer Legacy-Code.
Der größere Gewinn ist weniger alternative Zustände und Versionsweitergabe.

## Was entfällt, was bleibt

| Bereich | Cut |
| --- | --- |
| `service/document-json.ts` und Hash-Aufrufer | Nur deterministische UTF-16-Schlüsselreihenfolge. Locale-Comparator und frei wählbare Algorithmusparameter entfernen; alle Aufrufer einschließlich bisheriger Default-v1-Aufrufer prüfen. |
| `service/workflow-query-data.ts`, Binding-Owner und Workflow-Parser | Nur aktuelle semantische Schema-Bindung. V1/V2-Auswertung und `?? 1` entfernen; alte Bindings ausdrücklich ablehnen, Quellen neu veröffentlichen. |
| Issuance/Capture/Evidence-Metadaten | Ein unterstützter Vertrag. Versionsmetadaten gegebenenfalls als festen Formatmarker behalten, nicht als Mehrfach-Implementierung. Keine Versionsnummern kosmetisch zurücksetzen. |
| Ausstehende Issuance-Receipts | Ungeschriebene Alt-Provenienzfelder `source`/`sourceRevision` nicht mehr akzeptieren. Aktuelle Receipts bleiben nach Unterbrechung und Neustart ohne neue Nummernvergabe fortsetzbar. |
| `service/document-export-claims.ts` | Neu ergänzte Wiederfreigabe vorzeitig reservierter Alt-Claims entfällt. Atomare Reservierung bei Issuance, Unique-Schlüssel und Unveränderlichkeit ausgestellter Claims bleiben. |
| `service/workflow-query-store.ts` | `captured_bytes NOT NULL DEFAULT 0`; historische Summenrekonstruktion entfällt. Run-weites Budget, Serialisierung und replay-neutrale Abrechnung bleiben. |
| `workflows/migrate.ts` | Alten Alpha-Resetpfad durch Initialisierung des aktuellen Vertrags plus eindeutige Ablehnung nicht unterstützter Altstände ersetzen. Kein automatisches Löschen beim Start. |
| Altformat-Tests | V1-Replay-/Altbinding-Erhaltung ersetzen durch Altformat-Ablehnung und Tests des einzigen aktuellen Vertrags. Unicode, Semantik, Recovery und Datenintegrität weiter prüfen. |

## Ausdrücklich kein Legacy

- Eingefrorene Berechnungstypen, transitive Berechtigungsabhängigkeiten,
  Zugriff nach Schemaänderungen, Record-Revisionen und gespeicherte Dokumentbytes.
- Fehlende Berechnungen nach dem Hinzufügen eines neuen Feldes: Das kann auch
  nach dem Launch passieren. Null/Diagnose und Abbruch unvollständiger Summen bleiben.
- Receipt-/Idempotenz-/Lease-Prüfungen, erneute Rechte-/Source-Version-Prüfungen,
  Bestätigung, Claims, Holds und Evidence.
- Capture-Payloads mit `version: 1/2/3/4`: Die aktuellen Writer erzeugen damit
  GQL-Ergebnisse, freie Werte, Dokument- und Record-Snapshots. Alle vier sind aktive
  Varianten. Ein Umbau zu einem `kind`-Discriminator wäre ein eigener Modell-Cut,
  nicht notwendige Legacy-Bereinigung; hier beibehalten.
- Dokumente ohne Record beziehungsweise reine Workflow-Dokumente sind ebenfalls
  unterstützte aktuelle Varianten, keine automatisch löschbaren Altlasten.
- Allgemeine Grids-Migrationen für Dateien, Nummernkreise, Apps und bestehende
  Basisdaten sind nicht von der Aussage „Finanz-/Finalisierungsfeatures noch Alpha“
  abgedeckt. Auch keine Plattform-/fremden App-Daten ändern.

## Umsetzung in einem Slice

1. **Voraussetzung prüfen, read-only:** Für jede tatsächlich betroffene Installation
   unterstützte Hash-/Binding-Versionen, Captures, Receipts, Claims, Runs und
   Finalisierungen inventarisieren. „Nicht produktiv genutzt“ bedeutet nicht leer.
   Lokale Demo-/Testdaten separat erfassen; aktuelle Definitionen/Quellen exportieren.
2. **Cut-Vertrag festlegen:** Keine Daten automatisch umhashen, keine bestätigten
   Receipts übernehmen, keine alten Runs weiterführen. Alte Testartefakte entweder
   ausdrücklich verwerfen oder außerhalb der aktiven Installation archivieren.
   Ein Reset braucht eine gesonderte Freigabe mit exakten Zielen. Wenn echte relevante
   Altbelege vorhanden sind, den Cut für diese Installation nicht durchführen.
3. **Code vereinfachen:** Obige Owner auf einen Vertrag reduzieren, Defaults und
   DB-Constraints entsprechend setzen. Start mit nicht unterstütztem Zustand
   liefert eine klare Diagnose statt stiller Konvertierung oder Schema-Löschung.
4. **Definitionen und Wissen:** Erhaltene Workflow-Quellen regulär neu binden und
   veröffentlichen; niemals alte Bindings/Journale per JSON-Replace ändern.
   Help, CLI-Skill und Evidence-Beschreibung auf den einen Vertrag abstimmen.
5. **Verifizieren:** Frische DB, wiederholter Start, Ablehnung alter Zustände ohne
   Datenänderung, aktuelle Capture-/Issuance-Replays, Rechteentzug, Leasewechsel,
   gleiche Finanz-ID, neue Felder nach Finalisierung sowie Evidence prüfen.
   Danach roher Grids-Typecheck, Biome und kompletter Acht-Phasen-Verifier ohne Skips.

## Umsetzungsstand

Ein Hash-Algorithmus (Formatmarker 2), semantische Query-Bindung 3 und Workflow-
Speichervertrag 9 sind implementiert. Ungültige Altmarker werden abgelehnt, nicht
uminterpretiert. Dokument-Verweise auf Workflow-Runs sind vollständig durch einen
validierten Fremdschlüssel abgesichert. Die frühere Dashboard-Kanal-Konvertierung
im Workflow-Owner entfällt zusammen mit dem automatischen Alpha-Reset.

Gemessene Diff-Bilanz nach Abschluss der Verifikation: 105 Zeilen weniger
Laufzeit-/Migrations-TS und 75 Zeilen weniger Testcode. Das liegt unter der frühen
Schätzung: Die explizite Startprüfung und neue Ablehnungs-Regressionen bleiben
bewusst bestehen. Es geht um weniger Zustände, nicht um eine Löschquote.

### Verifikation

- Vollständiger Acht-Phasen-Verifier auf frischer, isolierter Datenbank:
  2.916 Tests, 21.043 Assertions, keine Fehler, keine Skips.
  Berichte: temporäres Verzeichnis `grids-verification-hqGZvA`.
- Nach dem Gesamtlauf wurden ausschließlich die SQL-Ergebnistypen im neuen
  Migrationstest explizit annotiert. Dieser Test wurde erneut erfolgreich ausgeführt.
- Abschließender roher Grids-Typecheck, Biome für alle 27 betroffenen TS-Dateien
  und `git diff --check` erfolgreich.
- Englische Help-/CLI-Texte offline mit Harper geprüft; Fachbegriffe wie
  `canonicalization` sind keine Korrekturgründe. Keine fachfremden Prosaänderungen.
- Kein Browserlauf, Neustart, Rollout, Commit oder Eingriff in vorhandene App-Daten.

## Freigabegrenze

### Review-Nachtrag: Startvertrag und Upgrade-Vorprüfung

- Der Workflow-Ledger ist kein Kompatibilitätsnachweis mehr. Unterstützte
  v8-Daten bleiben erhalten; Marker 9 wird erst nach erfolgreicher Migration
  ergänzt. Auch soft-gelöschte, kompatible Workflows bleiben unverändert.
- Die gemeinsame Start-/Vorprüfung kontrolliert Hashmarker, fehlende oder
  NULL-Capture-Budgets, alte Workflow-Tabellen, Launcher und gespeicherte
  Grids-Kernel-Pläne. Ein manuell eingefügter Marker umgeht diese Prüfung nicht.
- `packages/grids/scripts/check-alpha-upgrade.ts` prüft vor einem Deployment
  eine wiederhergestellte Kopie ohne Schema-/Datenänderung und ohne App-Start.
  Die verbindliche Betreiberanleitung steht in
  `docs-site/docs/en/operations/grids-alpha-upgrade.md`.
- Unvereinbare Installationen bleiben auf ihrem bisherigen Stand oder werden
  vollständig archiviert und durch eine getrennte frische Installation ersetzt.
  Es gibt keinen pauschalen Löschpfad und keine Zusage einer verlustfreien
  Übernahme alter Journale durch Quellenexport.
- Hash-Constraints werden nur bei abweichender Definition ersetzt. Der doppelte
  Start-Assert, die Dashboard-Launcher-Konvertierung und die unerreichbare
  Claim-Freigabe entfallen. DB-Unveränderlichkeit und Runtime-Prüfungen bleiben.
- Help und CLI-Skill unterscheiden fehlgeschlagene Abfragen, `needs_attention`
  und abgelehnte App-Starts. Fehlende Budgets werden nicht mehr als rekonstruierbar
  beschrieben.

Verifiziert am 12. September 2026:

- Acht isolierte Testphasen: **2.920 Tests, 21.075 Assertions, keine Fehler/Skips**.
  JUnit-/Log-Verzeichnis: `grids-verification-yzuRdu` im temporären Systemverzeichnis.
- Feste Unicode- und Query-Schema-Digests, Ledger `[8]`, Marker-Bypass,
  Constraint-OID-Stabilität, unveränderte veröffentlichte Pläne, CLI-Vorprüfung,
  kumulatives Capture-Budget und bestätigte Finanz-Receipts nach Migration geprüft.
- Roher Grids-Typecheck, Biome für alle betroffenen TS-/Manifest-Dateien und
  `git diff --check` erfolgreich. Harper geprüft; Satz- statt Titelgroßschreibung
  folgt den vorhandenen Dokumentationskonventionen.
- Fallow 2.52.0: Zwei nachweislich nur intern verwendete Typ-Exports entfernt.
  Danach erneut Typecheck und Fallow; **keine Dead-Code-Findings** im geprüften
  Grids-Diff. Das Audit bleibt mit Exit 1 bei 57 Komplexitäts- und 63
  Duplikationshinweisen in den betroffenen Dateien, einschließlich bestehender
  Issuance-Funktionen und ähnlich aufgebauter SQL-/Testblöcke. Kein pauschales
  Refactoring oder Unterdrücken dieser Hinweise. Fallow hat keine Laufzeitabdeckung
  erhalten; seine Coverage-basierten Risikowerte ersetzen nicht die Testberichte.
- Nach dem Gesamttest wurden nur die beiden `export`-Schlüsselwörter an Typen
  entfernt. Keine Laufzeitänderung, keine bestehenden App-Daten verändert und
  keine Dienste neu gestartet. Noch nicht committet.

Die Umsetzung und Prüfung erfolgt gegen isolierte Testdatenbanken. Ein Start gegen
bestehende Installationen, eine Bereinigung oder ein Commit sind getrennte Schritte.
Vor dem Rollout muss klar sein, welche Daten verworfen werden dürfen und ob es zu
erhaltende Artefakte im betroffenen Alpha-Vertrag gibt. Ein Backup allein macht das
Weiterführen alter Hashes mit einem neuen Algorithmus nicht korrekt.

### Lokaler Bestand (nur lesend geprüft)

587 Dokumente, 199 Issuance-Receipts und 67 Query-Captures haben Hashmarker 1.
290 Run-Profile haben noch keinen Capture-Budgetwert. Daneben existieren 25
Finanz-Claims und 20 finalisierte Datensätze. Diese Werte beweisen keine
Entbehrlichkeit. Der Cut lehnt diesen Bestand beim Start ab; keine Daten wurden
gelöscht, umgehasht oder migriert. Quellenexport, Archivierung und Aktivierung sind
noch nicht durchgeführt. Allgemeine Basisdaten bleiben außerhalb des Cuts.
