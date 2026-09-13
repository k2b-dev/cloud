# Grids: Abdeckung und Auffindbarkeit im Cloud-CLI-Skill

Stand: 13. September 2026. Analyse, keine Implementierung.

## TL;DR

Die Referenz ist breit, aber nicht vollständig genug, um einen Agenten ohne Quelltextstudium zuverlässig durch die Konfiguration zu führen. Das ID-Beispiel ist eine echte Lücke. Auch der vermeintliche Ausweg über den Live-Katalog ist dort unvollständig und teilweise falsch.

Die wichtigsten fehlenden Bereiche sind generierte IDs, Feldkonfiguration und Defaults, Tabellen-/View-Darstellung, Formularregeln, Audit-Konfiguration und Liquid-Funktionen. Daneben gibt es ungültige GQL-Beispiele und Lücken im Index. Workflows, Custom Apps, Berechtigungsgrenzen, unveränderliche Dokumente und Evidence sind deutlich besser beschrieben.

Empfehlung: keinen noch längeren Monolithen schreiben. Einen vollständigen Themenindex mit direkten Fachreferenzen anbieten; genaue öffentliche Konfigurationsschemas aus den bestehenden Verträgen zugänglich machen. Pro Funktion müssen Bedeutung, Einstieg, gültiges Beispiel und Grenzen auffindbar sein.

## Prüfumfang und Grenzen

Abgeglichen wurden:

- `skills/cloud-cli/SKILL.md`, die gesamte `references/grids.md` und `references/grids-build-apps.md`;
- die registrierten CLI-Gruppen in `packages/grids/src/cli.ts`, ihre Befehlsdefinitionen und Referenz-Helfer;
- alle 22 Feldtypen der Registry und ihre Konfigurationsverträge;
- öffentliche Tabellen-, View- und Formularverträge, Custom-App-Referenz, Workflow-Aktionsmetadaten und Dokumentverträge;
- API-Gruppen, In-App-Hilfethemen und vorhandene Base-/Dokument-Starter als zusätzliche Feature-Inventare.

Die installierte Grids-Referenz war beim Vergleich bytegleich mit der Repository-Version. Es ist kein bloßes Installationsproblem.

Dies ist eine Prüfung auf Feature-Abdeckung und Auffindbarkeit, keine vollständige Laufzeitabnahme sämtlicher Optionen. Die CLI-Dateien enthalten 203 wörtliche `command("…")`-Registrierungen plus dynamisch erzeugte Befehle; die Zahl ist ausdrücklich nicht die Gesamtzahl ausführbarer Befehle. Ein vorhandener Befehl wurde nicht automatisch als ausreichend dokumentiertes Feature gewertet.

Zwei einfache GQL-Varianten wurden lokal direkt durch den Parser geschickt. Keine Base wurde verändert, keine Services wurden neu gestartet und keine vollständige Testsuite ausgeführt. Die parallele Arbeit an der Test-Base blieb unberührt.

## Bestätigte Findings

### 1. Generierte IDs sind nicht verständlich dokumentiert — hoch

`references/grids.md:257` nennt `id` nur in der Gruppe „System or generated“. Es fehlen die sieben Strategien und deren Optionen. Besonders relevant: `assignment: "creation" | "finalization"` gilt für `sequence` und `date_sequence`, nicht beliebig für jede Strategie.

Der Live-Katalog in `packages/grids/src/cli/schema-support.ts:106` nennt zwar die Strategien, beschreibt aber pauschal „Generated on record create“ und zeigt kein `assignment`. Der tatsächliche Vertrag steht in `field-types/system.ts:23`.

**Ergänzen:** Strategietabelle mit Defaults, `prefix`, `padding`, `period`, `length`, `groups`, `segmentLength`, Vergabezeitpunkt und Einschränkungen. Ein durchgehendes Beispiel: Durable History → Finalisierung aktivieren → Nummernfeld mit Vergabe bei Finalisierung → Entwurf → Finalisierung. Technische Lücken sind möglich; weder Lückenlosigkeit noch rechtliche Konformität versprechen.

### 2. Der Feldkatalog liefert Beispiele statt vollständiger Verträge — hoch

`cli/schema-support.ts:22` definiert `config` und `recordValue` als Text. `fieldTypeReferences()` ergänzt Registry-Kategorie und Schreibbarkeit, aber kein vollständiges Konfigurationsschema. Ein Beispiel zeigt weder alle Optionen noch deren Grenzen und Kombinationen. Deshalb kann ein Agent trotz korrekt befolgter Discovery unvollständige Informationen erhalten.

**Ergänzen:** öffentliche Konfigurationsschemas aus den bestehenden Validatoren, ergänzt um kurze semantische Hinweise. Keine zweite handgepflegte Schema-Wahrheit. Feld-ID-Referenzen müssen dabei öffentlich bleiben; interne UUID-Verträge dürfen nicht unübersetzt publiziert werden.

### 3. Feld-Eigenschaften und Defaults fehlen als zusammenhängender Vertrag — mittel

Die Referenz erklärt Payloads und einige Typen, aber nicht systematisch `required`, `unique`, Index, Record-Label, Sichtbarkeit, Defaults und deren Zusammenspiel. Der CLI unterstützt entsprechende Feldoperationen (`cli/schema.ts:760`); die Typdetails sind teilweise nur im Live-Beispiel sichtbar.

**Ergänzen:** gemeinsame Feldoptionen separat von typspezifischem `config`; Beispiele für Record-Label, eindeutigen Wert, Datum/Default und berechnete Felder. Keine Verwechslung zwischen normalem Default, festem Formularwert und serverseitig gebundenem App-Wert.

### 4. `object_list` fehlt im zentralen Feldtypen-Verzeichnis — mittel

Das Feature ist unter `references/grids.md:321` ausführlich vorhanden, fehlt aber in der Liste unter „Field types“. Wer dort nach möglichen Datentypen entscheidet, kann es übersehen. Der Business-App-Leitfaden nennt für Rechnungen separate Positionstabellen, ohne die Alternative eingebetteter, gemeinsam finalisierter Positionen direkt gegenüberzustellen.

**Ergänzen:** Typ in die zentrale Liste aufnehmen und den Modellierungsvergleich dort sowie im Rechnungs-Szenario verlinken.

### 5. Tabellen- und View-Darstellung ist kaum dokumentiert — hoch

Der Abschnitt „Views“ (`references/grids.md:759`) zeigt Name, GQL und Sharing. Es fehlen `ui.displayConfig`, Cards mit Bild/Feldauswahl, Calendar mit Datumsfeld, Spaltenkonfiguration, berechnete Spaltenformate sowie Reihenfolge und Ausblenden gruppierter Spalten.

Quellen: `api/public-dto.ts:267`, `contracts.ts:1043`, Tabellenoptionen in `contracts.ts:259`. Die Befehle nehmen JSON-Bodies entgegen; bloß auf `--help` zu verweisen erklärt deren innere Struktur nicht.

**Ergänzen:** öffentliche JSON-Beispiele für Tabelle, Cards und Kalender; Datenabfrage klar von Darstellung trennen. App-Block-`display` ist nicht dasselbe Objekt wie View-`ui.displayConfig`.

### 6. Anzeigeformate sind praktisch unsichtbar — mittel

`contracts.ts:572` unterstützt Datum, Dezimal, Prozent, Fortschrittsanzeige und Barcode. Die Grids-Referenz erklärt diesen Formatvertrag nicht. Das ist insbesondere für Inventar/Labels und fachlich lesbare Berichte relevant.

**Ergänzen:** eigener verlinkter Abschnitt „Werte darstellen“, einschließlich Format-vs-Datentyp und Barcode/QR. Nicht suggerieren, dass ein Anzeigeformat gespeicherte Werte oder Rundungsregeln ändert.

### 7. Formular-Konfiguration fehlt über das Minimalbeispiel hinaus — hoch

`references/grids.md:778` erklärt `user_input`; der Submission-Vertrag behandelt Inline-Erstellung/-Änderung. Der Konfigurationsvertrag selbst bleibt unvollständig: `form_value`, Label/Hilfetext, Required-/Default-Overrides, `inlineCreate.fields`, Vergleichsvalidierungen, Fehler-Zielfeld, Submit-/Erfolgstext, Redirect und Titelbild fehlen als auffindbare Optionen.

Quelle: `api/public-dto.ts:295–332`. Es gibt keinen `forms reference`-Befehl im aktuellen CLI-Inventar.

**Ergänzen:** vollständige öffentliche Formularreferenz und ein Beispiel „Beginn ≤ Ende“. Fest gesetzte Werte und veränderbare Defaults ausdrücklich unterscheiden.

### 8. Audit-Anforderungen kann man nicht aus der Referenz konfigurieren — mittel

Audit-Antworten und History werden erwähnt, aber nicht, wie eine Anwendung Fragen für Update, Löschen oder Wiederherstellen konfiguriert und wann ausgewählte Felder einen Änderungsgrund verlangen.

Quellen: `contracts.ts:66–178`, `UpdateTableSchema`, In-App-Hilfe „Require change context“. **Ergänzen:** `auditPolicy`-Shape, Frage-/Options-IDs, Trigger und passende Mutation mit Antworten. Audit-Verlauf und Durable History sind unterschiedliche Funktionen.

### 9. Zwei eingebettete GQL-Beispiele sind ungültig — hoch

`references/grids.md:146`: `source: from table Expenses select Description, Amount`

`references/grids.md:1119`: `source: from table Items select Name`

Direkter Parser-Aufruf bestätigte: `from table Items select Name` → `invalid from source`. Mit Semikolon oder Zeilenumbruch funktioniert die Abfrage. Quelle: `query-dsl/parser.ts:102`.

**Fix:** YAML-Blockstrings oder explizite Semikolons verwenden. Den Satz über optionale Zeilenumbrüche bei `grids.md:597` präzisieren: Klauseln brauchen grundsätzlich einen unterstützten Separator; nicht jede Leerzeichenfolge ist einer. Beispiele künftig automatisch mit dem echten Parser prüfen.

### 10. `ROUND` ist missverständlich beschrieben — mittel

`references/grids.md:702`: „ROUND truncates fractional places toward zero.“ Das kann als Abschneiden des Geldbetrags verstanden werden. Tatsächlich wird das Stellen-Argument ganzzahlig gekürzt; der Wert wird mit `ROUND_HALF_UP` gerundet (`formula/functions-math.ts:48`).

**Fix:** beide Regeln separat ausdrücken, mit einem positiven und negativen Halbwertbeispiel. Die daneben vorhandene ausführliche Dezimal-Dokumentation beibehalten.

### 11. Liquid, Dokumentnummern und Barcode-Funktionen sind nicht erschlossen — hoch

Die Dokumentreferenz verweist auf `document-templates reference`. Dieser Helfer (`cli/documents-support.ts:20`) enthält nur eine kurze Feld-/Datenliste und Beispiele. Er erschließt nicht die vollständigen erlaubten Liquid-Funktionen, `series.value`, Barcode/QR oder die vollständigen Kontextobjekte.

Diese Funktionen sind in `grids-documents-pdfs.help.md:159` und `:201` beziehungsweise `:237` beschrieben; im Skill fehlen zielgenaue Hinweise dorthin. Für Dokumentgestaltung reicht ein Renderer-Beispiel nicht.

**Ergänzen:** verlinkte Dokument-/Liquid-Referenz einschließlich Nummern-/Dateinamenskontext, Escaping, Filtern, Grenzen und Barcode-Beispiel. Record-ID-Serie und Dokumentnummernvergabe nicht vermischen.

### 12. DATEV-Dateinamenregel fehlt — mittel

Die Exportabschnitte behandeln SEPA/DATEV bereits ausführlich. Bei einem eigenen DATEV-Dateinamen fehlt aber die notwendige Form `EXTF_….csv`. `service/document-issuance.ts:915–920` vergibt sie standardmäßig und weist abweichende Namen zurück.

**Ergänzen:** direkt bei `filename`/DATEV dokumentieren; allgemeine Output-Optionen nicht als frei interpretierbar präsentieren, wenn ein Profil sie einschränkt.

### 13. Navigation und Exportfreigabe fehlen im Befehlsindex — mittel

`bases navigation get|set` und `workflow-runs preview-export|confirm-export` sind implementiert und im Fließtext vorhanden, aber im zentralen Index nicht gelistet. Quellen: `cli/navigation.ts`, `cli/workflows.ts:717/744`, `references/grids.md:1583`.

Zusätzlich fehlt „Shared base navigation“ im Inhaltsverzeichnis. Dokument-Membership steht mitten im Abschnitt „Base selection“; Runtime-App-Nutzung und Daily Capabilities unter „Command index“. **Fix:** Themenstruktur korrigieren und Index gegen tatsächliche Befehle prüfen, einschließlich dynamisch erzeugter Befehle.

## Feature-Matrix

„Vorhanden“ bedeutet auf Feature-Ebene beschrieben und ein brauchbarer Einstieg vorhanden; es ist keine Garantie, dass jede Flag-Kombination geprüft wurde. „Teilweise“ umfasst auch schlechte Auffindbarkeit.

| Bereich | Geprüfte Funktionen | Urteil |
| --- | --- | --- |
| Grundlagen | Base/Table/Record-Modell, öffentliche IDs, Namen, Default-Base, JSON-Dateien, Versionen, Zeitzone | Vorhanden |
| Bases | CRUD, Restore, Trash, Templates mit/ohne Beispieldaten | Vorhanden |
| Navigation | Get/Set, gemeinsame Gruppen, gemischte Ressourcen, Revision/Konflikt | Vorhanden, Index lückenhaft |
| Tabellen | Stored, CRUD, Direct-Insert, Reihenfolge, Darstellung | Teilweise; Darstellung fehlt |
| Felder | CRUD, Restore, Dependents, Reihenfolge, gemeinsame Attribute | Teilweise; Optionsreferenz fehlt |
| Datentypen | Alle 22 Registry-Typen | Siehe Feldmatrix |
| Records | CRUD, Versionsschutz, Import/Export, externe Upserts einzeln/Batch | Vorhanden |
| Zusammenarbeit | Kommentare, Referenced-by, Datei-Upload/Replace/Delete/Download | Vorhanden |
| History | Audit-Lesen, Durable History, Versionsdownload, Snapshots | Vorhanden; Audit-Policy-Erstellung fehlt |
| Finalisierung | Direct/Four-eyes, Request/Approve/Reject, Freeze, Disable/Policy-Befehle | Teilweise; Nummernvergabe und zusammenhängender Ablauf fehlen |
| Schreibwege | Direct/Form/Workflow, Impact, All/None | Vorhanden |
| Combined Tables | Quellen entdecken, Mapping, Draft/Validate/Publish/Revoke, Rechte, Audit | Vorhanden |
| GQL | Quellen, Joins, Projektion, Filter/Suche, Gruppen/Aggregate/Having, Sort/Paging, Parameter | Breit vorhanden; zwei Beispiele fehlerhaft |
| Formeln | Sprache, Funktionen, Dezimalarithmetik, Datumslogik, Listenreduktionen | Breit vorhanden; ROUND-Text korrigieren |
| Views | Shared/Personal, CRUD, GQL, Darstellung | Teilweise; Cards/Kalender/Spaltenformate fehlen |
| Formulare | CRUD, Tokens, Aktivierung, Submit, Inline/Create/Edit | Teilweise; Konfiguration/Validierungen fehlen |
| Custom Apps | Definition, Seiten, 11 Blocktypen, Bindings, Navigation, Verfügbarkeit, Publish/Restore | Vorhanden, mit Schema-Discovery |
| App-Runtime | Read, Records, Form/Sidebar, Record-Edit, Actions, Scanner, Runs, Files, Comments, Dokument/Bild | Vorhanden |
| Berechtigungen | Base vs App, Personen/Gruppen/Public, Discoverability, Laufzeitgrenzen | Vorhanden |
| Dokumente | Templates, Preview, Generate, Idempotenz, Artefakte, Browse, Search, Links/Revoke | Vorhanden; Liquid/Nummern-Funktionen schlecht erschlossen |
| Dokument-Herkunft | Membership, associatedData, sourceVersions, Record-Zuordnung, GQL-Metadaten | Vorhanden, unpassend einsortiert |
| Ausgabeformate | PDF, CSV, JSON, XML, SEPA, DATEV, E-Invoice v1/v2 | Vorhanden; DATEV-Dateiname ergänzen |
| Evidence | Preflight, Scope, Erstellen, Retry/Cancel, Download/Verify, Grenzen | Vorhanden |
| Retention | Floors, Aufbewahrung, Holds, Kandidatenlisten, kontrollierte Vernichtung | Vorhanden |
| Workflows | Inputs, Schedule/RecordEvent, Kontrollfluss, Fehler/Retry, Dry Run, Versionen | Vorhanden |
| Workflow-Aktionen | query, closeRecord, createCorrectionDraft, finalizeRecord, updateRecord, createRecord, atomicRecords, generateDocument, createDocumentLink, sendEmail, httpRequest | Alle 11 im Skill vertreten |
| Finanz-Review | Bestehenden Run prüfen/bestätigen, Hash, Quellen-Frische, Claims | Vorhanden; Befehlsindex ergänzen |
| Launcher | Scanner, Bulk, Record, App; feste/prompte Eingaben; Close/Correction | Vorhanden |
| E-Mail | Template CRUD, Sample Data, Workflow-Senden, Delivery-Historie | Vorhanden |
| Operations | Runs/Steps/Cancel, Kernel-Verweis, Event-Failures/Replays | Vorhanden; zusätzliche Diagnose-APIs siehe unten |
| Assistant | Built-in-Skill, Help-Verweis, Query-AI-Grenzen, Daily Capabilities | Vorhanden; nicht mit administrativer CLI verwechseln |
| Starter | Drei Base-Templates, Business-App-Szenarien, Dokument-/Workflow-Starter | Teilweise; UI-Starter nicht als eigener CLI-Katalog erschlossen |
| App-Administration | Uploadlimit, Query-Pool/Queue/Concurrency und Neustartwirkung | Kein eigener Themenpfad im Grids-Skill |

### Feldmatrix

Die allgemeine Lücke aus Finding 2 gilt auch bei „vorhanden“: Ein Beispiel ist kein vollständiges Optionsschema.

| Typen | Ergebnis |
| --- | --- |
| `text`, `longtext` | Genannt, Live-Beispiele vorhanden; gemeinsame Regeln/Defaults und Markdown-Konfiguration nicht systematisch im Skill |
| `number` | Sehr gute Rechen-/Präzisionsbeschreibung; vollständige Konfigurationsgrenzen nicht im Live-Beispiel |
| `percent`, `duration`, `date` | Genannt, Live-Beispiele vorhanden; Skala/Einheiten/Datum-vs-Zeit brauchen direkte Typeneinstiege |
| `boolean`, `json` | Genannt und über Katalog entdeckbar; JSON nicht als frei querybare Objektstruktur darstellen |
| `select`, `principal`, `relation` | Wertformen und wichtige Rechte-/ID-Grenzen vorhanden; Optionen über Discovery, nicht vollständige Skill-Tabelle |
| `object_list` | Umfangreich erklärt, aber fehlt im Typenverzeichnis |
| `id` | Kritische Inhaltslücke, Live-Text zusätzlich falsch |
| `formula`, `lookup`, `rollup` | Vorhanden; Berechnung vs eingefrorene Werte beschrieben, Typ-Konfiguration vor allem im Live-Katalog |
| `html_template` | Nutzung und Grenzen vorhanden; vollständige Liquid-Discovery und unsaved Preview nicht erschlossen |
| `created_at`, `created_by`, `updated_at`, `updated_by` | Als Systemfelder vorhanden; von generierten Business-IDs klarer trennen |
| `file` | Eigener Upload-Pfad und Runtime-Dateien beschrieben; Operator-Uploadlimit besser verlinken |

## Optionenprüfung: nicht nur Feature-Namen

Der Maßstab umfasst ausdrücklich die inneren Optionen. `--body-file` plus ein Beispiel ist keine vollständige Referenz. Die folgenden öffentlichen Vertragsflächen müssen im Skill entweder direkt erklärt oder über einen ausdrücklich genannten vollständigen Referenzeinstieg zugänglich sein.

| Vertragsfläche | Zu erschließende Optionen und Kombinationen | Aktueller Befund |
| --- | --- | --- |
| Tabelle erstellen | `name`, `kind`, `description`, `icon`, `columns`, `displayConfig` | Name/Kind und einfache Metadaten auffindbar; verschachtelte Anzeigeoptionen nicht erklärt |
| Tabelle ändern | `name`, `description`, `icon`, `columns`, `displayConfig`, `auditPolicy`, `disableDirectInsert` | Body wird unterstützt, aber kein vollständiger Tabellenoptionsvertrag im Skill; Insert-Schalter von Mutation Policy unterscheiden |
| Tabelle anzeigen | `mode: table/cards/calendar`; Cards: `imageFieldId`, `fieldIds`; Kalender: `dateFieldId`; Spalten: `fieldId`, `label`, `format` | Fehlende Optionsreferenz; Quelle `api/public-dto.ts:46` |
| Tabellenschutz | Durable-History-Baseline, Finalisierungsmodus/Approver-Gruppe, Voraussetzungen für Disable, Policy-Revision, Mutation-Quellen/Freeze-Bestätigung | Einzelne Features beschrieben, aber keine zusammenhängende Settings-Referenz mit Wechselwirkungen |
| View | `name`, `description`, `icon`, `source`, `shared`; Update zusätzlich `position`; `ui.columns`, `ui.displayConfig`, `groupedColumnOrder`, `hiddenGroupedColumns` | GQL/Sharing beschrieben; vollständige `ui`-Optionen fehlen |
| Formular | Titel/Beschreibung, `fields`-Union, `validations`, Submit-/Erfolgstext, Redirect, Titelbild; Aktivierung/Public/Position | Submit gut erklärt; Authoring-Optionen fehlen größtenteils |
| Dokumentvorlage | `name`, `description`, `source`, `renderer`, `enabled`; Update zusätzlich `position` | Einstieg vorhanden, aber kurze Runtime-Referenz listet nicht alle Ressourcenfelder |
| HTML-Renderer | `body`, `header`, `footer`, `css`, `numberTemplate`, `filenameTemplate`, erlaubte Liquid-Kontexte/Filter und Limits | Felder überwiegend genannt; Funktionen/Kontexte und Grenzen nicht umfassend erschlossen |
| Profil-Renderer | `kind`, `id`, `version`, `inputTemplate`; profilabhängiger Input und Artefakte | Renderer-Discovery und v1/v2-Beschreibung vorhanden; konkrete Profilverträge müssen beim jeweiligen Renderer bleiben |
| Custom-App-Root | `schemaVersion`, `kind`, `id`, `baseId`, `name`, `icon`, `sidebar.actions`, `startPageId`, `pages` | Vollständiges generiertes `definitionSchema` vorhanden und vom Skill ausdrücklich verlinkt |
| Custom-App-Seite/Layout | `id`, `title`, `navigation.visible/icon`, `parameters`, `record`, `availableWhen`, `rows/columns/span/blocks`; lokale IDs und Mengengrenzen | Über `definitionSchema` auffindbar; öffentliche Authoring- und kompilierte Runtime-Objekte klar getrennt |
| Custom-App-Blöcke | Alle 11 Typen, Pflichtwerte, Defaults, verschachtelte Sources/Display/Actions/Formats/Bindings, Verfügbarkeit | Gute Options-Discovery; nicht fälschlich als fehlend werten, nur weil nicht alles im Markdown kopiert ist |
| Custom-App-Kombinationen | Cards nur mit View, Tabellen-Spaltenauswahl, Record-Parameter, editable als Teilmenge, Forms/FixedValues/Auth, Navigation und Launcher-Inputs | Skill plus `validation.checks` beschreiben wesentliche Regeln; Compiler bleibt für Rechte/Querbezüge notwendig |
| GQL | Jede Klausel samt Argumenten, Quoting/Separatoren, Operatoren/Typkompatibilität, Aggregationen, Kontext/Parameter, Limits/Pagination und Reuse-Grenzen | Umfangreiche Referenz; bestätigte Separator-Beispieldefekte verhindern derzeit eine saubere Abnahme |
| Workflow | Inputs/Trigger, alle Aktionen, deren optionale Felder, Control Flow, Referenzen, Limits, Retry/Dry Run und Launchertypen | Weitgehend über Sprachreferenz plus Aktionsmetadaten erschlossen; `generateDocument`-Kurztabelle muss auch `associatedData`/`sourceVersions` direkt verlinken |
| Finanz-Output | Format, Profilversion, Mapping/Header, Bestätigung, Herkunft/Claims, Dateiname | Weitgehend vorhanden; DATEV-Dateinamenregel fehlt |

Wichtig für die Umsetzung: Tabellenoptionen nicht aus dem internen `TableSchema` ableiten, als wären alle gelesenen Eigenschaften schreibbar. Beispielsweise steht `position` am gelesenen Tabellenmodell, aber nicht im geprüften `UpdateTableSchema`. Create, Update, Read und Runtime jeweils getrennt dokumentieren. Ebenso ist ein optionales Feld nicht automatisch nullable; Defaults und Größenlimits müssen aus dem tatsächlichen Eingabevertrag stammen.

Custom Apps liefern bereits das bessere Muster: `custom-apps/reference.ts` erzeugt das Eingabeschema und ergänzt semantische Prüfregeln. Bei Tabellen, Views, Forms und Feldtypen fehlt dieser ebenso klare Zugang. Das ist der zentrale Unterschied, nicht bloß die Länge ihrer Markdown-Abschnitte.

## Weitere CLI-Zugänge

Für einige GUI-/Diagnose-Funktionen gibt es API- oder Source-Verträge, aber im geprüften Grids-Befehlsinventar keinen dedizierten Zugang:

- HTML-Template-Feld live validieren/vorschauen: `api/html-template-fields.ts`, `POST /api/grids/html-template-fields/by-table/:tableId/check`.
- Automatischen Trigger-Zustand lesen: `api/workflow-catalog-routes.ts:209`, `GET /api/grids/workflows/:workflowId/trigger-state`. `workflows get` lädt nicht zusätzlich diesen Zustand.
- Dokument-/Workflow-Starter: existieren in den Starter-Dateien; `templates list` liefert die drei Base-Templates, nicht diese anderen Starter-Kataloge.
- Grids-App-Einstellungen: `config.ts:33` und `api/admin-settings.ts`. Der Skill bietet keinen Grids-spezifischen Wegweiser zu den allgemeinen Settings-/API-Werkzeugen.

Das sind nicht automatisch fehlende Plattformfähigkeiten: allgemeine Cloud-CLI/API-Werkzeuge können einen Zugang bieten. Die gewünschte GUI-Parität braucht aber einen dokumentierten, reproduzierbaren Weg. Keine erfundenen neuen Befehle in die Doku schreiben; vorhandenen öffentlichen API-Weg dokumentieren oder einen kleinen CLI-Befehl ergänzen.

## Umsetzungsstand

Die Referenz wurde anhand dieser Bestandsaufnahme erweitert:

- Direkt verlinkte Fachreferenzen für Schema/Records und Dokumente/Exporte;
  vollständige Tabellen-, Feld-, Format-, View- und Formoptionen, alle 22
  Feldtypen und sieben ID-Strategien samt Vergabezeitpunkt.
- Bestehende GQL-, App- und Workflowreferenz bleibt erhalten und ist über eine
  Aufgabenmatrix mit den jeweiligen vollständigen Live-Schemas erschlossen.
- Feldkatalog liefert öffentliche `configSchema`-Werte aus den tatsächlichen
  Verträgen; Templatekatalog liefert Create/Update-Schemas; installierte
  Renderer liefern `inputSchema`. Keine zweite manuell gepflegte Schemakopie.
- GQL-Beispiele, ROUND-Erklärung, fehlende Befehle und Liquid-Logo-Pfad
  korrigiert; API-only-/Operator-Zugänge und Grenzen ausdrücklich dokumentiert.
- Referenzbasierte Szenarioprüfung für Rechnungen mit Objektlisten,
  Erstattungsformulare und SEPA/DATEV/PDF; Hinweise auf feste aktuelle Nutzer,
  fehlende Kalenderoptionen und unabhängige Teilerfolge ergänzt.
- Verifikation: 163 Tests erfolgreich; Grids-Typecheck, gezielter Biome-Check,
  Skill-Check und Diff-Whitespace sauber. Tests gleichen alle 219 Befehle und
  alle Feldtypen mit der Referenz ab und prüfen GQL-/Templatebeispiele.
  Harper geprüft; verbleibende Hinweise betreffen überwiegend Fachsprache und
  bestehende Stilkonventionen, kein behaupteter fehlerfreier Harper-Lauf.

Keine Live-Base verändert, kein Dienst neu gestartet, nichts committet.
Die serverseitige Renderer-Discovery wird nach dem nächsten regulären
Grids-Neustart verfügbar; der lokal verlinkte CLI-Skill ist bereits aktuell.

## Empfohlene Umsetzung

1. **Fehler zuerst:** ID-Live-Katalog, fehlende ID-Anleitung, beide GQL-Beispiele, ROUND-Text, DATEV-Dateiname.
2. **Vollständige Discovery:** gemeinsame Feldoptionen plus Typ-Schemas, Formular- und View-Konfiguration; bestehende öffentliche Verträge wiederverwenden.
3. **Findbarkeit:** kurze Grids-Einstiegsreferenz und direkt verlinkte Fachseiten für Schema/Records, GQL/Formeln, Views/Forms, Apps, Documents/Exports und Workflows. Bestehenden Business-App-Leitfaden behalten und gezielt verlinken.
4. **Fehlende Themenpfade:** Formvalidierung, Audit-Policy, Anzeigeformate, Liquid/Barcode/Nummern, Starter und Betriebseinstellungen.
5. **Kleine Drift-Checks:** Registry-Typen und tatsächliche CLI-Befehle gegen Index; GQL-Beispiele durch Parser; Konfigurationsbeispiele gegen öffentliche Schemas. Semantik und Auffindbarkeit weiterhin redaktionell prüfen.

Abnahmekriterium: Ein Agent kann für jedes Feature erkennen, dass es existiert, den passenden öffentlichen Vertrag finden und ein gültiges Minimalbeispiel erstellen, ohne im Repository nach einer undokumentierten Option suchen zu müssen. Nicht jede Hilfe muss im Skill kopiert werden; jeder notwendige Weg muss jedoch ausdrücklich auffindbar sein.
