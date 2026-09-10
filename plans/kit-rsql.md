# Kit: gemeinsame Datenbanken, Datenimport und Administration

Stand: 10. September 2026. Umsetzung abgeschlossen und lokal verifiziert. Automatisches Batch-Replay und dauerhafte Import-Wiederaufnahme wurden ausdrücklich ins Backlog verschoben; unklare Schreibausgänge werden nicht wiederholt.

## Ziel und Entscheidungen

Kit bekommt optional eine gemeinsame SQLite-Datenbank über rsql. Pro Custom-App gibt es genau eine aktive Datenbank; sämtliche Einstiegspunkte und berechtigten Nutzer teilen sie. Das Script verwendet `kit.db`, ohne Namespace, Serveradresse oder Credentials zu kennen. OPFS und KV bleiben lokal und unverändert. Lokales sql.js, Offline-Synchronisation, mehrere Datenbanken pro App und zusätzliche Zeilenberechtigungen gehören nicht in diesen Slice.

rsql ist global standardmäßig deaktiviert. Kleine Installationen brauchen keinen rsql-Dienst. Der lokale Entwicklungsstack bekommt hingegen einen rsql-Container als Bestandteil von `dev:infra`. Die bloße Verfügbarkeit des Containers aktiviert das Produktfeature nicht.

Der Plan umfasst Cloud-/Kit-Code, öffentliche UI-Erweiterungen, CLI, Capabilities, Hilfe und lokale Docker-Konfiguration. Ein eventuell nötiger rsql-Idempotenz-Vertrag ist eine separate Änderung im rsql-Projekt mit eigener Veröffentlichung. Kein Produktions-Rollout, Commit oder Release ist durch diesen Plan ausgeführt.

## Verifizierter Ausgangspunkt

- npm liefert `@k2b/rsql@1.0.0`; das Docker-Manifest von `ghcr.io/k2b-dev/rsql:1.0.0` enthält amd64 und arm64.
- rsql besitzt genau eine SQLite-Datei pro Namespace, Schema-/Row-APIs, lesende SQL-Abfragen, Namespace-Provisionierung, Löschung, Export und Übersicht.
- Der aktuelle Client bietet Bulk-Inserts, aber keinen Idempotency-Key. Der SQL-Endpunkt ist ausdrücklich keine Sandbox für feindliches SQL.
- `/overview` liefert unter anderem Tabellen, Views, Indizes, Speicher und Health. Die Tabellenliste ergänzt `row_count`; Views haben keine zu addierende Datensatzanzahl.
- Homepage verwendet sql.js/Comlink mit Speicher- oder OPFS-Datenbanken. Sein Import-Helper leitet Typen aus den ersten 100 Zeilen ab und schreibt 1.000er-Batches. Das dient als API-Inspiration, nicht als zu kopierende Persistenzimplementierung.
- Ausgangszustand: UI-Toasts unterstützten `update`, aber keine Progressbar; Aktionen waren Links. Der neue Vertrag ergänzt Fortschritt und Callback-Aktionen.
- Notebooks hat das passende AdminLayout mit Kennzahlen, Suche, paginierter Tabelle, Freigaben-Dialog und zentralem Settings-Modal.
- Cloud-Settings unterstützen app-eigene Definitionen, Secrets und verschlüsselte Speicherung. Der Kit-Worker bleibt ohne Netzwerk und Credentials; Operationen laufen über die bestehende Host-Bridge.

Quellen im Checkout: `packages/ui/src/feedback/toast.ts`, `packages/notebooks/src/frontend/admin.tsx`, `packages/kit/src/runtime/host.ts`, `packages/kit/src/runtime/sandbox.ts`; Nachbarprojekte `~/Git/homepage/src/features/kit/kit-db` und `~/Git/rsql/client/src`. Die Implementierung prüft die tatsächlich installierten 1.0.0-Typen erneut.

## Einstellungen und Zustände

Globale, Kit-eigene Cloud-Settings:

- `kit.rsql_enabled`: false als Produktdefault.
- `kit.rsql_url`: interne HTTP(S)-Basisadresse; nur Cloud-Admins verwalten sie.
- `kit.rsql_api_token`: Secret, niemals in normalen Settings-Antworten oder Logs. UI zeigt nur, ob es gesetzt ist; Ersetzen und explizites Entfernen sind getrennt.

Das Modal prüft URL und Authentifizierung serverseitig ohne Namespace anzulegen. `/healthz` allein beweist keine gültigen Credentials. Redirects werden nicht mit dem Token verfolgt. Aktivieren erfordert eine verwendbare Konfiguration; Fehler ersetzen keine funktionierende Konfiguration unbemerkt. Serverwechsel ist in V1 gesperrt, solange aktive Datenbanken oder ausstehende Bereinigungen existieren. Token-Rotation am gleichen Server bleibt möglich. Entfernen benötigter Verbindungsdaten ist ebenfalls gesperrt; globales Deaktivieren bleibt immer möglich.

| Aktion | Ergebnis |
| --- | --- |
| Global deaktivieren | Neue Datenzugriffe, Aktivierungen und Importe gesperrt; Daten und App-Einstellung bleiben erhalten. |
| Pro App deaktivieren | Neue Zugriffe gesperrt; DB bleibt byte-semantisch unverändert durch diese Aktion. |
| Wieder aktivieren | Bestehende DB weiterverwenden; nur bei erstmaliger Aktivierung provisionieren. |
| Zurücksetzen | Nach ausdrücklicher Bestätigung eine leere DB bereitstellen, alte DB zuverlässig bereinigen. |
| App löschen | App unzugänglich machen und zugehörige DB zuverlässig löschen. |

Bereits bestätigte Schreiboperationen werden beim Abschalten nicht rückgängig gemacht. Laufende Requests werden bestmöglich abgebrochen; ihr Ausgang kann schon feststehen. Die nächste Operation prüft den aktuellen Zustand serverseitig erneut. Keine Behauptung, dass Worker-Stop einen bereits bestätigten Server-Write rückgängig macht.

Die App-Checkbox ist bei global deaktiviertem Feature gesperrt. Hinweis: „Gemeinsame Datenbanken sind für diese Cloud-Instanz deaktiviert. Ein Cloud-Administrator muss die Funktion zuerst aktivieren.“ Ein vorhandener App-Wunsch bleibt sichtbar. Nicht provisioniert, deaktiviert, global gesperrt, Provisionierung, bereit, Reset und Fehler sind unterscheidbare UI-Zustände.

## Eigentum, Zugriff und Persistenzmodell

Kit besitzt Provisionierung, Zugriff und Lifecycle; rsql bleibt privater Speicher. Kein generischer URL-Proxy und kein vom Script gewählter Namespace. Der Server ermittelt die Datenbank ausschließlich über die autorisierte Custom-App.

| Akteur | Erlaubt |
| --- | --- |
| Nur Metadatenzugriff | Keine Datenbankinhalte. |
| App Use/Write | Lesen, Einfügen, Ändern und Löschen von Datensätzen. |
| App Admin | Zusätzlich Schema, Aktivierung, Export und Reset. |
| Globaler Cloud-Admin | Globale Konfiguration, alle Apps/Freigaben, Wiederherstellung verwaister Freigaben und Löschen. |

Alle App-Nutzer mit Use teilen denselben Datenbestand. Es gibt keine automatische Isolation nach Benutzer oder Tabellenzeile. Die UI erklärt das vor Aktivierung. Schema-Anlage durch einen Import benötigt Admin; übliche Nutzerimporte schreiben in vorher eingerichtete Tabellen.

Vorgesehen ist eine Kit-eigene Zuordnungstabelle `kit.project_databases` mit eindeutigem project_id, enabled, namespace, generation und Lifecycle-Zustand sowie Zeitstempeln und stabilem Fehlercode. Keine Credentials pro App. Interne Namespace-Namen werden aus der App-Identität und Generation abgeleitet; öffentliche APIs verwenden weiterhin die sechsstellige App-ID. Die Namespace-Syntax wird gegen rsql validiert. Keine Feldvermehrung ohne tatsächliche Nutzung.

Zusätzlich braucht Kit dauerhafte Lifecycle-Aufträge für Provisionierung, Reset und Löschung. Domain-Zustand und Auftrag entstehen in derselben Postgres-Transaktion. Ein begrenzter Wartungslauf verarbeitet persistierte Aufträge mit einer transaktionsgebundenen Postgres-Sperre; eine Wiederaufnahme findet persistierte offene Aufträge auch nach einem Prozessabsturz. Löschaufträge überleben das Entfernen der App-Zeile. Ein nicht vorhandener Namespace gilt bei Löschung als erfolgreich bereinigt. Logs enthalten IDs und Fehlercodes, keine Datensätze oder Secrets.

Reset verwendet eine neue Generation: Zugriffe sperren, leeren Namespace erzeugen, autorisierte Zuordnung atomar umschalten, alte Generation bereinigen. Nur eine Generation ist für Scripts aktiv. Requests/Imports mit veralteter Generation werden abgewiesen. Lifecycle und Request-Admission müssen auch über mehrere Kit-Prozesse koordiniert sein; ein Mutex im Prozess allein genügt nicht. Bereits zugelassene Operationen dürfen niemals auf die neue Generation umgebogen werden. Ein deaktivierter Zustand bleibt nach Reset deaktiviert. Global abgeschaltetes rsql blockiert normale Reset-Nutzung, nicht die interne Löschbereinigung.

## Script-API und Transport

Öffentliche Vorschläge, final an den installierten Client-Typen ausrichten:

```js
await kit.db.tables.list();
await kit.db.tables.create({ name: 'belege', columns: [/* rsql schema */] });
const rows = kit.db.table('belege').rows;
await rows.list({ limit: 50 });
await rows.insert({ nummer: 'R-1001', betrag: 12500 });
await rows.update(id, { status: 'geprüft' });
await rows.delete(id);
await kit.db.query('SELECT SUM(betrag) AS total FROM belege WHERE status = ?', ['offen']);
await kit.db.importData('belege', data, { createTable: false });
```

Row- und Schema-Formate orientieren sich an rsql. Keine erfundene Schreib-SQL- oder Transaktions-API. Kit normalisiert Result-Fehler zu stabilen Codes und verständlichen Meldungen. Parameterisierte Werte, validierte Bezeichner, begrenzte Payloads/Resultate, Timeout und Cancellation gelten an jedem Transportübergang. Limits aus Kit- und rsql-Vertrag beziehungsweise dokumentiertem Betriebsbudget ableiten; keine willkürlichen Batchgrößen.

`@k2b/rsql@1.0.0` wird exakt in `packages/kit` eingebunden, serverseitig. Worker → Host-RPC → typisierte Kit-API → permission-geprüfter Service → gebundener rsql-Client. Generation und aktuelle Berechtigung werden geprüft; Session/Token gelangen nie in den Worker. Keine allgemeinen Namespace-Admin-Methoden in `kit.db`.

Freies lesendes SQL ist ein Abnahme-Gate: Isolation gegenüber internen Objekten, virtuelle Tabellen/Funktionen, Escape-Versuche und teure Queries werden adversarial geprüft. Bei fehlender ausreichender rsql-Garantie bleibt dieser Teil blockiert; Row-APIs können unabhängig ausgeliefert werden. Die vorhandene Keyword-Prüfung wird nicht als ausreichender Nachweis dargestellt.

## importData und Retry-Vertrag

V1 importiert JS-Datensätze im Append-Modus. CSV/PDF lesen bleibt bei den bestehenden Helpers; dadurch ist Import unabhängig vom Dateiformat.

- Gesamte begrenzte Eingabe vorprüfen. Leere Eingabe ist ein erfolgreicher No-op.
- Bei neuer Tabelle Typen konservativ aus allen importierten Werten ableiten oder explizite Spalten akzeptieren. Numerische Strings, IDs und führende Nullen bleiben Text. Heterogene Werte, fehlende Felder, reservierte Namen, Nullwerte und ungültige Zahlen erhalten definierte Regeln und klare Fehler.
- Bei vorhandener Tabelle Schema lesen und prüfen; keine stille Schemaänderung. Verwaltete rsql-Spalten nicht überschreiben.
- Batches nach kodierter Bytegröße und Backend-Limits begrenzen; zunächst sequenziell. Keine unbeschränkte Parallelität.
- Fortschritt zählt nur bestätigte Datensätze. UI zeigt Validierung, Schreiben, Wiederholung, Abschluss, Teilabschluss oder unklaren Ausgang.
- Vorübergehende Fehler nur begrenzt mit Backoff/Jitter und im Abbruchbudget wiederholen. Schema-, Berechtigungs-, Quota- und Validierungsfehler nicht wiederholen.
- Ein Batch-Insert muss atomar sein; dies wird im tatsächlichen Serververtrag getestet.
- Sichere Wiederholung braucht Import-ID + Batch-ID + Payload-Prüfung und atomare Speicherung des Ergebnisses zusammen mit den Zeilen. rsql 1.0.0 bietet dafür aktuell keinen bestätigten Vertrag. Eine separate Postgres-Markierung beseitigt das Commit/Antwort-Verlust-Fenster nicht.
- Vor Umsetzung festlegen: minimaler rsql-Idempotenz-Vertrag samt Veröffentlichung oder ausdrücklich kein automatischer Retry bei unklarem Write. Dieser Retry-Slice ist auf Wunsch des Maintainers ins Backlog verschoben. Der aktuelle Import meldet unklare Schreibausgänge ohne Replay.
- Abbruch stoppt weitere Batches. Bestätigte Batches bleiben; laufender Batch wird geklärt statt als sicher verworfen behauptet. Teilfortschritt und Import-ID erlauben sichere Fortsetzung desselben Imports, sobald Idempotenz verfügbar ist.
- Ein absichtlich neu gestarteter Append-Import darf erneut Daten einfügen. Retry-Deduplizierung ist keine fachliche Duplikaterkennung. Upsert, Replace und atomarer Gesamtimport sind spätere Features.

Optional `onProgress` und `notify: false`; Standard ist ein einziger aktualisierter Host-Toast. Ergebnis enthält confirmedRows, totalRows und Status. Import-IDs gehören zum späteren Replay-Vertrag. Vollständige Wiederaufnahme nach Seiten-Reload ist nicht stillschweigend garantiert: derselbe Eingabeinhalt muss erneut bereitgestellt und geprüft werden. Keine generische Langzeit-Jobplattform für Dateiinhalte in diesem Slice.

## UI und Diagnose

Öffentliche ToastOptions ergänzen `progress: number | 'indeterminate' | null` (0–1) und eine Callback-Aktion neben bestehenden Link-Aktionen. `update` verändert denselben Toast. Laufende Operationen bleiben sichtbar, normale Toasts behalten ihre bisherigen Defaults. Klick auf den Inhalt eines Fortschritts-Toasts beendet ihn nicht versehentlich. Schließen blendet aus; Abbrechen löst ausdrücklich die Operation aus. Native Progress-Semantik, zugänglicher Name, begrenzte Screenreader-Updates, Dark Mode und reduzierte Bewegung gehören zum Vertrag.

App-Settings: feste Modalhöhe, ruhige Typografie, Aktivierungs-Card, danach kompakte StatCells für Tabellen, Datensätze und Speicher/Limit. Tabellenliste mit Namen und Zeilenzahlen, manuelles Aktualisieren und Zeitpunkt der letzten erfolgreichen Abfrage. `overview` und Tabellenliste nutzen; Counts können zeitlich leicht auseinanderliegen und sind Diagnose, kein transaktionaler Bericht. Views nicht doppelt zählen. Keine häufigen COUNT-Abfragen im Hintergrund. Fehler oder nicht verfügbare Werte sind kein Nullbestand. Bei globaler Sperre keine neuen Diagnosezugriffe; Status/Hinweis weiter anzeigen, alte Werte gegebenenfalls ausdrücklich veraltet markieren.

Export und „Datenbank zurücksetzen“ stehen als getrennte Aktionen bereit. Reset-Dialog benennt App sowie Verlust aller Tabellen und Datensätze. Export ist gestreamt; kein kompletter DB-Blob durch den begrenzten Worker-RPC. Ein direkter autorisierter Download aus dem Settings-Modal genügt.

`/admin/kit` folgt Notebooks: AdminLayout, Gesamtzahl/Verwaist/DB-aktiv-Kennzahlen aus Kit-Metadaten, Suche, Pagination, DataTable und Freigaben-Dialog. Keine rsql-Übersicht für jede App pro Seitenaufruf. Verwaiste Apps und Apps ohne handlungsfähigen Admin sind sichtbar; globale Admins können Freigaben reparieren. Ein App-Löschdialog benennt den DB-Verlust. Bei Backendausfall bleibt Bereinigung sichtbar ausstehend; nicht als vollständig gelöscht melden.

## CLI, Capabilities und Hilfe

Alle GUI-Verwaltungsaktionen erhalten CLI-Parität: globale Settings einschließlich sicherer Secret-Eingabe und Verbindungstest; globale App-Liste/Freigaben/Löschen; App-DB-Status/Aktivieren/Deaktivieren/Reset/Export; Schema, Rows, Query und Import. Schreibende CLI-Operationen haben eindeutige Ziele und dieselben Service-Prüfungen. Kein Secret in Argumenten oder JSON-Ausgaben; keine neuen pauschalen Adminrechte für Agents.

Assistant-Capabilities bieten benötigte DB- und Schemaoperationen mit derselben Autorisierung und normalem Approval-Vertrag. Globale Konfiguration bleibt zuerst CLI/GUI; nicht jede Betriebsoperation muss als Assistant-Tool veröffentlicht werden. Das frühere Prinzip bleibt: Nutzer verwaltet App/Freigaben, KI programmiert Code und nötiges Schema. SDK-Wissen steht in kanonischer In-App-Hilfe und `kit sdk`, der Skill verweist darauf. Explizite Datenbank-Aktivierung wird nicht durch Code-Upload ausgelöst.

EN/DE für alle Kit-eigenen Texte, Fehlermeldungen, Dialogtitel, Toasts und Help. Nutzer-Scripts bekommen weiterhin keine eigene i18n-Abstraktion. Dokumentieren: Serverdaten statt nur lokaler Verarbeitung, gemeinsame Sichtbarkeit, Teilimporte, Stop-Grenzen, Reset/Löschung, globale Sperre und Diagnosegenauigkeit.

## Lokaler Docker-Stack

Infrastrukturservice `rsql` in `compose.yml`, Image `ghcr.io/k2b-dev/rsql:1.0.0`, internes Ziel `http://rsql:8080`, persistentes Named Volume unter `/data`, Healthcheck über `/healthz`. Kein Host-Port notwendig; Loopback-Port nur bei explizitem Debug-Bedarf. Keine Credentials im Image oder Browserbundle. Lokales Token aus der bestehenden lokalen Env-/Bootstrap-Konvention, kein produktionsgeeigneter Default im Repository.

`dev:infra` startet den Container wie die anderen Infrastrukturservices; `dev:down` erhält Dienst/Volume, `dev:infra:down` stoppt Infrastruktur ohne Volume-Löschung. Dev-Konfiguration versorgt Kit und rsql mit zusammenpassenden Werten, das globale Feature bleibt zunächst aus. Kit muss ohne erreichbaren rsql starten und seine lokalen Apps betreiben können. Keine harte rsql-Health-Abhängigkeit für Kit-Startup. Help/README/Env-Beispiele anpassen; Produktions-Compose erhält höchstens dokumentiertes Opt-in, keine Pflichtabhängigkeit oder Deployment in dieser Aufgabe.

## Reihenfolge und Abnahme

1. **Vertrags-Gates:** veröffentlichte Clienttypen, Batch-Atomarität, Idempotenz, Query-Isolation, Abbruch und Limits prüfen. Fehlende rsql-Verträge separat spezifizieren; Release erst nach eigener Freigabe.
2. **Lokale Infrastruktur und Settings:** Container, Persistenz, Auth-Test, globales Aus, Secret-Redaktion. Abnahme: Stack gesund, Restart behält Daten, Kit ohne rsql funktionsfähig.
3. **Lifecycle und Services:** Zuordnung, Provisionierung, Sperren, Generation, Reset, persistente Löschaufträge. Abnahme: paralleles Aktivieren erzeugt eine aktive DB; Ausfall/Restart verliert keine Bereinigung.
4. **Kit-API, CLI und Capabilities:** Schemas/Rows zuerst, SQL erst nach Gate. Abnahme: Admin/Use/Denied-Matrix; keine Namespace-Auswahl oder Credential-Leaks; zwei Nutzer derselben App teilen Daten, andere Apps bleiben isoliert.
5. **Admin- und App-Settings-UI:** Freigaben-Recovery, Checkbox-Hinweise, Diagnose und Bestätigungen. Abnahme: EN/DE, Tastatur, feste Höhe, Fehler-/Loading-/Disabled-Zustände; globales Off bleibt bedienbar.
6. **Import und Progress-Toasts:** öffentlicher UI-Vertrag, gebundene Batches, kein Replay unklarer Writes. Abnahme: Antwortverlust nach Commit erzeugt keine Duplikate, Abbruch meldet Teilstand korrekt, erneuter bewusster Import bleibt von Retry unterscheidbar.
7. **Gesamtprüfung und Dokumentation:** Browser-Test mit zwei Nutzern/zwei Apps; CLI-Weg zum gleichen Ergebnis; Help/SDK/Skills konsistent. Änderungen nach Zuständigkeit reviewen, rohe Kit/UI-Typechecks, fokussierte Tests, Dependency-Check und Compose-Validierung. Keine fremden Checkout-Änderungen übernehmen.

Erster nutzbarer Zwischenstand nach Schritt 5: kleine Multiuser-App mit gemeinsamem Schema, CRUD und Diagnose, ohne selbstgeschriebene Transportlogik. Der vollständige angefragte Slice endet erst mit Schritt 7 einschließlich begrenztem Import ohne Replay unklarer Writes.

Offene Entscheidungen sind technische Vertrags-Gates, keine versteckten Defaults: Idempotenz in rsql, belastbare freie SQL-Isolation sowie abgeleitete Betriebs-/Payload-Limits. Keine Implementierung auf einer bestätigten Isolations- oder Datenverlustlücke aufbauen.


## Verifizierter Implementierungsstand

- rsql 1.0.0 läuft im lokalen Docker-Stack mit persistentem Volume und privatem Token; das Produktfeature bleibt standardmäßig aus.
- Kit verwendet Postgres-Zuordnungen, Generationen und transaktionsgebundene Sperren. Ein begrenzter Wartungslauf übernimmt persistierte Provisionierungen und Löschungen; kein zusätzlicher Queue-Dienst nur für diesen Lifecycle.
- Admin-Oberfläche, App-Settings/Diagnose, Worker-Bridge, CRUD/Schema/SELECT, CLI und Capabilities sind implementiert. Die SELECT-Schnittstelle ist ausdrücklich eingeschränkt, kein freier SQL-Proxy.
- Sieben echte Postgres-/rsql-Integrationstests prüfen Zugriff, Isolation, gemeinsame Daten, Schema/Import, atomare Batch-Fehler, Ausfall-Wiederaufnahme, Deaktivieren, Reset und Löschbereinigung. Kit-Tests, Toast-Verhalten, Typecheck und Dependency-Check sind grün.
- Eine isolierte lokale Test-App importierte 1.002 Zeilen aus dem Worker. CLI-Import, Diagnose, SQLite-Export und Reset wurden zusätzlich geprüft; Admin-Verbindungstest und Fortschritts-Toast im Browser beobachtet.
- Automatisches Batch-Replay und dauerhafte Wiederaufnahme bleiben im Backlog. README, Help und Skills empfehlen sequenzielle Verarbeitung und vermeiden unnötige Concurrency-Architektur für Einpersonen-Apps.
