# Review: Assistant Code Mode

Stand: Checkout mit Commit `db15ab96c` (12.09.2026). Statisches Review ohne Ausführung, Tests, Builds oder Browserprüfung.

## 1. Gesamtbewertung

**TL;DR:** Der Code Mode ist als Sandbox-, Berechtigungs- und Persistenzmodell solide und konsistenter als sein Vorgänger Kit. Sandbox (opaker iframe, CSP ohne Netz, terminierbarer Worker), serverseitige Ausführungs-Claims, Capability-Approvals mit Review-Vergleich und die Trennung von Test- und Nutzerlauf sind gut durchdacht. Für den ursprünglichen Anwendungsfall (Rechnungen lokal aus PDFs lesen und Bankbuchungen zuordnen) ist der Code Mode in seiner heutigen Form aber **nicht ausreichend**: es gibt keinen PDF-Parser im Worker, Dateiauswahlen sind auf 64 Dateien und 16 MiB begrenzt, und jede Interaktion, die länger als 15 Sekunden dauert, beendet den Lauf. Diese drei Grenzen sind Plattformentscheidungen, keine Anwendungslogik.

Die wichtigsten Erkenntnisse:

1. **PDF.js fehlt und ist auch nicht nachrüstbar.** Der Worker hat keinen Netzzugriff, `import` löst nur relative Quelldateien auf, und der Skill verbietet ausdrücklich einen eigenen PDF-Parser. Der empfohlene Weg über `read_file` lädt die PDFs auf den Server und widerspricht der Lokalitätsanforderung.
2. **Lange Arbeit im Browser wird abgebrochen.** Jede Button-Interaktion muss innerhalb von 15 Sekunden abgeschlossen sein, sonst stoppt der Host den gesamten Lauf. Während eines laufenden Handlers sind alle Controls gesperrt, ein Abbrechen-Button ist so nicht möglich. Das ist nirgends dokumentiert.
3. **Der Agent kann Datei-Apps nicht testen.** Testläufe von GUI-Apps dürfen keine Chat-Dateien erhalten, und der Test-Picker liefert genau diese Eingaben. Eine App, deren Kern das Einlesen von Dateien ist, ist für den Agenten damit nicht end-to-end prüfbar.
4. **Skill und Implementierung widersprechen sich bei `capabilities.run`.** Der Skill verspricht das Ergebnis-Envelope (`result.data`), der Host liefert bereits `data`. Der Agent schreibt damit im ersten Anlauf falschen Code.
5. **Quelltext-Historie wächst unbegrenzt.** Jeder `code_write` speichert das komplette Bundle als neue Revision, nichts wird bereinigt. Bei Erreichen des Budgets sind Schreiben, Metadaten und Restore dauerhaft blockiert.

Gute vorhandene Lösungen, die ausdrücklich genannt werden sollen: `money` mit ganzzahligen Minor Units und lokalisierter Parse-Funktion, `sheet.toCsv` mit Semikolon, BOM, CRLF und Formel-Escaping als Default, das Claim-Modell gegen Doppelausführung, die Approval-Konsistenzprüfung (`review` wird bei Freigabe erneut berechnet und verglichen), und die klare Trennung "Test-Lauf hat temporären Speicher, geteilte Effekte sind echt".

## 2. Untersuchter Umfang und Grenzen

Gelesen wurden:

- Skill: `packages/assistant/skills/code-mode/SKILL.md` und alle Referenzen; generierter Snapshot `packages/cloud/src/ai/code-mode-skill.ts`.
- Runtime im Browser: `packages/assistant/src/artifacts/runtime/*` (worker, host, session, sandbox, compile, protocol, storage, shared-storage, capabilities, modal-*), `agent-runtime.ts`, `ArtifactPanel.tsx`, `RuntimeView.tsx`, `Workspace.tsx`, `CapabilityApproval.tsx`, `Apps.island.tsx`, `apps-page.tsx`, `modal-host.ts`.
- Server: `service.ts`, `api.ts`, `code-tools.ts`, `code-tool-routes.ts`, `client-calls.ts`, `capability-runtime.ts`, `database.ts`, `database-sql.ts`, `database-contracts.ts`, `storage-contracts.ts`, `admin.ts`, `migrate.ts`, `messages.ts`, `contracts.ts`, `source.ts`, `chat-context.ts`, `index.ts`.
- Plattform: `packages/cloud/src/ai/code-source-contracts.ts`, `code-source-tools.ts`, `browser-code-contracts.ts`, `default-tools.ts`, relevante Teile von `capabilities.ts`, `executor.ts`, `skill-tool.ts`, `skill-seeds.ts`, `file-tools.ts`, `services/document-extraction.ts`.
- CLI: `cli/code.ts`, `cli/code-host.ts`, `cli/stream.ts`, relevante Teile von `cli/turn.ts`, `cli/interactive.ts`, `cli/chat.ts`.
- Tests als Quelltext: `service.integration.test.ts`, `code-host.test.ts`, `skill.test.ts`, `browser-harness.ts`, Titel der Browser-Tests.
- Dokumentation: `docs-site/apps-content/en/assistant.md`, `docs-site/docs/en/ai/chat-interface.md`, `/en/docs/ai/tools-and-approvals` (über MCP), `skills/cloud-cli/references/assistant.md`.

Nicht bewertet: `chart-schema.ts` im Detail, `@k2b/ui`-Komponenten hinter `RuntimeView` (außer `TextInput`), die generische AI-Turn-Engine (`executor.ts`, `controller.ts`) jenseits der Code-Mode-Anbindung, rsql selbst.

Grenzen der statischen Prüfung:

- Ob `File.webkitRelativePath` die zwei `postMessage`-Hops (Parent → iframe → Worker) überlebt, ist ohne Browserlauf nicht belegbar. Ohne diesen Pfad kennt ein Ordner-Import keine Unterordner.
- Ob PDF.js überhaupt in einem Worker mit dieser CSP (kein `wasm`, kein zweiter Worker, `default-src 'none'`) lauffähig wäre, ist nicht geprüft; es ist ohnehin nicht ladbar.
- Repräsentative Sparkassen-, DHL- und FedEx-PDFs lagen nicht vor. Aussagen zur Extraktionsqualität sind deshalb offene Validierungsfragen, keine Befunde.
- Laufzeitverhalten (Speicherverbrauch bei vielen `File`-Objekten, Render-Kosten großer Tabellen) ist aus dem Code abgeleitet, nicht gemessen.

## 3. Priorisierte Findings

Einordnung: **Fehler** = belegter Defekt oder Widerspruch. **Risiko** = begründete, aber nicht durch Reproduktion belegte Auswirkung. **Produkt** = bewusste Entscheidung, die den Zielen im Weg steht.

### F1 (hoch, Produkt/Lücke): Kein PDF-Zugriff im Worker; empfohlener Weg verletzt die Lokalität

- **Code:** `packages/assistant/src/artifacts/runtime/sandbox.ts:6` (CSP `connect-src 'none'`, `script-src 'nonce' blob:`), `runtime/compile.ts:4-5,51-52` (nur relative `.js`/`.ts`-Importe), `skills/code-mode/references/runtime.md:49-56` (PDFs über `read_file`, "do not ... add an unsupported PDF parser"), `packages/cloud/src/ai/file-tools.ts:228-260` mit `services/document-extraction.ts` (serverseitige Extraktion via anydoc).
- **Auslöser:** Anforderung 2 und 3 des Anwendungsfalls. Der Agent müsste PDF.js (≥ 1 MiB minifiziert plus Worker-Teil) als Quelldatei einbetten; `contracts.ts:5-6` begrenzt Dateien auf 1 MiB und Bundles auf 2 MiB, und der Text müsste vollständig durch `code_write` aus dem Modell kommen. Praktisch ausgeschlossen. Der dokumentierte Ersatzweg (`read_file`, `write_file`, `inputPaths`) lädt jede PDF als Chat-Datei auf den Server.
- **Auswirkung:** Anforderung 3 ist nicht erfüllbar, Anforderung 2 nur unter Verzicht auf die Lokalität. Ein Ordner mit vielen PDFs ist über den Chat-Umweg außerdem unpraktikabel (manuelle Uploads, Extraktion pro Datei mit Kontextverbrauch).
- **Vorschlag:** Vom Host bereitgestellte, geprüfte Bibliotheken als auflösbare Importe (`import * as pdf from "pdfjs"`), die `compileArtifact` aus einem festen Whitelist-Bundle bedient und die nicht ins 2-MiB-Budget zählen. Alternativ ein kleinerer Host-Namespace `pdf.extractText(file)` mit Seiten- und Positionsinformationen, der im Worker läuft. Trade-off: Whitelist-Importe sind allgemeiner (Excel, Zip, XML), erfordern aber Versionspflege; ein Namespace ist enger, dafür sofort im Skill dokumentierbar.

### F2 (hoch, Fehler/Produkt): Interaktionen sind auf 15 Sekunden begrenzt und sperren alle Controls

- **Code:** `runtime/host.ts:121` (`timeoutMs = 15000`), `host.ts:126-130` (`expire` beendet den Lauf), `host.ts:131` (Timer pausiert nur bei Modal), `runtime/worker.ts:336` (Event wird abgewiesen, wenn `busy`), `worker.ts:350-361` (`busy` bis zum Ende eines awaiteten Handlers), `RuntimeView.tsx:49` (alle Controls `disabled` bei `busy`), `ArtifactPanel.tsx:98-100` (Nutzerlauf nutzt denselben `session.event`).
- **Auslöser:** Nutzer klickt "Abgleichen", der Handler verarbeitet 300 PDFs und `await`et die Arbeit. Nach 15 Sekunden: "Interaction timed out; the run was stopped", die App ist weg. Während der Verarbeitung ist kein Control bedienbar, also auch kein Abbrechen-Button.
- **Auswirkung:** Anforderung 10 (Fortschritt, Abbrechen, nicht blockierende Oberfläche) ist mit dem dokumentierten Muster nicht erfüllbar. Der Skill empfiehlt sogar das Gegenteil: `ui.md:105-106` "Await asynchronous actions and clear loading in finally".
- **Hintergrund:** Der Worker sendet `settled` nach `await result`. Gibt der Handler synchron zurück und startet die Arbeit ungeawaitet, bleibt `busy` false und der Lauf lebt weiter; UI-Updates fließen weiter. Dieses Muster ist nirgends beschrieben.
- **Vorschlag:** Kleinster Schritt: Skill um ein "Hintergrundarbeit"-Muster ergänzen (Handler startet Arbeit ohne `await`, setzt ein `cancelled`-Flag, meldet Fortschritt über `progress.set`). Besserer Schritt: `busy` nur für Modal-Wartezeiten setzen und den 15-Sekunden-Timer nur auf die synchrone Rückkehr des Handlers anwenden; die Watchdog-Funktion (hängender Worker) bleibt über `stop` und den 45-Sekunden-Budgetrahmen im Agentenmodus erhalten. Trade-off: Ohne `busy` kann ein Nutzer Aktionen doppelt auslösen; das muss die App über `setDisabled` selbst regeln, was sie ohnehin sollte.

### F3 (hoch, Produkt): Dateiauswahl ist auf 64 Dateien und 16 MiB begrenzt

- **Code:** `runtime/session.ts:105-111` (Picker-Ergebnis wird gegen `LIMITS.files`/`LIMITS.rpcBytes` geprüft und ganz verworfen), `contracts.ts:7,13`, `skills/code-mode/references/runtime.md:45-47` (Budget nur für Inputs/Outputs erwähnt, nicht für Picker).
- **Auslöser:** Ordnerauswahl mit einem Jahr Kontoauszügen und Rechnungen (leicht 200 bis 1000 Dateien, 50 bis 300 MB). Ergebnis: "Selected files exceed the run budget", nichts wird verarbeitet.
- **Auswirkung:** Anforderung 1 scheitert bereits an realistischen Ordnergrößen. Die Grenze ist aus dem Chat-Transportbudget abgeleitet, obwohl `File`-Objekte im Browser nur Referenzen sind und erst beim `arrayBuffer()` Speicher belegen.
- **Vorschlag:** Picker-Grenzen von den Chat-Input-Grenzen trennen: für Nutzerläufe deutlich höher (Anzahl im Tausenderbereich, Gesamtgröße im hohen dreistelligen MiB-Bereich) und die Grenze im Skill nennen. Testläufe behalten das Chat-Budget. Trade-off: Speicherverbrauch liegt dann in der Verantwortung des App-Codes (Dateien sequenziell lesen, nicht alle Puffer halten). Das ist für den Anwendungsfall ohnehin nötig.

### F4 (hoch, Agent-UX): Testläufe von GUI-Apps können keine Dateien erhalten

- **Code:** `agent-runtime.ts:80` ("GUI apps cannot access chat files"), `client-calls.ts:28-30` (serverseitig dieselbe Regel), `runtime/session.ts:106` (im Testmodus liefert `file.open*` genau `inputs`).
- **Auslöser:** Der Agent baut die Abgleich-App als `kind: "app"` und will den Import-Button testen. `code_run` mit `inputPaths` wird abgelehnt; ohne `inputPaths` liefert der Picker `[]`/`null`.
- **Auswirkung:** Der zentrale Pfad der App ist für den Agenten nicht ausführbar. Er kann nur die Verarbeitung als Script mit `inputPaths` testen und danach blind in eine App überführen. Der Skill beschreibt diesen Umweg nicht; er sagt nur "GUI apps cannot read chat attachments".
- **Vorschlag:** `inputPaths` für **Testläufe** von Apps erlauben. Die Mechanik existiert bereits (Testmodus ersetzt den Picker durch die Inputs); nur die Policy an zwei Stellen blockiert. Das Produktziel "Apps lesen keine Chat-Anhänge implizit" bleibt gewahrt, weil Nutzerläufe weiterhin keine Inputs bekommen und der Agent die Dateien explizit auswählt. Bis dahin: Skill um "Verarbeitung als Script mit Inputs testen, dann App-Hülle" ergänzen.

### F5 (mittel, Fehler): `capabilities.run` liefert `data`, der Skill beschreibt das Envelope

- **Code:** `runtime/capabilities.ts:21-28` (`return "data" in result ? result.data : null`), `skills/code-mode/references/capabilities.md:9-16` (`const data = result.data;` und "including any supplied references or files").
- **Auslöser:** Agent übernimmt das Skill-Beispiel; `result.data` ist `undefined`, Folgeaufrufe schlagen fehl. Referenzen, Links und Dateien des Envelopes sind im Worker nicht erreichbar.
- **Vorschlag:** Skill korrigieren (Rückgabe ist `data`) oder Host das Envelope durchreichen. Erstes ist ein Einzeiler; zweites ist die reichere, aber inkompatible Änderung. Empfehlung: Skill korrigieren, Envelope-Durchreichung nur wenn ein konkreter Konsument Refs braucht.

### F6 (mittel, Fehler): Revisionen werden nie bereinigt; STORAGE_FULL blockiert das Artefakt dauerhaft

- **Code:** `service.ts:83-91` (`writeRevision` summiert alle Revisionen gegen `AI_FILES_MAX_CONVERSATION_BYTES_DEFAULT`, 250 MiB), `service.ts:186,323,348` (`writeFile`, `metadata`, `restore` schreiben jeweils ein vollständiges Bundle), `migrate.ts:20-27,32-40` (Publikationen referenzieren Revisionen per FK). Keine Löschlogik für `assistant.artifact_revisions` gefunden.
- **Auslöser:** Iterative Entwicklung mit vielen `code_write`-Aufrufen auf einem großen Bundle. Bei 1,5 MiB pro Revision sind es rund 160 Schreibvorgänge bis zum Budget. Danach scheitern auch Titeländerung und Restore, weil beide eine Revision anlegen.
- **Vorschlag:** Beim Schreiben alte Revisionen verwerfen, die weder aktuell noch publiziert sind, oberhalb einer kleinen Zahl (zum Beispiel die letzten 50). `code_history` bleibt damit als Kurzzeit-Recovery nutzbar; Publikationen bleiben vollständig.

### F7 (mittel, Risiko): Zweiter Tab meldet nach 61 Sekunden "interrupted", obwohl der erste Tab legitim arbeitet

- **Code:** `agent-runtime.ts:166-173` (Claim-Polling bis 61 s, danach Fehlerergebnis an den Controller), `client-calls.ts:45-49` (Claim gilt nach 60 s als `expired`), `client-calls.ts:52-59` (späte `complete` des ersten Tabs wird trotzdem gespeichert).
- **Auslöser:** Chat in zwei Tabs offen, Script fragt eine Capability-Freigabe an, Nutzer braucht länger als eine Minute. Tab B liefert dem Modell "Browser execution was interrupted", Tab A schließt später ab; dessen Ergebnis kommt beim Turn zu spät an.
- **Auswirkung:** Falsches Fehlersignal an den Agenten, mögliche Doppelwirkung, falls der Agent den Lauf neu startet. Die Approval-Pause im 45-Sekunden-Budget (`agent-runtime.ts:187`) ist nur lokal, nicht im Claim.
- **Vorschlag:** Der verlierende Tab sollte nicht nach fester Zeit einen Fehler einreichen, sondern schweigen und höchstens weiter pollen; nur der Gewinner oder eine serverseitige Ablaufregel liefert ein Ergebnis. Alternativ den Claim per Heartbeat verlängern, solange der Gewinner lebt.

### F8 (mittel, Risiko/Performance): Jeder UI-Flush sendet den gesamten Knotenbaum und wird im Hauptthread mehrfach serialisiert

- **Code:** `runtime/worker.ts:44-54` (`send({ type: "ui", nodes: [...nodes.values()] })` alle 16 ms bei Änderungen), `runtime/host.ts:76-79` (`JSON.stringify`, `TextEncoder.encode`, `WorkerMessage.parse`, `validateTree` pro Nachricht), `RuntimeView.tsx:33-36` (`reconcile` über alle Zeilen).
- **Auslöser:** Fortschrittsbalken plus Ergebnistabelle mit 1000 Zeilen. Jeder `progress.set` nach einem `await` erzeugt einen Flush mit allen Zeilen; bei vielen Dateien Dutzende Flushes pro Sekunde.
- **Auswirkung:** Spürbare Last im Hauptthread des Nutzers, im Extremfall genau das "blockierte UI", das Anforderung 10 ausschließt. Ohne Messung nicht quantifiziert.
- **Vorschlag:** Flush-Intervall dynamisch an die Baumgröße koppeln oder nur geänderte Knoten senden (die Nodes haben stabile IDs). Kurzfristig: Skill-Hinweis, Tabellen erst nach Abschluss zu füllen und Fortschritt seltener zu setzen.

### F9 (niedrig, Fehler): Logs werden nach 200 Einträgen stillschweigend verworfen

- **Code:** `runtime/host.ts:80` (`if (logs++ < LIMITS.logs)`), `contracts.ts:10`.
- **Auswirkung:** Pro-Datei-Logs eines Imports enden nach 200 Zeilen; spätere Fehlerhinweise im `console.error`-Pfad fehlen, nur `error`-Nachrichten kommen noch durch. Der Skill nennt nur die 20 Einträge im Snapshot.
- **Vorschlag:** Ringpuffer statt Abschneiden (letzte 200 behalten, wie `session.ts:52` es bereits tut) und die Grenze dokumentieren.

### F10 (niedrig, Agent-UX): Begriffe kollidieren zwischen Tool, CLI und Skill

- `code_update` (Tool: nur Metadaten, `code-source-contracts.ts:103-106`) vs. `assistant code update` (CLI: komplettes Bundle ersetzen, `cli/code.ts:62-64`, `source-workflow.md:68-69`).
- `code_list` wird in `source-workflow.md:12` ohne `q` beschrieben, hat es aber (`code-source-contracts.ts:57`).
- `ui.select(label, options, initialValue, id)` ist der einzige Konstruktor mit positionaler `id` (`worker.ts:178-183`); alle anderen nehmen ein Optionsobjekt.
- Fehlercode `STORAGE_FULL` steht auch für "zu viele offene Capability-Aufrufe" (`capability-runtime.ts:66`).
- **Vorschlag:** CLI-Kommando in `code replace` umbenennen oder die Skill-Zeile präzisieren; `ui.select` ein Optionsobjekt geben (kompatibel, alte Signatur weiter akzeptieren, nur wenn Aufwand trivial).

### F11 (niedrig, Fehler): Große geteilte Dateien scheitern am Transport statt am Budget

- **Code:** `runtime/shared-storage.ts:23-29` (Base64-Kodierung), `api.ts:39` (`bodyLimit` 16 MiB), `service.ts:286` (Budget 16 MiB dekodiert).
- **Auswirkung:** Dateien zwischen etwa 12 und 16 MiB liefern einen generischen Transportfehler statt `STORAGE_FULL`. Für den Anwendungsfall irrelevant (keine Speicherung), aber ein irreführender Fehler.
- **Vorschlag:** Body-Limit für die Storage-Route auf die Base64-Größe des Budgets anheben oder das Budget im Skill entsprechend kleiner angeben.

### Positiv belegt

- Ausführungs-Claims verhindern Doppelausführung über Tabs hinweg und replayen nie unsichere Aufrufe (`client-calls.ts`, `service.integration.test.ts:175-210`).
- Capability-Freigabe wird beim Auflösen gegen Schema-Hash, Kind, Approval-Modus und neu berechnete Review verglichen (`capability-runtime.ts:96-107`); Ablehnung funktioniert ohne Autorisierung des Ziels (`:85-90`).
- `code_write` speichert unvollständigen Code mit Diagnose statt abzulehnen; parallele Schreibvorgänge auf verschiedene Dateien bleiben erhalten (`service.ts:176-191`, Test `:148-173`).
- Entry-Rückgabe von UI-Handles wird mit einer verständlichen Meldung abgefangen (`worker.ts:381`).
- Der Skill ist progressiv aufgebaut, korrekt generiert und über einen Test gegen die Markdown-Quellen abgesichert (`skill.test.ts`).
- SQL-Zugriff ist ein bewusst kleiner SELECT-Subset mit Parameterzählung, kein SQL-Proxy (`database-sql.ts`).

## 4. Produktmodell, menschliche UX, Agent-UX

### 4.1 Produktmodell

Das Modell "eine Quelle, ein Worker, drei Arten von Effekten (lokal, geteilt, Capabilities)" ist verständlich und trägt die Fälle Einmalauswertung, Script und kleine interaktive App gut. Die Entscheidung, Code-Mode-Tools als direkte `code_*`-Tools statt als Capabilities zu führen, reduziert die Übersetzungsarbeit für den Agenten spürbar.

Wo das Modell Reibung erzeugt:

- **Vier Speicherarten** (OPFS lokal, Server-KV/Dateien, rsql-Datenbank, Chat-Dateien) plus Ausführungs-Inputs. Für den Anwendungsfall wird keine davon gebraucht, der Skill muss sie aber alle abgrenzen. Das ist kein Fehler, aber Kontextkosten bei jedem Einsatz.
- **Kit und Code Mode existieren parallel** (`skill-seeds.ts:356-364`: beide Skills sind aktiv). Der Code-Mode-Skill muss sich in der ersten Zeile von Kit abgrenzen. Offene Produktfrage: ob Kit als Zielplattform für neue Apps bleibt oder der Code Mode ihn ablöst.
- **Der Worker ist auf kleine, kurze Programme ausgelegt.** Budgets (2 MiB Quelle, 16 MiB Ein- und Ausgabe, 15 s Interaktion, 300 Knoten, 1000 Zeilen) passen zu Rechnern und Dashboards, nicht zu Datenverarbeitung über Ordner. Wenn der Abgleichsfall ein Zielfall bleibt, muss das Modell "lange Hintergrundarbeit im Browser" als erste Klasse bekommen (F2, F3, F8).
- **Bibliotheken sind nicht vorgesehen.** Alles, was nicht als Host-Namespace existiert (`money`, `sheet`, `ids`, `ui`), muss das Modell selbst schreiben. Für Datumsparsing und CSV reicht das; für PDF, XLSX, ZIP oder XML nicht (F1).

### 4.2 Menschliche UX

- Studio, Karten, Start/Neustart/Stop, Konsole und Versionen sind schlüssig; Berechtigungen "Benutzen/Verwalten" sind auf zwei Stufen reduziert, das passt.
- Scripts, die ein Mensch aus dem Studio startet, zeigen ihr Ergebnis als rohes JSON in der Konsole (`ArtifactPanel.tsx:132`). Für Nutzer ohne technischen Hintergrund ist das kein Ergebnis. Ein kleiner Renderer für Objekte und Tabellen oder eine Empfehlung im Skill, Scripts mit `ui.table`/`ui.markdown` abzuschließen, würde helfen.
- Fehlerzustände im Lauf: Timeout und Abbruch beenden die App ohne Wiederaufnahme; der Nutzer startet neu und verliert die Auswahl (F2). Für eine Abgleich-App mit langer Verarbeitung ist das nicht akzeptabel.
- Controls: Text-Input, Select, Button, Liste mit Aktionen, Tabelle ohne Zeilenaktionen, Progress, Markdown, Chart, File-Picker. Es fehlen Zahl- und Datumsfelder, Checkbox außerhalb von Modals, Mehrfachauswahl und Tabellenzeilen-Aktionen. Für "Zuordnung bestätigen" bleibt nur `ui.list` mit Aktionen oder ein Modal pro Fall. Machbar, aber umständlich bei hunderten Fällen.
- Downloads: `files.save` löst sofort einen Browser-Download aus. Zwei CSV-Dateien ergeben zwei Downloads, mit Browser-Nachfrage. Akzeptabel für V1.

### 4.3 Agent-UX

Stärken:

- Werkzeugnamen sind flach, konsistent und klein; jedes Tool hat ein kleines Eingabeschema. `code_run` mit `code` ohne Ressource ist der richtige Default für Einmalaufgaben.
- Die Snapshot-Rückgabe (Status, Fehler, Logs, Knoten mit IDs, Ausgabe, Dateien) genügt für Debugging, ohne dass der Agent zusätzliche Inspektionen braucht. `kind: "host"`-Fehler sind sauber von Programmfehlern getrennt.
- Skill-Ladepfad funktioniert: Katalogeintrag, `load_skill`, Referenzen unter `/skills/assistant-code-mode/references/*`.

Schwächen und Sackgassen:

- **Nicht testbare App-Pfade** (F4) sind die größte Sackgasse. Der Agent wird eine App bauen, den Picker nicht auslösen können und entweder ohne Test veröffentlichen oder den Nutzer bitten, es manuell zu probieren.
- **Undokumentierte Grenzen** erzeugen Fehlversuche: 15-Sekunden-Interaktion (F2), Picker-Budget (F3), 15-Sekunden-Startwatchdog (`session.ts:55-58`), Log-Abschneiden (F9), 200 Optionen pro Select, 32 Aktionen pro Liste. Der Agent erfährt sie erst aus Fehlern.
- **Falsches Beispiel** (F5) kostet mindestens einen Iterationszyklus pro Capability-Nutzung.
- **Kontextverbrauch:** `code_read` liefert 16 000 Zeichen pro Fenster (`code-tools.ts:94`); ein 200-KiB-Parsermodul kostet 13 Aufrufe. Für "vorhandene App verbessern" ist das teuer. Ein `code_read` mit Zeilenbereich oder ein Grep-Tool würde helfen, ist aber nur nötig, wenn Apps größer werden.
- **CLI-Parität:** `assistant code run --steps-file` erlaubt keine Wartezeit zwischen Schritten; Hintergrundarbeit (F2-Workaround) ist damit in der CLI nur über wiederholte `code_inspect`-Schritte beobachtbar.
- **Doku, Skill, Tools stimmen weitgehend überein.** Abweichungen: F5, F10, und die Assistant-App-Doku nennt die Picker- und Interaktionsgrenzen ebenfalls nicht.

## 5. Anwendungsfall: PDF-Abgleich von Rechnungen und Bankbuchungen

### 5.1 Ablauf mit der heutigen Implementierung

1. Der Agent lädt den Skill, wählt `kind: "app"` (interaktive Controls nötig), legt die Ressource an und schreibt `main.ts` plus `parsers/*.ts`. Relative Importe funktionieren (`compile.ts`).
2. Für PDF-Text steht nichts zur Verfügung (F1). Der Skill leitet auf `read_file` um. Der Nutzer müsste jede PDF in den Chat laden; der Agent extrahiert serverseitig und schreibt CSV/JSON in Chat-Dateien. Das ist eine andere Anwendung als die geforderte.
3. Datenmodell und Abgleich sind reine Anwendungslogik: `money.parse` mit `de-DE` liefert Cent-Integer, `money.sum`/`compare` prüfen centgenau, `ids.ulid()` liefert stabile IDs. Hier trägt der Code Mode.
4. Ergebnisanzeige über `ui.table` (max. 1000 Zeilen, nur Skalare) und `ui.list` mit Aktionen für Bestätigungen. Seiten- und Dateiverweise sind Textspalten; Links auf lokale Dateien sind nicht möglich (`protocol.ts:22-24` erlaubt nur http, https, mailto).
5. Export: `sheet.toCsv` liefert Semikolon, BOM, CRLF und Formel-Escaping; Dezimalkomma muss die App aus `money.toDecimal` selbst erzeugen. Doppelzählung von Sammelbeträgen ist Logik der App.
6. Fortschritt und Abbruch: nur mit dem undokumentierten Hintergrundmuster (F2). Ordnergrößen scheitern am Picker-Budget (F3).
7. Der Agent kann den Import nicht testen (F4); er kann nur die Parser als Script mit einigen hochgeladenen Beispiel-PDFs prüfen, und auch das nur ohne PDF-Parser.

### 5.2 Anforderungsmatrix

| # | Anforderung | Code Mode muss liefern | Anwendungscode | Lücke / offener Nachweis |
| --- | --- | --- | --- | --- |
| 1 | Ordner mit PDFs inkl. Unterordnern wählen | `files.openFolder()` vorhanden (`webkitdirectory`, `ArtifactPanel.tsx:17`) | Filter auf `.pdf`, Rekursion über `webkitRelativePath` | **Lücke F3:** 64 Dateien / 16 MiB. **Offen:** `webkitRelativePath` nach zwei `postMessage`-Hops. Kein Test-Pfad für den Agenten (F4). |
| 2 | Lokal, kein Upload, Originale unverändert | Sandbox ohne Netz erfüllt Lokalität für alles, was im Worker läuft | keine Schreibzugriffe auf Eingaben (technisch ohnehin unmöglich) | Erfüllt, solange kein `read_file`-Umweg nötig ist. Mit F1 ist der Umweg der einzige Weg und verletzt die Anforderung. |
| 3 | PDF.js; Sparkasse, DHL, FedEx (Rechnung und Gutschrift) | PDF-Textextraktion mit Seitenbezug | Parser pro Format, Erkennung von Gutschriften | **Lücke F1.** **Offen:** Keine Beispieldokumente; Textreihenfolge in Kontoauszugstabellen, mehrseitige FedEx-Rechnungen, Gutschriftkennzeichnung nicht bewertbar. |
| 4 | Datenmodell mit Datum, Referenzen, Währung, Cent-Beträgen | `money` (Minor Units, `parse` mit Locale), `ids.ulid` | Typen für Buchung/Beleg, Referenzextraktion per Regex | Erfüllt. Datumsparsing (dd.mm.yyyy) ist Handarbeit; kein Host-Helfer, aber unkritisch. |
| 5 | Eine Buchung zu mehreren Rechnungen (Rechnungsnummer, Avis) | keine Plattformleistung nötig | Matching-Regeln, Avis-Parser | Erfüllt als Anwendungslogik. **Offen:** Avis-Format von DHL/FedEx unbekannt. |
| 6 | Centgenaue Summen, Duplikaterkennung, Betragsgleichheit nur als Vorschlag | `money.sum`, `money.compare` | Duplikat-Schlüssel (Aussteller, Nummer, Betrag), Konfidenzstufen | Erfüllt. |
| 7 | Ergebnisansicht (bestätigt, Differenzen, fehlend, ungeklärt) | `ui.table`, `ui.list`, `ui.section`, `ui.status` | Gruppierung, Paginierung ab 1000 Zeilen | Erfüllt mit Einschränkungen: keine Zeilenaktionen in Tabellen, Bestätigen nur über Listenaktionen oder Modale. |
| 8 | Nachvollziehbarkeit (Quelldatei, Seite, Grund) | Seitennummern aus dem PDF-Parser | Herkunft an jedem Datensatz führen | Abhängig von F1. Anzeige nur als Text; keine Datei-Links möglich. |
| 9 | `zuordnungen.csv`, `offene-faelle.csv`, Semikolon, Dezimalkomma, keine Doppelzählung | `sheet.toCsv` (Semikolon, BOM, CRLF), `files.save` | Dezimalkomma aus `toDecimal`, eine Zeile pro Zuordnung mit Anteilsbetrag | Erfüllt. Zwei Downloads nacheinander. |
| 10 | Fortschritt, Abbrechen, verständliche Dateifehler, UI nicht blockiert | `ui.progress`, `ui.status`, Worker-Isolation | Fehlerliste pro Datei, `cancelled`-Flag | **Lücke F2:** 15-s-Interaktionslimit und `busy`-Sperre. Risiko F8 bei häufigen Updates. |
| 11 | Kein OCR, keine Speicherung, kein DATEV; Parser erweiterbar | relative Importe, keine Speicherung nötig | Parser-Registry über `parsers/index.ts` | Erfüllt. Skill-Abschnitte zu Storage/DB sind hier nur Ballast. |

### 5.3 Fazit für den Anwendungsfall

- **Ohne Änderungen am Code Mode:** nicht zuverlässig baubar. F1 ist ausschließend, F2 und F3 machen die Nutzung realistischer Ordner unmöglich, F4 verhindert die Verifikation durch den Agenten.
- **Mit F1 bis F4 behoben:** Ein Agent kann Parser, Datenmodell, Matching, Prüfung, Anzeige und Export vollständig in Anwendungscode umsetzen. Die Qualität der Parser bleibt eine Validierungsfrage, die nur mit echten Dokumenten beantwortbar ist.
- **Ein Mensch** könnte die App anschließend sinnvoll nutzen, wenn F2 gelöst ist (Fortschritt, Abbruch) und die Ergebnisansicht mit Listenaktionen statt Tabellen-Klicks akzeptiert wird.

## 6. Empfehlung und nächste Schritte

Reihenfolge nach Nutzen pro Aufwand:

1. **Sofort, kleine Korrekturen (Tage):** F5 (Skill-Rückgabe von `capabilities.run`), F2-Dokumentation (Hintergrundmuster, 15-s-Grenze, Startwatchdog), F3-Dokumentation (Picker-Budget), F9 (Ringpuffer), F10 (Begriffe). Diese Punkte kosten den Agenten heute Iterationen, ohne dass eine Architekturfrage offen ist.
2. **Kurzfristig, Policy-Änderung (Tage):** F4, `inputPaths` für App-Testläufe. Die Mechanik existiert; die Änderung betrifft zwei Prüfungen und einen Skill-Absatz. Trade-off: Der Grundsatz "Apps lesen keine Chat-Anhänge" gilt dann nur noch für Nutzerläufe. Das ist die sinnvolle Grenze, weil nur der Agent im Testlauf steuert.
3. **Kurzfristig, Robustheit (Tage):** F6 (Revisionsbereinigung) und F7 (kein Fehlerergebnis vom verlierenden Tab). Beides sind stille Defekte, die erst im Dauerbetrieb auffallen.
4. **Entscheidung, dann Umsetzung (Wochen):** F1, Bibliotheken im Worker. Empfehlung: geprüfte Import-Whitelist, die `compileArtifact` aus Host-Bundles bedient, beginnend mit PDF.js. Das löst den Abgleichsfall und öffnet XLSX/ZIP/XML ohne weitere Sonderfälle. Der engere Namespace `pdf.*` wäre schneller, erzeugt aber beim nächsten Format wieder dieselbe Diskussion. Vorher klären: Läuft PDF.js im Worker unter der bestehenden CSP (Fake-Worker-Modus, kein WASM)? Wenn nicht, muss der Host ein zweites Worker-Blob erlauben.
5. **Nach F1: Modell für lange Arbeit (Wochen):** F2 im Host (Interaktions-Timeout nur für den synchronen Teil, `busy` nur bei Modals), F3 (eigene Picker-Grenzen), F8 (Delta-Flushes oder adaptives Intervall). Erst dann ist "Verarbeitung im Browser über einen Ordner" ein unterstützter Fall und nicht ein Trick.
6. **Validierungsspike:** Mit anonymisierten Beispiel-PDFs (je zwei pro Format, inklusive Gutschrift und mehrseitiger Rechnung) den Extraktionspfad als Script prüfen, bevor die App gebaut wird. Ohne diese Dokumente ist jede Aussage zur Parserqualität spekulativ.

Was nicht empfohlen wird: ein grundlegender Umbau des Sandbox- oder Berechtigungsmodells. Beides ist tragfähig. Die Lücken liegen in Budgets, Timeouts, Bibliotheksversorgung und Dokumentation, nicht in der Architektur.
