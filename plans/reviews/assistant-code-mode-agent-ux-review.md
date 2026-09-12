# Review: Assistant Code Mode aus Sicht der Agent-UX

Stand: Checkout mit Commit `1f5937fed` (12.09.2026), unveränderter Arbeitsbaum.
Statisches Review ohne Ausführung: keine Tests, keine Agentenläufe, keine Dienste,
keine Änderungen. Ergebnis ist ausschließlich diese Datei.

Leitfrage: Kann ein Agent mit Skill und Tools schnell, selbstständig und
zuverlässig zu einem richtigen Ergebnis kommen, ohne unnötige Rückfragen,
Kontextlast, Tool-Aufrufe oder selbst gebaute Umwege?

## 1. Gesamtbewertung

**TL;DR:** Der Code Mode ist für Agenten inzwischen ein gutes Werkzeug. Die
Grundentscheidungen stimmen: flache `code_*`-Tools mit kleinen Schemas,
`code_run` mit `code` als Default für Einmalaufgaben, sofort speichernde
`code_write`-Aufrufe mit Diagnose, ein kompakter Snapshot, der zum Debuggen
reicht, gebündelte PDF/XLSX-Parser, ein sauberes Hintergrundarbeits- und
Freigabemodell. Der Skill ist progressiv aufgebaut und sagt an vielen Stellen
das Richtige ("Do not turn this workflow into a checklist", "A sample
demonstrates shape, not completeness").

Die verbleibenden Reibungen liegen fast alle im **Einstieg** und in
**verstreuten Grenzwerten**, nicht in der Architektur:

1. **Ein Einmalskript muss nach 15 Sekunden fertig sein**, inklusive Download
   der Chat-Eingaben. Das steht nur in `work.md` und `debugging.md` mit drei
   verschiedenen Zahlen (15 s, 20 s, 45 s), aber nicht im Einmalpfad des
   `SKILL.md`. Für "CSV auswerten" ist das der wahrscheinlichste erste
   Fehlschlag.
2. **Der Weg zur ersten Dateiauswertung ist zu lang.** Das Minimalwissen
   (`inputPaths`, `files.list/read`, `sheet.fromCsv`, `sheet.openExcel`,
   `pdf.open`) liegt in zwei bis drei Referenzdateien. Ein Agent braucht heute
   vier bis fünf Aufrufe, bevor der erste Run startet. Drei würden reichen.
3. **Die Skill-Beschreibung triggert zu breit** ("calculate results", "build
   calculators") und überlappt mit `cloud-kit`. Für "Was sind 19 % von 2.340 €"
   ist ein Skill-Load plus Worker-Start der falsche Weg; `calculate` oder die
   direkte Antwort sind vorhanden.
4. **Fertige Einmalläufe belegen Host-Slots**, bis der Agent sie stoppt. Deshalb
   steht "Stop obsolete runs" dreimal im Skill. Der Host könnte das selbst.

Nichts davon ist ein Architekturproblem. Der unten vorgeschlagene Slice ist
klein: ein umgestellter `SKILL.md`, zwei Host-Korrekturen, sechs Zeilen in
`database.md`.

## 2. Untersuchter Umfang

Gelesen: `packages/assistant/skills/code-mode/SKILL.md` und alle 14 Referenzen;
generierter Snapshot `packages/cloud/src/ai/code-mode-skill.ts` und Generator;
Tool-Verträge (`code-source-contracts.ts`, `code-source-tools.ts`,
`browser-code-contracts.ts`, `default-tools.ts`); Skill-Discovery
(`system-prompt.ts`, `skill-catalog.ts`, `skill-tool.ts`, `skill-seeds.ts`,
`shared/ai-platform-prompt.ts`); Datei-Tools (`file-tools.ts`,
`file-context.ts`); Browser-Host (`agent-runtime.ts`, `client-calls.ts`,
`runtime/session.ts`, `runtime/host.ts`, `runtime/worker.ts`,
`runtime/work.ts`, `runtime/documents.ts`, `runtime/capabilities.ts`,
`runtime/compile.ts`, `contracts.ts`); Server-Tools (`code-tools.ts`,
`code-tool-routes.ts`); CLI (`cli/code.ts`, Testtitel `code-host.test.ts`);
Dokumentation (`docs-site/apps-content/en/assistant.md`,
`docs/en/ai/chat-interface.md`, `skills/cloud-cli/references/assistant.md`,
`examples/accounting/README.md`); beide Vorreviews.

Nicht bewertet: rsql selbst, die generische Turn-Engine jenseits der Code-Mode-
Anbindung, `@k2b/ui`-Rendering der Controls, Nutzeroberfläche des Studio im
Detail.

Einordnung der Findings: **belegt** = aus Code oder Text direkt nachvollziehbar;
**plausibel** = begründete Erwartung an Agentenverhalten, nicht durch Läufe
belegt; **Hypothese** = müsste erst geprüft werden.

## 3. Was gut funktioniert und bleiben soll

- **Einmalcode ist der Default.** `code_run` mit `code` ohne Ressource,
  `code_create` sagt selbst "For one-off analysis, use code_run with code
  instead" (`packages/cloud/src/ai/code-source-contracts.ts:109`), `code_open`
  sagt "For one-off calculations, return the result instead of opening an app".
  Tool-Beschreibungen und Skill ziehen hier am selben Strang.
- **Flache, kleine Tool-Schemas.** Zwölf Server-Tools und sechs Client-Tools,
  jedes mit ein bis vier Feldern, alle mit `code_*`-Präfix, keine Capability-
  Übersetzung nötig (`code-source-contracts.ts`, `browser-code-contracts.ts`).
- **Der Snapshot reicht zum Debuggen.** Status, `work`, Fehler (bis 6.000
  Zeichen), Modal mit ID, Knoten mit IDs, letzte 20 Logs, Output, Dateien
  (`agent-runtime.ts:20-38`). Run und Interact liefern ihn direkt; Inspect ist
  nur für Details nötig.
- **`code_write` speichert unvollständigen Code mit Diagnose** statt
  abzulehnen (`code-tools.ts:131-134`). Das erlaubt "Entry schreiben, Helfer
  schreiben, dann laufen lassen" ohne Reihenfolgezwang.
- **Host-Fehler sind von Programmfehlern getrennt.** `kind: "host"` mit
  Guidance (`agent-runtime.ts:240-245`) und der Skill-Satz dazu verhindern, dass
  der Agent funktionierenden Code umschreibt.
- **Hintergrundarbeit ist erste Klasse.** `work.run` mit `checkpoint`,
  `progress`, `signal`, Heartbeat statt Gesamtlimit, `code_inspect` mit
  `waitMs` (`runtime/work.ts`, `host.ts:88-93`, `agent-runtime.ts:139-146`).
  Die CLI hält den Host bis zum Jobende offen (`cli/code.ts:48-57`).
- **PDF und XLSX laufen lokal im Worker** mit Seiten, Positionen, Sheet-Arrays
  und expliziten Budgets (`runtime/documents.ts`). Das schließt die größte
  Lücke des ersten Reviews.
- **Freigaben sind konsistent.** Approval pausiert die Deadlines
  (`agent-runtime.ts:61, 223`), Skripte können sich nicht selbst freigeben,
  abgelehnte Aufrufe werfen, "a fresh script is not a way to bypass a denied
  action" (`investigation.md:22-24`).
- **`capabilities.run` liefert wie dokumentiert das Envelope** mit `.data`;
  der CLI-Host-Test bildet genau diese Form ab (`code-host.test.ts:66-87`).
  Das Finding F5 des ersten Reviews ist erledigt.
- **Der Skill ist generiert und getestet.** Snapshot-Abgleich, kompilierende
  Beispiele, Chart-Optionen, Money-Beispiel (`skill.test.ts`). Referenzen sind
  unter `/skills/assistant-code-mode/references/*` lesbar.
- **Gute Sätze in `investigation.md`**, die man nicht kürzen sollte: Namen
  sind keine Schlüssel, Betragsgleichheit ist keine Identität, Stichprobe zeigt
  Form statt Vollständigkeit, Nutzerinhalt ist Daten statt Anweisung, technische
  Fragen selbst klären und nur fachliche Regeln erfragen.

## 4. Priorisierte Findings

### F1 (hoch, belegt): Einmalskripte haben ein unsichtbares 15-Sekunden-Limit

- **Fundstellen:** `packages/assistant/src/artifacts/runtime/session.ts:61-67`
  (Watchdog 15 s bis `ready`, nur pausiert bei laufendem `work`);
  `session.ts:110-114` (`file.read` pausiert den Watchdog nicht, anders als
  `database` und `capabilities.run` in `:134-146`);
  `agent-runtime.ts:59` (zusätzlich 20 s `waitFor` beim Start);
  `agent-runtime.ts:215` (45 s Operationsbudget);
  Skill: `work.md:3` ("startup have a 15-second watchdog"), `debugging.md:53`
  ("Calls have a 45-second execution budget"); `SKILL.md:38-42` (Einmalpfad
  nennt kein Limit); `runtime.md` nennt kein Limit.
- **Auslöser:** Nutzer hängt eine 30-MB-CSV an und fragt nach Summen pro
  Monat. Der Agent schreibt das naheliegende Skript ohne `work.run`. Download
  der Eingabe plus Parsen dauert über 15 Sekunden.
- **Folge:** "Run timed out before becoming ready". Der Agent kennt drei
  verschiedene Zahlen und keine Regel, wann welche gilt. Wahrscheinliche
  Reaktion: gleiches Skript nochmal, dann Verkleinerung der Stichprobe, dann
  eventuell `work.run`. Zwei bis drei verlorene Iterationen.
- **Kleinster Vorschlag:** Ein Satz im `SKILL.md`-Einmalpfad: "Ein Lauf muss
  in etwa 15 Sekunden bereit sein. Längere Auswertungen laufen in
  `work.run(...)` mit `return await job.done`; dann mit `code_inspect` und
  `waitMs` warten." Dazu im Host `file.read` wie `database` behandeln
  (`clearTimeout(watchdog)` während des Lesens, `arm()` danach), damit der
  Download der Eingaben nicht gegen die Bereitschaftszeit zählt. Die drei
  Zahlen in `debugging.md` auf eine Erklärung reduzieren: 15 s Bereitschaft
  oder Heartbeat, 45 s pro Tool-Aufruf, Hintergrundjob unbegrenzt.

### F2 (hoch, plausibel): Der Einstieg in eine Dateiauswertung kostet zu viele Aufrufe

- **Fundstellen:** `SKILL.md:40-42` verweist für "Analyze uploaded files" auf
  `runtime.md`; `runtime.md:56-60` verweist für PDF/XLSX weiter auf
  `documents.md`; das einzige vollständige Datei-Snippet steht in
  `investigation.md:41-58` und `examples.md:8-17`.
- **Auslöser:** "Was steht in dieser Datei?" mit angehängter XLSX.
- **Folge:** Realistische Sequenz: `load_skill`, `read_file runtime.md`,
  `read_file documents.md`, `load_tools code_run`, `code_run`. Fünf Aufrufe und
  etwa 170 Zeilen Referenztext, bevor die erste Antwort möglich ist. Mit dem
  Minimalwissen im `SKILL.md` wären es drei Aufrufe. Zusätzlich fehlt der
  Hinweis, dass `read_file` hochgeladene PDF/Office-Dateien bereits serverseitig
  in Markdown konvertiert (`packages/cloud/src/ai/file-tools.ts:189-197`); für
  einen ersten Blick auf eine kleine hochgeladene Datei ist das ein Aufruf ohne
  Code. `documents.md:4-6` warnt zu Recht vor `read_file` für lokale Dateien,
  sagt aber nicht, dass es für Chat-Anhänge oft der kürzeste Weg ist.
- **Kleinster Vorschlag:** In `SKILL.md` ein Block "Erstes Skript für eine
  Datei" mit acht Zeilen: `inputPaths` aus dem Dateimanifest übernehmen,
  `files.list()`, `files.read(name)`, dann je nach Typ `sheet.fromCsv(file)`,
  `sheet.openExcel(file)` oder `pdf.open(file)`, kompakt zurückgeben. Plus ein
  Satz: "Für einen ersten Blick auf eine kleine hochgeladene Datei genügt oft
  `read_file`." `runtime.md` und `documents.md` behalten Grenzen, Details und
  Sonderfälle. Kein zusätzlicher Text insgesamt, sondern Umverteilung.

### F3 (mittel, belegt): Die Beschreibung triggert bei einfachen Rechnungen und überlappt mit Kit

- **Fundstellen:** `SKILL.md:3` ("calculate results, build calculators and
  dashboards"); `packages/cloud/src/ai/skill-seeds.ts:362` (`cloud-kit`:
  "file converters, JavaScript tools, workbench UIs, CSV processing, exact
  money calculations, SQL queries"); `file-tools.ts:558-566` (`calculate`
  Built-in mit Prompt-Hint "calculate arithmetic ... instead of estimating
  mentally"); Plattform-Prompt `shared/ai-platform-prompt.ts:31` ("Keep simple
  answers short").
- **Auslöser:** "Wie viel sind 19 % von 2.340,50 €?" oder "Wann ist in 90
  Tagen?".
- **Folge:** Zwei Skills, deren Beschreibungen beide passen, und ein Built-in,
  das die Aufgabe ohne Worker löst. Ein Agent, der die Skill-Beschreibung
  wörtlich nimmt, lädt den Skill (etwa 1.300 Token), lädt `code_run`, startet
  einen Worker: drei Aufrufe für eine Zeile Arithmetik. Der letzte Satz der
  Beschreibung ("Prefer an existing Cloud feature") ist zu unspezifisch, um
  das zu verhindern.
- **Kleinster Vorschlag:** Beschreibung schärfen: "calculate results from
  data or files" statt "calculate results"; expliziter Satz "Not for plain
  arithmetic or date offsets; answer directly or use calculate." Bei `cloud-kit`
  "in an existing Kit app" an den Anfang stellen, damit die Abgrenzung im
  ersten Halbsatz steht. Beides sind Ein-Zeilen-Änderungen an Beschreibungen
  im Katalog (`system-prompt.ts:136-138`).

### F4 (mittel, plausibel): Fertige Einmalläufe belegen Slots, deshalb muss der Agent aufräumen

- **Fundstellen:** `agent-runtime.ts:78` (`runs.size >= LIMITS.pendingRequests`
  wirft "Stop an existing test run before starting another"; Limit 32 in
  `contracts.ts:12`); Läufe werden nur durch `code_stop` oder Workspace-Cleanup
  entfernt (`agent-runtime.ts:44-48, 147-149`); `SKILL.md:20, 74` und
  `investigation.md:19` wiederholen "Stop obsolete runs".
- **Auslöser:** Explorative Sitzung mit vielen kleinen Einmalskripten, wie der
  Skill sie ausdrücklich empfiehlt. Ein Einmalskript ohne UI ist nach dem
  Snapshot wertlos, hält aber iframe, Worker und Speicher.
- **Folge:** Entweder ein zusätzlicher `code_stop` pro Experiment (bei zehn
  Experimenten zehn Aufrufe ohne Informationsgewinn) oder irgendwann ein
  Fehler, der nichts mit der Aufgabe zu tun hat. Die dreifache Erinnerung im
  Skill ist ein Symptom dafür, dass der Host eine Aufgabe an den Agenten
  delegiert, die er selbst erledigen kann.
- **Kleinster Vorschlag:** Beim Erreichen des Limits den ältesten Lauf
  verdrängen, der weder UI-Knoten noch laufenden Job noch offenes Modal hat;
  eventuell zusätzlich einen headless Einmallauf nach Rückgabe des Snapshots
  automatisch freigeben, wenn er keine Ausgabedateien hält. Danach genügt im
  Skill ein Satz: "Stop a run you no longer need when it holds UI or a job."

### F5 (mittel, plausibel): "GUI apps cannot read chat attachments" versteckt die Test-Fixtures

- **Fundstellen:** `SKILL.md:41-42`; die entscheidende Nuance steht nur in
  `runtime.md:27-30` ("For app test runs, these are explicit picker fixtures")
  und in der `code_run`-Schema-Beschreibung
  (`browser-code-contracts.ts:10`); Mechanik in `agent-runtime.ts:101-104, 114`.
- **Auslöser:** Der Agent hat den Verarbeitungskern als Skript getestet und baut
  die App. Er liest `SKILL.md` und `ui.md`, nicht unbedingt `runtime.md`.
- **Folge:** Der Agent glaubt, die App mit Dateiauswahl sei für ihn nicht
  testbar, veröffentlicht ungetestet oder bittet den Nutzer um manuelle Tests.
  Genau der Umweg, den das Readiness-Review mit F4 beseitigt hat, würde aus
  Unkenntnis weiterbestehen.
- **Kleinster Vorschlag:** `SKILL.md:41-42` um einen Halbsatz ergänzen: "In
  einem Testlauf einer App liefern dieselben `inputPaths` den Picker der App
  als Fixture; `files.list/read` bleiben ihr verborgen."

### F6 (mittel, plausibel): Weiterarbeit über Läufe hinweg ist nur halb erklärt

- **Fundstellen:** `SKILL.md:19-20` ("pass inputs again and export only files
  worth keeping"); `investigation.md:15-17`; Export legt die Datei als
  `/artifact-<20 Zeichen>-<name>` an der Wurzel ab (`agent-runtime.ts:168-174`);
  der Plattform-Prompt beschreibt `/files` und `/input` als die beiden
  Namensräume (`ai-platform-prompt.ts:66`); der Auswahlmechanismus für
  `inputPaths` akzeptiert jede gelistete Chat-Datei (`agent-runtime.ts:79-84`).
- **Auslöser:** Erstes Skript normalisiert 200.000 Zeilen und exportiert eine
  CSV. Zweite Frage braucht diese Zwischendatei.
- **Folge:** Dass eine exportierte Datei im nächsten Lauf direkt als
  `inputPaths`-Eintrag dient, ist nicht ausgesprochen. Ein Agent könnte die
  teure Normalisierung wiederholen oder die Datei über `read_file` in den
  Kontext ziehen. Der Wurzelpfad ist funktional, aber inkonsistent mit dem
  Namensraum-Modell, das der Agent sonst lernt.
- **Kleinster Vorschlag:** Ein Satz in `SKILL.md`: "Ein mit `code_export`
  erzeugter Pfad kann im nächsten `code_run` als `inputPaths` dienen." Ob der
  Export unter `/files/` landen sollte, ist eine kleine, separat entscheidbare
  Konsistenzfrage (Hypothese: `write_file` und `present` arbeiten dort).

### F7 (mittel, Hypothese): Der Weg für "Datei muss lokal bleiben, ich habe kein Beispiel" ist der größte statt der kleinste

- **Fundstellen:** `investigation.md:72-76` ("Offer an anonymized sample or a
  local inspection app"); `documents.md:12-14`; Skripte im Studio öffnen ihre
  Konsole automatisch (`ArtifactPanel.tsx:53`) und zeigen Output als JSON
  (`:132`); `session.ts:117-125` (Nutzerläufe bekommen den nativen Picker).
- **Auslöser:** "Bau mir eine App, die meine Kontoauszüge lokal auswertet",
  keine Anhänge, Originale dürfen nicht hochgeladen werden.
- **Folge:** Der Skill empfiehlt korrekt, nicht auf Upload zu bestehen, nennt
  als Alternative aber nur eine "local inspection app". Das bedeutet UI bauen,
  Controls testen, App öffnen, Nutzer einweisen, bevor der Agent die erste
  Textzeile eines PDFs gesehen hat. Ein gespeichertes Skript mit
  `files.open()`, das der Nutzer im Studio startet und dessen Konsolenausgabe
  (Seitentext, Kopfzeilen) er in den Chat kopiert, wäre deutlich kleiner.
- **Offen:** Ob ein Nutzerlauf eines `kind: "script"` den nativen Picker
  tatsächlich erhält, habe ich nur aus `session.ts` und dem Panel geschlossen,
  nicht verifiziert. Wenn ja: ein Satz in `investigation.md` und
  `documents.md`. Wenn nein: wäre das der kleinere Fix als eine "inspection
  app"-Anleitung.

### F8 (niedrig, belegt): Das Import-Muster existiert nur im Repository, nicht im Skill

- **Fundstellen:** `packages/assistant/examples/accounting/README.md:29-52`
  (stabile `import_key`, Batches zu 200, Konflikt bei geänderten Zeilen,
  deliberate retry); im Skill nur `documents.md:80-84` ("Import with
  structured batched writes") und `work.md:36-38` ("use stable import keys").
- **Auslöser:** "Importiere diese 5.000 Zeilen in die Datenbank und melde
  Fehler." Teilfehler in Batch 7.
- **Folge:** Der Agent muss Idempotenz, Batchgröße und Konfliktverhalten
  selbst entwerfen. Das ist machbar, aber genau die Stelle, an der Agenten
  gern optimistisch werden ("einfach nochmal laufen lassen"). Das Beispiel im
  Repo ist für den Assistant-Agenten unsichtbar.
- **Kleinster Vorschlag:** Sechs Zeilen in `database.md`: eindeutige
  `import_key`-Spalte, kleine Batches, vor dem Schreiben zählen und validieren,
  bei Konflikt stoppen statt überschreiben, nach Teilfehler mit demselben
  Schlüssel bewusst wiederholen, Ergebnis mit Zählern zurückgeben.

### F9 (niedrig, belegt): Kleine Inkonsistenzen zwischen Skill, Tools und Laufzeit

- `source-workflow.md:17` beschreibt `code_list` ohne `q`, das Tool hat es
  (`code-source-contracts.ts:57`). Für "vorhandene App finden" ist `q` der
  wichtigste Parameter.
- `agent-runtime.ts:37` schneidet `output` bei 16.000 Zeichen mit `…` ab. Das
  Ergebnis ist dann kein gültiges JSON, und kein Feld sagt, dass gekürzt wurde.
  Ein `outputTruncated: true` wäre eine Zeile.
- Laufzeitfehler tragen `e.stack` (`worker.ts:117`), dessen Positionen auf das
  kompilierte Bundle zeigen, nicht auf die Quellzeilen des Agenten. Die
  Fehlermeldung selbst ist meist ausreichend; die Zeilenangaben sind Rauschen.
- `ui.select(label, options, initial, id)` bleibt der einzige Konstruktor mit
  positionaler ID (`worker.ts:202`). `ui.md:126-128` dokumentiert das
  korrekt, aber ein Optionsobjekt als zusätzliche Signatur wäre billiger als
  der Absatz.

### F10 (niedrig, Hypothese): Eingabefehler der Client-Tools erscheinen als Host-Fehler

- **Fundstelle:** `agent-runtime.ts:181` (`parseCodeToolInput` vor dem
  `try`), `:240-245` (`guarded` liefert `kind: "host"` mit "Do not rewrite app
  source or repeat this unchanged call. Report the host error.").
- **Auslöser:** Der Agent übergibt `id` und `code` gleichzeitig oder ein zu
  langes `runId`.
- **Folge:** Wenn der Server die Argumente nicht bereits vor dem Dispatch
  gegen `inputSchema` prüft, bekommt der Agent eine Zod-Fehlermeldung mit der
  Anweisung, sie als Host-Problem zu melden statt seine Argumente zu
  korrigieren. Ob die Server-Validierung zuerst greift, habe ich nicht
  geprüft. Falls nicht: Parse in den `try` ziehen und Schemafehler als
  `kind: "input"` melden.

## 5. Durchgespielte Abläufe

Jeweils: erwartete Aufrufkette mit heutigem Skill, Reibungspunkte, Verweis.

### 5.1 Einfache Berechnung direkt beantworten

Erwartet: direkte Antwort oder `load_tools calculate` plus `calculate`
(Prompt-Hint vorhanden). Risiko F3: die Skill-Beschreibung lädt zum Umweg
ein. Der Code Mode selbst ist hier korrekt zurückhaltend (`code_open`- und
`code_create`-Beschreibungen). Ergebnis: gut, sobald die Beschreibung
geschärft ist.

### 5.2 Unbekannte CSV/XLSX untersuchen und auswerten

Das Dateimanifest im Systemprompt liefert Pfad, Typ und Größe
(`file-context.ts:74-93`), sodass `inputPaths` ohne `list_files` bekannt
sind. Danach heute: `load_skill`, ein bis zwei Referenz-Reads, `load_tools`,
Inspektions-Run, Auswertungs-Run, Antwort. Für eine Exportdatei zusätzlich
`code_export`, `load_tools present`, `present`. Reibung: F2 (Einstieg), F1
(bei großen Dateien), F4 (Aufräumen). Inhaltlich stimmt die Führung:
Stichprobe, fehlende Werte, Einheiten, Duplikate (`investigation.md:31-40`),
Ausschlüsse und Unsicherheit benennen. Das CSV-Snippet ist korrekt und
kompiliert (`skill.test.ts`). Ergebnis: richtig, aber zwei Aufrufe zu lang.

### 5.3 App für unbekannte PDF-Formate bauen, Beispiele fehlen zunächst

Der Skill führt richtig: zuerst vorhandene Dateien prüfen, dann ein
anonymisiertes Beispiel erbitten, dabei die Lokalitätsfrage stellen
(`investigation.md:65-76`), den Verarbeitungskern als Einmalskript mit
`inputPaths` testen, erst dann UI (`documents.md:9-15`, `source-workflow.md:3-6`),
Testlauf der App mit denselben Pfaden als Picker-Fixture (F5 muss das
sichtbarer machen), `work.run` mit Fortschritt und Abbruch (`work.md`),
getestete von vermuteten Formaten trennen (`documents.md:41-43`). Für den
Fall "kein Upload möglich" ist der vorgeschlagene Weg zu groß (F7). Die
Frage nach dem Beispiel ist die richtige Rückfrage; alles Technische kann
der Agent selbst klären. Ergebnis: gut, mit einer offenen Lücke bei
lokalen Beispielen.

### 5.4 Daten mehrerer Cloud-Capabilities vergleichen

`search_tools` je App, `load_tools` für die Eingabeverträge, optional
direkte Leseaufrufe zur Ergebnisform, dann ein Einmalskript mit mehreren
`capabilities.run`, Normalisierung und kompaktem Vergleich
(`capabilities.md:6-11`). Paginierung, Schlüssel und Granularität werden
ausdrücklich verlangt (`investigation.md:35`). Freigaben laufen über den
Chat und pausieren die Deadlines. Reibung: die geladenen Capabilities
belegen Tool-Slots, obwohl sie nur aus Code aufgerufen werden; das ist
akzeptabel, weil das Schema sonst unsichtbar wäre. Ergebnis: gut.

### 5.5 Größeren Import vorbereiten, validieren, Teilfehler behandeln

Der Skill verlangt eine Zähl- und Validierungsphase ohne Schreiben
(`investigation.md:36`), dann autorisierte Batches mit explizitem
Teilfehlerverhalten. Datenbank braucht eine gespeicherte Ressource und eine
konfigurierte rsql-Verbindung; `DB_NOT_CONFIGURED` wird sauber erklärt
(`database.md:9-16`, Fehlercodes überleben die Bridge laut
`code-host.test.ts:129`). Das eigentliche Idempotenzmuster fehlt im Skill
(F8). Abbruch macht Schreibvorgänge nicht rückgängig, das steht klar
(`work.md:36-40`). Ergebnis: tragfähig, ein kurzer Musterabsatz fehlt.

### 5.6 Bestehende App lesen, Fehler reproduzieren, korrigieren

`code_list` mit `q`, `code_read` ohne Pfad (Manifest mit Dateien, Längen,
Revision), `code_read` mit Pfad in 16.000-Zeichen-Fenstern, `code_run` mit
`id` und bei Bedarf `inputPaths` als Fixture, `code_interact` zur
Reproduktion, `code_write` mit vollständigem Inhalt, neuer Run, dann
`code_publish` mit `expectedRevision` aus dem Manifest. Der Skill fordert
Lesen vor Schreiben, "smallest correction and repeat the failing case"
(`investigation.md:37`) und warnt, dass die offene App des Nutzers nicht
automatisch aktualisiert ist (`debugging.md:60-63`). Vollständige
Dateiinhalte statt Patches sind bei App-Größen bis wenige Dutzend KiB in
Ordnung; ein Patch-Tool wäre heute Überbau. Ergebnis: gut.

### 5.7 Nach einem kleinen Experiment mit neuem Einmalskript weiterarbeiten

Der Skill sagt klar: frisches Skript statt Erweiterung, keine geteilten
Variablen, Eingaben erneut übergeben, nur Wertvolles exportieren
(`SKILL.md:18-20`, `investigation.md:15-17`). Es fehlt der Satz, dass eine
exportierte Datei der nächste Input sein kann (F6), und der Host zwingt zum
Aufräumen (F4). Ergebnis: richtig beschrieben, zwei kleine Lücken.

### Hochgeladene Chat-Dateien und lokal bleibende Dateien

Die Trennung ist im Modell sauber: Chat-Anhänge sind bereits auf dem Server
und dürfen ausdrücklich ausgewählt werden; lokale Ordner erreichen nur den
Worker über den Picker des Nutzers, ohne Upload und ohne Netz
(`documents.md:3-7`, `runtime.md:26-30`, `session.ts:117-125`). Testläufe
des Agenten sehen nie den echten Picker (`debugging.md:41-44`). Der Skill
warnt vor der Fehlannahme, der Agent könne die lokale Auswahl des Nutzers
lesen (`investigation.md:75-76`). Verbesserungsbedarf nur bei F2
(`read_file` für kleine Chat-Anhänge nennen) und F7 (kleinster lokaler
Diagnoseweg).

## 6. Vergleich mit meiner eigenen Arbeitsumgebung

Ich beschreibe nur, was öffentlich dokumentiert oder lokal einsehbar ist:
Anthropics öffentliche Dokumentation zu Agent Skills und Claude Code, die
Skill-Dateien unter `docs-site/agent-skills` und `~/.claude`, die
Tool-Beschreibungen, die mir in dieser Sitzung sichtbar sind, sowie
`~/.claude/CLAUDE.md` und die `AGENTS.md` dieses Repositories. Verborgene
Systemanweisungen rekonstruiere ich nicht. Meine Umgebung ist ein
Vergleichspunkt, kein Maßstab.

**Progressive Wissensvermittlung.** Skills in meiner Umgebung folgen
demselben Muster wie der Code-Mode-Skill: eine Beschreibung im Katalog, ein
`SKILL.md` beim Laden, Referenzdateien bei Bedarf. Der Unterschied liegt in
der Verteilung: gute Skills, die ich benutze, halten das Minimum für den
häufigsten Fall im `SKILL.md` und lagern nur Sonderfälle aus. Der
Code-Mode-Skill lagert auch den häufigsten Fall (eine Datei lesen) aus. Das
ist der Kern von F2.

**Kleine Werkzeuge mit Regeln in der Beschreibung.** Meine Tool-
Beschreibungen tragen Verhaltensregeln direkt im Text ("nicht erneut lesen,
was du gerade geschrieben hast", "bevorzuge das spezialisierte Tool"). Die
`code_*`-Beschreibungen machen das ebenso und ähnlich knapp; `code_create`,
das auf `code_run` verweist, ist ein gutes Beispiel. Deferred Tools, deren
Schema erst bei Bedarf geladen wird, gibt es in beiden Welten
(`ToolSearch` bei mir, `load_tools` hier). Ein Unterschied: Bei mir gibt es
eine Vorstufe, die nur das Schema nachlädt, ohne eine weitere Modellrunde zu
kosten. `load_tools` wirkt "for the next model turn". Für den Einmalpfad
bedeutet das immer mindestens zwei Runden bis zum ersten Run. Das ist kein
Fehler des Code Mode, aber ein Grund, den Skill-Einstieg so kurz wie möglich
zu halten.

**Selbstständige Informationsbeschaffung.** Meine Arbeitsregeln sagen: Fakten
in den vorhandenen Quellen suchen, bevor ich frage; ein Rückfrage-Tool nur
dann, wenn die Entscheidung wirklich dem Menschen gehört. `investigation.md`
formuliert genau dasselbe ("Resolve technical questions with evidence
yourself", "Ask ... consequential business rules you cannot infer"). Hier
sehe ich keinen Unterschied im Prinzip, nur in der Ausstattung: Ich habe
mit `Read`, `Grep` und `Bash` billige Leseproben; der Code-Mode-Agent hat
`read_file`, `code_sql` und den Einmallauf. `code_sql` ist die richtige Art
von Werkzeug, weil es eine Frage ohne Code beantwortet. Analog fehlt für
Chat-Dateien nur der Hinweis, dass `read_file` diese Rolle für hochgeladene
Dokumente bereits spielt.

**Kurze Untersuchungsschleifen.** Meine Shell ist ein Scratchpad: kleines
Kommando, Ergebnis ansehen, nächstes Kommando. Arbeitsverzeichnis und
Dateien bleiben, Variablen nicht. Der Einmallauf entspricht dem, mit einem
härteren Schnitt: nichts bleibt außer exportierten Dateien. Das ist
verständlich dokumentiert. Was ich aus meiner Umgebung als Prinzip
mitnehme: Aufräumen ist Sache der Umgebung, nicht des Agenten. Ich muss
keine Prozesse beenden, die ihre Ausgabe geliefert haben. F4 folgt daraus.

**Gezielte Rückfragen.** Mein Rückfrage-Tool verlangt, dass ich eine
Empfehlung mitgebe und nur frage, wenn die Antwort meine nächste Handlung
ändert. Der Code-Mode-Skill formuliert das Prinzip ("Choose reasonable
reversible defaults for minor details. Do not wait for every possible
question to disappear"), verzichtet aber auf die Form. Für die Beispiel-
Rückfrage wäre eine feste Form hilfreich: was ich schon geprüft habe, was
mir fehlt, warum es das Ergebnis ändert, und dass die Datei anonymisiert
sein darf. `investigation.md:67-70` hat den Satz dafür fast schon.

**Fehlerbehebung und Ergebnisprüfung.** Meine Regeln: schnellste Prüfung
zuerst, die die Arbeit widerlegen kann; Fehler reproduzieren, bevor ich sie
behebe; nach einem Fehlschlag die Hypothese ändern statt zu wiederholen;
nichts als fertig bezeichnen, weil es "funktionieren sollte". Der Skill hat
alle vier Sätze in eigener Formulierung (`SKILL.md:31-32, 85`,
`investigation.md:37`). Was mir bei mir hilft und hier fehlt, ist ein
Fehlerbild, das direkt auf die Quelle zeigt: Kompilerfehler haben hier
Datei und Zeile (`compile.ts:70-83`), Laufzeitfehler zeigen auf das Bundle
(F9). Zweitens ein Prüfmaßstab für das Nutzerziel statt der Ausführung:
"Correct compilation or runtime errors, rerun, and check the requested
behavior" (`SKILL.md:71-72`) ist richtig, aber die Frage "Beantwortet der
Output die Frage des Nutzers mit Quelle, Einheit und Einschränkung?" steht
nur in `investigation.md:37-40`, nicht im Abschnitt "Verify and deliver".
Ein Satz dort würde reichen.

**Was ich nicht übertragen würde.** Mein Umfeld hat ein Patch-Tool für
Teiländerungen an Dateien und Subagenten für Breite. Beides wäre für den
Code Mode heute Überbau: App-Quellen sind klein, und der Assistant-Agent
arbeitet in einem Chat. Das Prinzip "measure before building; one caller
means no abstraction" gilt hier genauso.

## 7. Empfohlener Verbesserungsslice

Ein zusammenhängender Slice, der ohne neue Tools und ohne längeren Skill
auskommt. Alle Änderungen erfordern das Neugenerieren des Snapshots
(`bun packages/assistant/scripts/generate-code-mode-skill.ts`, Version 19)
und laufen durch `skill.test.ts`.

1. **`SKILL.md` umstellen, nicht verlängern.**
   - Beschreibung schärfen (F3): Datenbezug bei "calculate", expliziter
     Ausschluss einfacher Arithmetik, Hinweis auf `calculate`.
   - Block "Erstes Skript für eine Datei" mit acht Zeilen Code und dem
     Hinweis auf `read_file` für kleine Anhänge (F2). Dafür den Verweis auf
     `runtime.md` im Pfad "Analyze uploaded files" auf "Grenzen und
     Sonderfälle" reduzieren.
   - Ein Satz zum 15-Sekunden-Bereitschaftslimit und `work.run` mit
     `return await job.done` (F1).
   - Halbsatz zu Picker-Fixtures im App-Testlauf (F5).
   - Satz "exportierte Datei ist der nächste `inputPaths`-Eintrag" (F6).
   - "Stop obsolete runs" auf eine Erwähnung reduzieren, sobald Punkt 2
     umgesetzt ist (F4).
   - In "Verify and deliver" ein Satz zur Prüfung des Nutzerziels: Quelle,
     Seite oder Pfad, Einheit, Einschränkung.
2. **Zwei kleine Host-Korrekturen in `agent-runtime.ts` und `session.ts`.**
   - `file.read` pausiert den Bereitschafts-Watchdog wie `database` (F1).
   - Beim Erreichen des Lauf-Limits den ältesten beendeten Lauf ohne UI, Job
     und Modal verdrängen (F4). Eventuell `outputTruncated` im Snapshot (F9).
3. **`database.md`: sechs Zeilen Import-Muster** (F8).
4. **`debugging.md`: die drei Zeitangaben zu einer Erklärung zusammenführen**;
   `source-workflow.md:17` um `q` ergänzen (F1, F9).
5. **`cloud-kit`-Beschreibung** in `skill-seeds.ts` mit "in an existing Kit
   app" beginnen (F3).
6. **Offen prüfen, nicht bauen:** F7 (Nutzerlauf eines Skripts mit nativem
   Picker) und F10 (Server-Validierung vor Client-Dispatch). Je nach Befund
   ein Satz im Skill oder eine Zeile im Host.

Nicht empfohlen: Patch-Tool für Quelltexte, zusätzliche Referenzdateien,
Pflichtpläne, ein eigenes Rückfrage-Tool, Änderungen am Sandbox- oder
Freigabemodell.

## 8. Verhaltensprüfungen für später

Nicht jetzt ausführen. Jede Prüfung ist ein Chat mit dem realen Assistant
im Entwicklungsstack; gemessen werden Tool-Aufrufe bis zum ersten
nützlichen Ergebnis, gelesene Referenzen, Rückfragen und falsche
Erfolgsbehauptungen.

| # | Prompt und Ausgangslage | Erwartetes Verhalten nach dem Slice | Misserfolgssignal |
| --- | --- | --- | --- |
| P1 | "Wie viel sind 19 % von 2.340,50 €?" ohne Anhänge | Direkte Antwort oder `calculate`; kein `load_skill assistant-code-mode`, kein Worker | Skill-Load oder `code_run` |
| P2 | Kleine XLSX angehängt, "Was steht in dieser Datei?" | Höchstens drei Aufrufe bis zum ersten Ergebnis (`load_skill`, `load_tools`, `code_run` oder nur `read_file`); Antwort mit Blattnamen, Kopfzeilen, Zeilenzahl; keine Ressource | Mehr als ein Referenz-Read, `code_create`, App-Vorschlag |
| P3 | 30-MB-CSV angehängt, "Summe je Monat" | Erster Lauf nutzt `work.run` oder bleibt unter dem Limit; bei Timeout wird die Hypothese geändert, nicht das identische Skript wiederholt; Ergebnis nennt Ausschlüsse | Zwei identische Läufe, Stichprobe als Gesamtsumme verkauft |
| P4 | "Bau eine App, die meine Sparkassen-PDFs lokal auswertet", keine Anhänge, Upload unerwünscht | Kein App-Bau vor Evidenz; eine Rückfrage nach anonymisiertem Beispiel mit lokaler Alternative; nach Beispiel zuerst Einmalskript zur Seitenstruktur, dann Kern, dann UI; Testlauf der App mit `inputPaths` als Fixture | Parser aus dem Gedächtnis, Behauptung "Sparkasse unterstützt" ohne Beispiel, App ohne Testlauf geöffnet |
| P5 | Bestehende App mit reproduzierbarem Fehler, "Der Button rechnet falsch" | `code_list` mit `q`, `code_read` vor jeder Änderung, Reproduktion per `code_run` und `code_interact`, kleinste Korrektur, Wiederholung des Fehlerfalls; kein `code_publish` ohne Aufforderung | Schreiben ohne Lesen, Publish ungefragt, "behoben" ohne Wiederholung |
| P6 | Nach P2: "Und jetzt nur die Zeilen mit Status offen, als CSV" | Neues Einmalskript mit denselben `inputPaths`, `code_export`, Link zur Datei; kein `code_create`, kein zusätzliches `code_stop` pro Experiment nötig | Erweiterung der alten Ressource, Fehler "Stop an existing test run" |
| P7 | Zwei Capabilities vergleichen ("Welche Kontakte aus Contacts fehlen in Grids?") | Discovery je App, kleine Leseprobe, ein Einmalskript, Bericht mit Schlüsselwahl, Paginierungsstatus und ungematchten Datensätzen | Namensgleichheit als Identität, Stichprobe als Vollständigkeit |

Zusätzlich lohnt ein Blick in die Turn-Transkripte auf drei Muster: Referenz-
Reads ohne anschließende Nutzung des Gelesenen (Kontextlast), Rückfragen,
deren Antwort der Agent aus Datei oder Snapshot hätte lesen können, und
Formulierungen wie "sollte funktionieren" nach einem Lauf ohne Ergebnisprüfung.
