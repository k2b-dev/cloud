# Review: Assistant Code Mode – Produktionsreife

Stand: Checkout `384629470` (12.09.2026). Das Assistant-Paket hat keine
uncommitteten Änderungen; die offenen Änderungen im Arbeitsbaum betreffen Grids
und Workflows und wurden nicht angefasst. Statisches Review, ausschließlich
lesend: keine Tests, Builds, Browserläufe, Dienststarts oder Datenänderungen.
Dokumentation über `cloud-dev-mcp` (Assistant-App-Seite, Tools and approvals,
Chat runtime and streaming, Kit browser apps). Die früheren Reviews unter
`plans/reviews/assistant-code-mode-*.md` habe ich erst nach der eigenen Analyse
gelesen; Abschnitt 7 prüft ihren Stand.

Evidenzgrade in diesem Dokument: **belegt** = direkt aus Code oder Text
nachvollziehbar; **plausibel** = begründete Erwartung, nicht durch einen Lauf
belegt; **offen** = nur durch Ausführung klärbar.

## 1. Urteil

**TL;DR:** Der Code Mode ist architektonisch reif: opaker Sandbox-Worker ohne
Netz, serverseitige Ausführungs-Claims, konsistente Freigaben mit
Review-Vergleich, lokale PDF/XLSX-Verarbeitung, kooperative Hintergrundarbeit,
ein progressiver und getesteter Skill. Für den Einzelnutzer, der eigene Dateien
auswertet oder sich eine kleine App baut, ist der Pfad kurz und ehrlich
beschrieben. **Zwei Punkte stehen einem Rollout an normale Nutzer entgegen**,
beide klein im Fix:

1. **Geteilte Apps leihen sich die Rechte des ausführenden Nutzers** (B1).
   Wer eine veröffentlichte App mit Use-Recht startet, führt darin
   Capability-Queries ohne jede Rückfrage und Actions mit seinen eigenen
   gemerkten Freigaben aus; die App kann die Ergebnisse in den geteilten
   Speicher oder die Ressourcen-Datenbank schreiben, die der App-Autor liest.
   Kit hat Scripts bewusst keine Cloud-Credentials gegeben; der Code Mode hebt
   diese Grenze ohne Consent-Schritt auf.
2. **Nutzer können eigene Apps und Scripts nicht löschen** (B2). Nur
   Administratoren löschen. Der Skill ermuntert zu Experimenten, jede
   gespeicherte Ressource kann Datenbank und geteilte Daten besitzen, und der
   Studio-Katalog wächst dauerhaft.

Alles andere sind Verbesserungen an Einstieg, Fehlerbildern und Grenzfällen.
Eine statische Prüfung kann Laufzeitzuverlässigkeit nicht bescheinigen: der
echte Modellpfad wurde nach dem letzten Skill-Umbau (Version 19) nicht mit
realen Nutzeraufgaben beobachtet, und die im Follow-up dokumentierten
intermittierenden Timeouts im CLI-Host-Test sind ungeklärt. Abschnitt 9 nennt
die Prüfungen, die vor dem Rollout laufen sollten.

## 2. Umfang und Architektur in Kürze

Gelesen: Skill `packages/assistant/skills/code-mode/**` und Snapshot
`packages/cloud/src/ai/code-mode-skill.ts`; Tool-Verträge
(`code-source-contracts.ts`, `code-source-tools.ts`, `browser-code-contracts.ts`,
`default-tools.ts`); Prompt und Discovery (`system-prompt.ts`,
`shared/ai-platform-prompt.ts`, `skill-catalog.ts`, `skill-tool.ts`,
`skill-seeds.ts`, `capabilities.ts` auszugsweise, `executor.ts` und
`client/controller.ts` an den Client-Tool-Stellen, `routes.ts`
`prepareLaunchDraft`); Browser-Host (`agent-runtime.ts`, `runtime/*`,
`ArtifactPanel.tsx`, `RuntimeView.tsx`, `Workspace.tsx`, `CapabilityApproval.tsx`,
`modal-host.ts`, `Apps.island.tsx`, `AssistantEmptyChat.tsx`, Ausschnitte von
`AssistantWorkspace.island.tsx`); Server (`service.ts`, `api.ts`, `code-tools.ts`,
`code-tool-routes.ts`, `client-calls.ts`, `capability-runtime.ts`, `database.ts`,
`database-sql.ts`, `admin.ts`, `migrate.ts`); CLI (`cli/code.ts`, `cli/code-host.ts`,
Anbindung in `stream.ts`/`turn.ts`); Tests als Quelltext
(`service.integration.test.ts` Titel, `worker.browser.test.ts`,
`code-host.test.ts` Auszüge, `skill.test.ts`, `browser-harness.ts`); Beispiele
`examples/accounting`; Launch-Flows von Mail, Notebooks und Grids.

Das Modell: Eine Ressource (`app` oder `script`) besteht aus Quelltextbundle,
Revisionen, Publikationen, Grants (`read` = Benutzen, `admin` = Verwalten),
optional geteiltem KV/Dateispeicher (16 MiB) und optional einer rsql-Datenbank.
Code läuft ausschließlich im Browser oder im headless CLI-Chromium: Bundle im
opaken iframe (`sandbox.ts`), Worker mit Host-RPC (`worker.ts`, `host.ts`,
`session.ts`). Der Agent nutzt zwölf Server-Tools `code_*` über signierte
Invocation (`code-source-tools.ts`) und sechs Client-Tools, die nur existieren,
wenn ein Host verbunden ist (`executor.ts:533`, `controller.ts:776`). Jede
Client-Ausführung ist über einen serverseitigen Claim mit Lease geschützt
(`client-calls.ts`). Capability-Aufrufe aus Code laufen über
`capability-runtime.ts` mit denselben Approval-Regeln wie Chat-Tools.

## 3. Release-Blocker

### B1 (belegt, Sicherheit/Datenbesitz): Geteilte Apps führen Queries und gemerkte Freigaben des Nutzers ohne Consent aus

- **Code:** `capability-runtime.ts:27` autorisiert einen Aufruf mit
  `artifactId` über `artifacts.get(...)`, also mit **Use**-Recht;
  `capability-runtime.ts:74-76` löst Queries und Actions mit `approval:"none"`
  oder gemerkter Freigabe (`hasRememberedAiToolApproval` pro Nutzer, Tool,
  Scope) sofort auf. `ArtifactPanel.tsx:77` verdrahtet den Nutzerlauf mit
  `approveInModal`; für Queries erscheint kein Dialog. `service.ts:291`
  (`storage`) und `database.ts:115` (`rows.*`) verlangen nur `read`.
  Ein Warnhinweis oder Consent beim ersten Start existiert nicht (keine
  Treffer für "consent" in Assistant oder `cloud/src/ai`; `messages.ts` kennt
  keinen Text dazu).
- **Ablauf:** A baut eine App, die still `mail.search` oder
  `contacts.contact.list` aufruft und die Ergebnisse mit `kv.shared.set` oder
  `db.table(...).insert` ablegt. A teilt die App mit B (Use). B startet sie.
  Die Daten von B liegen danach im geteilten Speicher, den A (Manage) und alle
  weiteren Use-Nutzer lesen. Hat B im Chat einmal "Always approve" für eine
  Action wie `spaces.task.create` gewählt, löst die App auch diese Action still
  aus.
- **Auswirkung:** Das Teilen einer App wird zu einer Delegation der Leserechte
  des Nutzers an den Autor. Die Doku sagt "Normal access checks and action
  approvals still apply", was technisch stimmt, aber für Queries bedeutet
  "keine Rückfrage". Kit hat die Grenze bewusst anders gezogen ("Scripts
  receive no Cloud credentials").
- **Kleinster Fix:** In `runtimeCapabilities.prepare`: wenn `artifactId`
  gesetzt ist und der Aufrufer auf der Ressource kein `admin` hat, (a) gemerkte
  Freigaben ignorieren und (b) auch Queries als `status:"approval"` zurückgeben
  (Titel: App-Name plus Capability), optional mit einer laufbezogenen
  "für diesen Lauf erlauben"-Option im Host statt eines Server-Scopes. Das sind
  wenige Zeilen in `prepare` und eine kleine Ergänzung im Approval-Dialog.
  Agenten-Testläufe und Läufe des Autors bleiben unverändert. Ergänzend im
  Studio-Access-Dialog ein Satz, dass die App im Namen des Nutzers Cloud-Daten
  lesen kann. Ein Integrationstest neben
  `service.integration.test.ts:273` ("script capabilities require real
  approval") sollte den Use-Nutzer abdecken.

### B2 (belegt, Datenbesitz/Adoption): Nutzer können eigene Ressourcen nicht löschen

- **Code:** `api.ts:55` ist der einzige DELETE-Pfad und liegt unter
  `/admin/resources/:id` (`artifactAdmin.remove`, `admin.ts:26-37`, prüft
  Plattform-Admin-Rolle). Das Studio-Menü (`Apps.island.tsx:135-149`) bietet
  Edit, Share, Projects, Publish, Unpublish, Fork; kein Delete. Die CLI hat nur
  `studio-admin delete` (`cli/code.ts:129`). `source-workflow.md` sagt korrekt
  "This does not grant sharing or app deletion".
- **Ablauf:** Ein Nutzer probiert drei App-Varianten aus, verbindet in einer
  eine Datenbank, verwirft zwei. Sie bleiben dauerhaft im Studio, mit
  Publikationen, Grants, geteiltem Speicher und rsql-Namespace. Der Nutzer
  kann nur "Unpublish".
- **Auswirkung:** Verstößt gegen die Erwartung, eigene Daten entfernen zu
  können; erzeugt Support-Aufwand ("bitte löschen"); wächst mit genau dem
  Experimentierverhalten, das der Skill fördert.
- **Kleinster Fix:** `admin.remove` in `artifacts.remove` verallgemeinern mit
  `requireArtifact(db,id,identity,"admin")` statt Plattform-Rolle
  (die Cleanup-Logik für Datenbank-Namespaces ist bereits vorhanden), Route
  `DELETE /:id`, Menüpunkt mit Bestätigung im Studio, CLI `code delete`. Der
  Agent braucht kein `code_delete`; Löschen bleibt bewusst eine
  Nutzerhandlung.

## 4. Wichtige Verbesserungen

### W1 (belegt): CSV-Umlaute aus Excel-Exporten werden falsch dekodiert

- **Code:** `worker.ts:318-327` liest CSV über `file.text()`, also UTF-8 ohne
  Option; `runtime.md:63-68` und `SKILL.md` nennen keine Kodierung. Deutsche
  Excel-CSV-Exporte sind häufig Windows-1252.
- **Ablauf:** "Werte diese Kundenliste aus" mit `Kundenliste.csv` aus Excel.
  Namen erscheinen als `M�ller`; Gruppierungen und Exporte übernehmen den
  Fehler; der Nutzer sieht das erst in der Datei.
- **Fix:** `sheet.fromCsv(file, { encoding? })` mit `TextDecoder` (im Worker
  verfügbar) und ein Satz im Skill: "Bei `�` in Text `encoding:"windows-1252"`
  verwenden". Ohne API-Änderung reicht auch der Hinweis, dass
  `new TextDecoder("windows-1252").decode(await file.arrayBuffer())` an
  `fromCsv` übergeben werden kann.

### W2 (belegt): Datenbank- und Speicheraufrufe pausieren den 15-Sekunden-Interaktionstimer nicht

- **Code:** `host.ts:109` und `host.ts:119` pausieren den Event-Timer nur für
  `ui.modal`, `file.*` und `capabilities.run`; `database` und `storage`
  fehlen. `host.ts:138` setzt 15 s pro Interaktion. Ein Button-Callback, der
  zehn DB-Batches sequenziell awaitet, stirbt mit "Interaction timed out; the
  run was stopped", während derselbe Callback mit zehn Capability-Aufrufen
  überlebt.
- **Fix:** `database` und `storage` in beide Listen aufnehmen. `work.run`
  bleibt der dokumentierte Weg für lange Importe; die Inkonsistenz ist ein
  Fehlerbild, das der Agent nicht deuten kann.

### W3 (belegt): Vom Menschen gestartete Scripts zeigen rohes JSON

- **Code:** `ArtifactPanel.tsx:132` rendert `output` als `JSON.stringify` in
  der Konsole; Scripts öffnen die Konsole automatisch (`:53`).
- **Ablauf:** Der Agent speichert ein Script "Ordner prüfen" für lokale
  Dateien (der empfohlene Weg in `documents.md:90-94`). Der Nutzer startet es
  im Studio und sieht `{"pages":[{"page":1,"text":"..."}]}`.
- **Fix:** Skill-Regel für gespeicherte Scripts: Ergebnis mit `ui.markdown`
  oder `ui.table` zusammenfassen und `files.save` für Details nutzen; JSON nur
  als Rückgabe für den Agenten. Kein neuer Renderer nötig.

### W4 (belegt): Freigaben aus Script-Läufen sind unsichtbar, wenn der Nutzer den Chat wechselt

- **Code:** `CapabilityApproval.tsx:35` rendert nur Anfragen der aktiven
  Konversation; `agent-runtime.ts:241` und `:62` pausieren derweil Deadlines
  und Lease unbegrenzt. Der Turn bleibt in `waiting_for_action`, ohne Hinweis
  in Sidebar oder anderem Chat.
- **Fix:** Anfragen unabhängig vom aktiven Chat rendern (mit Chat-Titel) oder
  einen Sidebar-Marker "wartet auf Freigabe" setzen. Alternativ die
  Approval-Wartezeit im Host auf einige Minuten begrenzen und danach als
  abgelehnt melden.

### W5 (belegt/plausibel): Code-Ausführung ist im Systemprompt nur über den Skill-Katalog sichtbar

- **Code:** `default-tools.ts:96-101` definiert die `code_*`-Client-Tools ohne
  `promptHint`; die Tool-Hinweise im Prompt (`ai-platform-prompt.ts:40-46`)
  nennen daher `present`, `calculate`, `read_file`, aber keine
  Codeausführung. Der Skill-Katalog (`system-prompt.ts:134-143`) ist das
  einzige Signal und wird bei vielen Organisations-Skills auf 8.000 Zeichen
  gekürzt und nach Query-Relevanz sortiert (`skill-catalog.ts:4,45-60`).
- **Ablauf:** "Summiere die Spalte Betrag in der Excel" bei einer Instanz mit
  vielen eigenen Skills: der Katalog lässt `assistant-code-mode` eventuell
  aus; das Modell greift zu `read_file` (konvertiertes Markdown) und rechnet im
  Kopf oder mit `calculate` über gekürzten Text.
- **Fix:** Ein `promptHint` für `code_run` ("run a short one-off script over
  attached files or Cloud data; load assistant-code-mode first for its
  runtime APIs"). Der Hint erscheint nur, wenn ein Host verbunden ist, weil
  das Tool nur dann in der Liste steht. Eine Zeile.

### W6 (offen): Ein Turn ohne verbundenen Host wartet unbegrenzt

- **Code:** Der Controller dispatcht `awaiting_client`-Blöcke bei jeder
  aktiven Konversation erneut (`controller.ts:314-331`); der Claim des toten
  Tabs läuft nach zwei Minuten ab und liefert `interrupted`
  (`client-calls.ts:42-51`). Eine serverseitige Ablaufregel für
  `waiting_for_action`-Turns habe ich in `maintenance.ts`, `store.ts` und
  `executor.ts` nicht gefunden.
- **Ablauf:** Nutzer sendet "werte die Datei aus", schließt den Laptop. Der
  Turn hängt, bis der Nutzer denselben Chat wieder öffnet; dann bekommt das
  Modell den Interrupt-Fehler und macht weiter. Korrekt, aber für
  Mobilnutzer schwer verständlich (Safari suspendiert Tabs aggressiv).
- **Empfehlung:** Kein Codeeingriff jetzt. In Prüfung P6 (Abschnitt 9)
  beobachten, ob die Wiederaufnahme ohne Doppelwirkung und mit verständlicher
  Modellantwort verläuft. Falls Turns tagelang hängen bleiben, eine
  Ablaufregel im Turn-Runtime ergänzen (gehört in `packages/cloud`).

### W7 (plausibel): Große CSV-Parses können den Worker-Heartbeat aushungern

- **Code:** `work.ts:13` sendet den Heartbeat per `setInterval(…,1000)`;
  `host.ts:93` beendet den Lauf nach 15 s ohne Heartbeat. `Papa.parse` auf
  einem String ist synchron. Ein 50-MiB-CSV (`LIMITS.inputFileBytes`) kann
  auf schwacher Hardware länger als 15 s blockieren.
- **Empfehlung:** Mit P3 messen. Falls es reproduzierbar ist: Skill-Hinweis
  auf `Papa.parse` mit `step`/`chunk` ist nicht möglich, weil `sheet.fromCsv`
  das kapselt; dann `fromCsv` intern in Zeilenblöcken mit `await` zwischen
  Blöcken verarbeiten.

### W8 (belegt): Exportierte Dateien landen mit technischem Namen an der Chat-Wurzel

- **Code:** `agent-runtime.ts:184-188` speichert als
  `/artifact-<20 Zeichen>-<name>`; `write_file` und `present` arbeiten unter
  `/files`. Der Nutzer sieht "artifact-3f9a…-ergebnis.csv".
- **Fix:** Unter `/files/<name>` ablegen, bei Kollision Suffix. Der Skill-Satz
  "returned chat path can be the next run's inputPaths entry" bleibt gültig.

### W9 (belegt): Editor-Speichern nach Agenten-Schreibzugriff endet in CONFLICT

- **Code:** `Workspace.tsx:42-48` speichert mit `expectedRevision` des beim
  Öffnen geladenen Bundles; jeder `code_write` erhöht die Revision
  (`service.ts:205`). Der Nutzer erhält "The artifact has changed. Load the
  latest revision before saving." (`messages.ts:37`) ohne Aktion dafür.
- **Fix:** Bei CONFLICT aktuelles Bundle nachladen und den Diff anbieten oder
  wie Kit einen Entwurfs-Download anbieten. Bis dahin: Skill-Hinweis, dass der
  Nutzer im Quelltext-Tab arbeiten könnte, und dann keine Schreibzugriffe ohne
  Ankündigung.

### W10 (belegt): rsql ist Voraussetzung für "tausende Excel-Dateien wiederholbar importieren"

- **Code:** `database.ts:21` wirft `DB_NOT_CONFIGURED`; geteilter Speicher ist
  auf 16 MiB und 1.000 Einträge begrenzt (`service.ts:305`). Ohne rsql gibt es
  keinen Ort für Zehntausende Zeilen außer CSV-Export.
- **Empfehlung:** Vor dem Rollout entscheiden, ob rsql konfiguriert wird.
  Wenn nicht, den Pfad in Doku und Skill als "Export, kein Import" ausweisen;
  der Skill erklärt den Fehler bereits korrekt (`database.md:10-16`).

## 5. Spätere Optionen

- **S1 Kit und Code Mode parallel.** Zwei nahezu identische Sandboxes und
  UI-Protokolle (vgl. Kit-Doku über MCP). Der Skill grenzt beide ab; die
  Wartungslast bleibt. Konsolidierung erst, wenn ein Kit-Feature wirklich im
  Code Mode fehlt.
- **S2 Tabellenzeilen-Aktionen und Datums-/Zahlfelder** (`protocol.ts` kennt
  nur `input`/`select`). "Zuordnung bestätigen" bleibt über `ui.list`.
- **S3 Delta-Protokoll für UI-Updates** (`worker.ts:63` sendet den ganzen
  Baum, 100 ms koalesziert). Erst nach Messung.
- **S4 Source Maps für Laufzeitfehler** (`debugging.md:297` dokumentiert das
  Bundle-Positionsproblem). Kompilerfehler haben bereits Datei und Zeile.
- **S5 `code_read` mit Zeilenbereich** für große Apps; heute 16.000 Zeichen
  pro Fenster (`code-tools.ts:94`).
- **S6 Skill-Kleinigkeiten:** `ui.select` als einziger Konstruktor mit
  positionaler ID (`worker.ts:203`); CLI `code update` vs. Tool `code_update`
  (beides dokumentiert in `debugging.md:332-335`).

## 6. Bewertung Agent UX und Skill

**Findet der Agent Skill und Tools?** Der Katalogeintrag ist präzise und
grenzt Arithmetik (`calculate`) und Kit ab. Das Risiko liegt bei W5: ohne
`promptHint` gibt es keinen zweiten Pfad. `search_tools` findet `code_run` nur
bei verbundenem Host (`executor.ts:533`), was korrekt ist und im Skill steht
(`debugging.md:233-238`).

**Einstieg in ein Einmalskript.** `SKILL.md:12-16` zeigt den Minimalaufruf,
`:31-38` das erste Dateiskript. Kette für "Was steht in dieser XLSX?":
`load_skill` → `load_tools code_run` (wirkt erst im nächsten Modellturn) →
`code_run`. Drei Aufrufe, zwei Modellrunden. Für einen ersten Blick nennt der
Skill `read_file` (`SKILL.md:6-8`), was für kleine Uploads ohne Code reicht.
Das ist so kurz, wie es dieses Tool-Ladeverfahren erlaubt.

**Referenzen gezielt geladen?** Ja. `SKILL.md:52-66` ordnet jede Referenz einer
Aufgabe zu; GUI-Wissen (`ui.md`, 129 Zeilen) ist nur für Apps nötig. Der
Nachteil: `SKILL.md` selbst ist mit 98 Zeilen dicht; ein Modell, das die
Referenzlinks wörtlich nimmt, liest schnell `runtime.md` plus `documents.md`
(167 Zeilen). Vertretbar.

**Stimmen Skill, Beschreibungen, Schemas, Verhalten überein?** Geprüft und
konsistent: Tool-Tabellen in `debugging.md` und `source-workflow.md` gegen
`browser-code-contracts.ts` und `code-source-contracts.ts`; Deadlines
(15 s/20 s/45 s/30 s) gegen `session.ts:69`, `agent-runtime.ts:60,233`,
`browser-code-contracts.ts:12`; Budgets gegen `contracts.ts` und
`documents.ts:9-10`; Reclaim gegen `agent-runtime.ts:79-91`;
`outputTruncated` gegen `:38`; `kind:"input"` gegen `:198`;
`readExcelFile` liefert alle Blätter (`read-excel-file@9.3.10`
`universal/index.d.ts:89-92`, Rückgabe `Sheet[]`), wie `documents.md:128-136`
behauptet; `crypto.randomUUID` fehlt im opaken Kontext plausibel (kein
Secure Context), `ids.ulid` ist der Ersatz. Abweichungen: W1 (Kodierung fehlt),
W2 (Pausenliste), W8 (Exportpfad).

**Informationsbeschaffung, Debugging, Verifikation.** Snapshot mit Status,
Fehler (6.000 Zeichen), Logs, Knoten-IDs, Output, Dateien (`agent-runtime.ts:20-40`)
genügt zum Debuggen ohne Zusatzaufruf. `code_sql` beantwortet Datenfragen ohne
Code. Fehlerklassen `input`/`host`/Programmfehler sind getrennt. "Never claim an
unexecuted or incomplete result is verified" steht im Skill (`SKILL.md:94-95`),
ebenso die Frage nach Quelle, Einheit und Einschränkung (`:72-75`).

**Rückfragen.** `investigation.md:402-422` begrenzt Rückfragen auf fehlende
Beispiele und fachliche Regeln und verlangt, technische Fragen selbst zu
klären. Das entspricht dem, was ich in meiner eigenen Arbeitsweise als
tragfähig erlebe: fragen nur mit Empfehlung, wenn die Antwort die nächste
Handlung ändert. Was der Skill noch nicht hat und was sich im Nutzerpfad 4
konkret lohnt: eine feste Form für die Beispiel-Rückfrage ("geprüft habe ich
X, mir fehlt Y, weil Z; anonymisiert reicht; alternativ startest du dieses
Script lokal"). Ein Satz in `investigation.md`.

**Muster aus meiner Umgebung, die ich nicht übernehmen würde:** Patch-Tools
(Quellen sind klein), Subagenten (ein Chat), Pflichtpläne. Was ich übernehmen
würde, weil es den Nutzerpfad verkürzt: Aufräumen gehört der Umgebung (bereits
umgesetzt: Reclaim), Schema-Nachladen ohne Modellrunde (hier nicht möglich,
`load_tools` wirkt im nächsten Turn; daher zählt jeder gesparte Aufruf).

## 7. Nutzerpfade im Code verfolgt

### 7.1 CSV/XLSX kurz untersuchen, auswerten, Ergebnis exportieren

Kette: `load_skill` → `load_tools code_run` → `code_run` (Inspektion, Skill-
Snippet) → `code_run` (Auswertung, `files.save`) → `code_export` →
`load_tools present` → `present`. Sieben Aufrufe, vier Modellrunden.
Dateimanifest liefert `inputPaths` (`file-context.ts:78-92`). Eingaben werden
lazy geladen und pausieren den Watchdog (`session.ts:113-124`). Reibung: W1
(Kodierung), W8 (Dateiname), bei großen Dateien W7. Urteil: **tragfähig**.

### 7.2 Kleine App erstellen, benutzen, später ändern

Kette: `code_create` → `code_write main.ts` → `code_run {id}` → `code_interact`
→ `code_open` → Nutzer klickt Start im Workspace-Tab (`Workspace.tsx:98`,
Tab-Zustand in der URL, `workspace-state.ts:42-54`) → `code_publish` mit
`expectedRevision` (nur auf Wunsch). Änderung später: `code_list {q}` →
`code_read` → `code_write` → Testlauf → Nutzer sieht "A newer revision is
available. Restart to use it." (`ArtifactPanel.tsx:103-107`, Polling alle 30 s
und bei Fokus). Besitz: Ersteller erhält `admin`-Grant (`service.ts:176-178`);
Fork kopiert nur Quelle (`:396-411`); Unpublish entfernt Sichtbarkeit; kein
Löschen (B2). Urteil: **gut, außer B2**.

### 7.3 Tausende lokale Excel-Dateien verarbeiten und wiederholbar importieren

Kette: Ressource anlegen, als Admin `database.connect` und `createTable`
(`database.md:709-713`), App mit `files.openFolder` + `work.run` + Checkpoints
+ Batches mit `import_key` (`database.md:730-737`). Mechanik belegt durch
`worker.browser.test.ts:114-118` (3.000 Referenzen) und
`service.integration.test.ts:309` (2.500 Zeilen mit Retry, laut Titel).
Reibung: W10 (rsql Voraussetzung), W2 (DB-Aufrufe nur in `work.run` sicher),
Use-Nutzer dürfen Zeilen schreiben (Design; für Team-Imports gewollt). Urteil:
**tragfähig mit rsql; ohne rsql nur Export**.

### 7.4 Lokale PDF-Rechnungen mit Bankbuchungen abgleichen, ohne Upload

Der Skill verbietet den Upload-Umweg korrekt (`documents.md:82-85`) und
bietet als kleinsten Diagnoseweg ein gespeichertes Script mit lokalem Picker
(`:90-94`). Der Nutzer startet es im Studio und muss die Konsolenausgabe in
den Chat kopieren (W3 macht das mühsam; ein `ui.markdown`-Ergebnis wäre
kopierbarer). Danach: Parser als Einmalskript mit anonymisierten Beispielen
testen, App mit `work.run`, `job.progress`, Cancel-Button
(`work.md:179-197`), `money`-Cents (`money.md`), Quellen als `files.path`,
Seite und Grund pro Datensatz (`documents.md:115-116`), zwei CSV-Downloads
über `files.save` (Semikolon, BOM, CRLF). Die Abgleichlogik in
`examples/accounting/reconcile.ts` ist für den Agenten unsichtbar; er schreibt
sie selbst. Nachvollziehbarkeit, Centgenauigkeit, Fortschritt und Abbruch sind
mit den vorhandenen APIs abbildbar. Offen bleibt die Parserqualität ohne echte
Dokumente. Urteil: **machbar; der Lernschritt am Format ist der größte
Reibungspunkt**.

### 7.5 Daten mehrerer Cloud-Capabilities vergleichen

Kette: `search_tools` je App → `load_tools` (Schemas) → optional direkte
Leseaufrufe → `code_run` mit mehreren `capabilities.run` → Bericht mit
Schlüsselwahl und Pagination (`capabilities.md`, `investigation.md:368`).
Freigaben laufen über den Chat-Host (`CapabilityApproval.tsx`), pausieren
Deadlines, respektieren `allowedTools` (`capability-runtime.ts:33`) und werden
beim Auflösen gegen Schema-Hash und neu berechnete Review geprüft (`:96-106`).
Envelope `.data` laut `code-host.test.ts:66` korrekt. Reibung: W4 bei
Chat-Wechsel. Urteil: **gut**.

## 8. Discovery und erster erfolgreicher Kontakt

### Ist-Zustand

Die Startseite (`AssistantEmptyChat.tsx:46-51`) bietet vier Starter (Mail,
Tagesplan, Cloud-Suche, Notizen), die nur Text in den Composer schreiben
(`AssistantWorkspace.island.tsx:780-783`). Kein Starter führt zu Dateien oder
Apps. Andere Apps nutzen `launchAssistant()` mit Draft-Text, Resource-Chips,
`preloadTools`, optional `skills` und `allowedTools` (`routes.ts:254-268`,
`http.ts:64-75`); Grids kombiniert Skill-Chip plus Tool-Ceiling
(`query-assistant.ts:23-70`). Skill-Chips sind sichtbar und entfernbar; der
Skill wird erst beim `load_skill` mit Rechteprüfung geladen.

### Bewertung der Vorschläge

- **Aufgabenorientierte CTAs "Dateien auswerten", "Eine App bauen", "Was
  kannst du für mich tun?"**: sinnvoll. Der erste ersetzt "Notizen", der
  zweite ist neu, der dritte braucht keine Mechanik: Plattformregel 5
  ("users do not need to know Cloud apps") plus Skill-Katalog plus `list_apps`
  liefern die Antwort; die Qualität ist in P0 zu prüfen.
- **CTAs bereiten einen editierbaren Chat mit Skill-Anhängen vor**: passt zum
  vorhandenen Launch-Modell. Innerhalb des Assistant ist kein Server-Launch
  nötig: der leere Chat ist bereits eine Konversation, der Composer kennt
  Resource-Attachments (`AssistantWorkspace.island.tsx:333,832`). Der Starter
  hängt den `core.ai.skill`-Chip von `assistant-code-mode` an (Short-ID über
  `GET /api/ai/skills`, `skills-routes.ts:60`, liefert `enabled`). Ist der Skill
  deaktiviert oder nicht lesbar, fällt der Starter auf reinen Text zurück
  oder wird ausgeblendet. Keine `preloadTools` für `code_*` (Client-Tools
  existieren ohne Host nicht), kein `allowedTools` (die CTA ist ein Vorschlag,
  keine Einschränkung). Vorhandene Entwürfe: der Starter überschreibt den
  Composer-Text; bei nicht leerem Entwurf nur anhängen. Projekte: Chip ist
  projektunabhängig; `load_skill` prüft Rechte zur Laufzeit.
- **Discovery-Skill**: **nicht empfohlen**. Er würde den Katalog duplizieren
  und veralten; die Funktionen sind ohnehin nutzerabhängig (Rechte, Host,
  Skills, Apps). Wenn P0 zeigt, dass die Antwort auf "Was kannst du?" schwach
  ist, reicht ein Absatz in den Organisationsanweisungen des Admins oder ein
  ausführlicherer CTA-Prompt ("Nenne fünf konkrete Dinge mit meinen Dateien und
  Cloud-Apps, gestützt auf verfügbare Skills und Apps").

### KISS-Vorschlag

Drei Starter statt vier: "Dateien auswerten" (Prompt: "Werte die angehängten
Dateien aus: " + Skill-Chip `assistant-code-mode` + Hinweis-Notice "Datei
anhängen oder einfügen"), "Eine App bauen" (Prompt: "Baue mir eine kleine App,
die " + derselbe Chip), "Was kannst du für mich tun?" (Prompt ohne Chip).
"Mail nachfassen" bleibt, weil Mail der häufigste Fall ist. Umsetzung:
`AssistantEmptyChat.tsx` (Starter-Liste, optionales `skill`-Feld), `useStarter`
(Chip anhängen, Skill-Liste einmal laden), `messages.ts` (Texte de/en). Kein
neuer Server-Endpunkt, kein neuer Skill, keine Tool-Vorladung.

## 9. Stand der früheren Befunde

`assistant-code-mode-review.md` (F1–F11): F1 PDF (`documents.ts:60-87`), F2
Hintergrundarbeit (`work.ts`, `host.ts:90-98`), F3 Picker ohne Chat-Limit im
Nutzerlauf (`session.ts:136-146`), F4 Test-Fixtures (`agent-runtime.ts:114-118,
127`), F6 Pruning (`service.ts:88-107`), F7 Lease (`client-calls.ts:42-51`,
`agent-runtime.ts:214-231`), F8 Koaleszierung 100 ms (`worker.ts:65-69`), F9
Ringpuffer plus Rate-Limit (`session.ts:62`, `worker.ts:118-128`), F11
Transportbudget (`storage-contracts.ts:5`): **erledigt, belegt**. F5 Envelope:
laut `code-host.test.ts:63-103` erledigt; nicht von mir ausgeführt. F10
Begriffe: dokumentiert, nicht umbenannt (S6).

`assistant-code-mode-agent-ux-review.md` (F1–F10): F1 15-s-Satz im Einmalpfad
und `file.read` pausiert (`SKILL.md:44-45`, `session.ts:115`), F2 erstes
Dateiskript im `SKILL.md`, F3 Beschreibung geschärft, F4 Reclaim, F5
Fixture-Halbsatz (`SKILL.md:40-41`), F6 Export-als-Input-Satz (`:17-18`), F7
Script mit Picker (`documents.md:92-94`), F8 Import-Muster (`database.md`), F9
`q`, `outputTruncated`, Stack-Hinweis, F10 `kind:"input"`: **erledigt,
belegt**. Offen aus dem Follow-up: die intermittierenden Timeouts in
`code-host.test.ts` (Ursache "not established"). Ich nehme keine Ursache an;
die Tests sind Playwright-Chromium mit 46-Sekunden-Warteschritten und einem
gemeinsam genutzten Host, was Reihenfolgeabhängigkeit plausibel macht, aber
nicht belegt. Für den Rollout ist das ein Evidenzproblem, kein bekannter
Produktfehler.

## 10. Priorisierter Umsetzungsslice

1. **B1** in `capability-runtime.ts` (Use-Nutzer: keine gemerkten Freigaben,
   Queries mit Freigabe) plus Approval-Titel mit App-Name plus
   Integrationstest. Doku-Satz in der Assistant-App-Seite unter "Store data
   and combine Cloud actions".
2. **B2** Löschen für Manage-Nutzer: Service, Route, Studio-Menü, CLI
   `code delete`, Doku.
3. **W5 + W1 + W2** in einem Skill-Update (Version 20): `promptHint` an
   `code_run`, Kodierungshinweis, Pausenliste im Host. Snapshot neu
   generieren; `skill.test.ts` deckt Konsistenz ab.
4. **Startseite** wie in Abschnitt 8: drei Starter, Skill-Chip über die
   vorhandene Attachment-Mechanik.
5. **W3, W8** als kleine Nachzügler: Skill-Regel für Script-Ergebnisse,
   Exportpfad unter `/files`.

Alles andere nach den Prüfungen in Abschnitt 11.

## 11. Prüfungen vor dem Rollout (nur beschreiben, nicht ausgeführt)

Jede Prüfung ist ein Chat mit dem realen Assistant im Entwicklungsstack,
gemessen an Tool-Aufrufen bis zum ersten nützlichen Ergebnis, Rückfragen und
falschen Erfolgsbehauptungen (`cld assistant chats diagnose` liefert die
Kette).

| # | Ausgangslage | Erwartetes Ergebnis | Fehlersignal |
| --- | --- | --- | --- |
| P0 | Leerer Chat, "Was kannst du für mich tun?" | Konkrete Liste aus verfügbaren Skills und Apps, inklusive Dateiauswertung und App-Bau, ohne Tool-Namen | Generische Antwort, erfundene Funktionen, Aufzählung von Tool-IDs |
| P1 | XLSX mit zwei Blättern angehängt, "Was steht drin?" | Höchstens drei Aufrufe, Blattnamen, Kopfzeilen, Zeilenzahl; keine Ressource | Mehr als ein Referenz-Read, `code_create`, nur erstes Blatt |
| P2 | Windows-1252-CSV mit Umlauten, "Summe je Kunde, als CSV" | Korrekte Umlaute im Bericht und in der Exportdatei, Datei über `present` verlinkt | `�` in Ausgabe oder Datei |
| P3 | 40-MB-CSV, "Summe je Monat" | Erster oder zweiter Lauf nutzt `work.run`; kein identischer Wiederholungslauf; Ergebnis nennt Ausschlüsse | "worker stopped responding", zwei identische Läufe, Stichprobe als Gesamtsumme |
| P4 | Nutzer B startet eine von A geteilte App, die `contacts.contact.list` aufruft und `kv.shared.set` schreibt | Nach B1: Freigabedialog mit App-Name vor dem ersten Query; Ablehnung beendet den Aufruf mit Fehler in der App | Stiller Aufruf, Daten im geteilten Speicher ohne Dialog |
| P5 | "Bau eine App, die meine Kontoauszug-PDFs lokal auswertet", kein Upload erwünscht, keine Anhänge | Keine App vor Evidenz; eine Rückfrage mit anonymisiertem Beispiel oder lokalem Script als Alternative; nach Beispiel: Einmalskript, dann App mit Fortschritt und Abbruch; Testlauf mit `inputPaths` als Fixture | `read_file` auf lokale Dokumente, "Sparkasse unterstützt" ohne Beispiel, App ohne Testlauf geöffnet |
| P6 | Während `code_run` einer 30-s-Aufgabe Tab schließen, nach 3 Minuten wieder öffnen | Turn läuft weiter, Modell erhält "Browser execution was interrupted", startet höchstens einen bewussten neuen Lauf, keine Doppelwirkung | Turn hängt nach Wiederöffnen, doppelter Export, "verifiziert" ohne Lauf |
| P7 | Bestehende App, "Der Speichern-Button rechnet falsch" | `code_list q`, `code_read` vor Änderung, Reproduktion per `code_run`/`code_interact`, kleinste Korrektur, Wiederholung; kein `code_publish` ungefragt; Nutzer-Tab zeigt Neustart-Hinweis | Schreiben ohne Lesen, ungefragtes Publish, "behoben" ohne Wiederholung |
| P8 | `bun test packages/assistant/src/cli/code-host.test.ts` fünfmal hintereinander | Fünf grüne Läufe oder ein reproduzierbares, isolierbares Muster | Mehr als ein Timeout ohne erkennbares Muster; dann vor dem Rollout untersuchen |

## 12. Ausdrücklich unsicher

- Modellverhalten mit Skill Version 19 ist nicht beobachtet; alle Aussagen
  zum Agentenpfad sind aus Skill, Schemas und Prompt abgeleitet.
- Speicher- und Zeitverhalten großer CSV/PDF-Eingaben im Worker ist nicht
  gemessen (W7).
- Mobile Browser und Safari-Suspendierung sind nicht geprüft; die Doku nennt
  nur Chromium als verifiziert.
- Das rsql-Setup der Zielinstanz ist unbekannt (W10).
- Ob `TextDecoder("windows-1252")` in jedem Zielbrowser im opaken Worker
  verfügbar ist, habe ich nicht verifiziert; der Encoding-Standard sieht es
  vor.
