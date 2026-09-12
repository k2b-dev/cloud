# Studio: manuelle Werkzeuge und Datenverwaltung

Stand: 12. September 2026. Implementiert; gezielte Abnahme siehe unten.
Der vorherige Assistant-Stand ist mit `3369002b2` committet.

## Ziel

Studio bietet neben dem normalen Starten und Bearbeiten mit Assistant einen
unaufdringlichen manuellen Zugang. Gestaltung und Interaktion orientieren sich
an Kit; Implementierung, Berechtigungen, Routen und Daten gehören vollständig
Assistant. Kit bleibt unverändert und darf keine Laufzeitabhängigkeit werden.

## Ausgangslage vor der Umsetzung

| Bereich | Kit heute | Assistant Code Mode heute | Empfehlung |
| --- | --- | --- | --- |
| Codeeditor | Highlighting, Undo/Redo, Tastenkürzel | `SourceEditor` enthält bereits denselben grundlegenden Editor | Bestehenden Editor erweitern, keinen neuen Editor einführen |
| Autorenansicht | Mehrdatei-Tabs, Hinzufügen/Umbenennen/Löschen, Ausführung daneben, Zustand je Datei | Bearbeitbare einzelne Source-Tabs im Chat; Studio-Runner ohne vollständige Autorenansicht | Schlanke eigenständige Studio-Editoransicht |
| SQL-Konsole | SQL-Editor, Abbrechen, Resultate, Tabellen/Schema, Laufzeit/Zeilenzahl, CSV-Export | `code_sql`, CLI und serverseitige SELECT-/Schema-/Rows-APIs, keine Konsole | Oberfläche auf bestehendem Assistant-Datenbankservice |
| Gespeicherte Abfragen | Eigene versionierte Query-Ressourcen, eigene Sidebar | Kein entsprechendes Query-Modell | Zunächst SQL-Entwurf lokal pro Ressource behalten; gemeinsame gespeicherte Queries später |
| Lokale Daten | Explorer für Dateien/KV, Download, Einzel- und Komplettlöschung | `ArtifactStorage` kann lesen/listen/löschen/clear, aber keine Nutzerverwaltung | Modal auf bestehendem Storage |
| Geteilte Dateien/KV | Kein gleichwertiger separater Postgres-Datei-/KV-Store | Resource-Store bereits vorhanden, Runtime und CLI | Admin-Verwaltungsmodal ergänzen |
| Datenbankverwaltung | Status, Statistiken, Aktivierung, Reset, SQLite-Export | Lazy connect, globale rsql-Einstellungen, Admin-Inventar; kein Ressourcen-Reset/Export/Statusdialog | Kleiner Ressourcendialog, Lazy connect beibehalten |
| Seitenmodell | Mehrere `*.script.js`-Einstiege und Markdown-Seiten | Eine JS/TS-Entry pro App/Skript, normale Source-Dateien | Nicht übernehmen: bewusste Produktentscheidung |
| Hilfesystem | In-App-Hilfe und SDK-Referenz | Aufgabenspezifischer Skill mit Referenzen | Skill pflegen, Kit-Hilfe nicht portieren |

Kit besitzt außerdem einen speziellen Import-Helper mit Typableitung/Fortschritt.
Assistant verwendet strukturierte DB-Operationen, Hintergrundarbeit und das
bestehende Import-Beispiel. Vollständige SDK-Gleichheit und ein neuer Import-
Assistent sind nicht Teil dieses UI-Slices. PDF/XLSX, Einmalskripte, Publikationen,
Forks und Capability-Verkettung müssen für diese Oberflächen nicht neu gebaut werden.

Quellen: `packages/kit/src/frontend/{Editor,EditorWorkspace,QueryConsole.island,LocalFiles,DatabasePanel}.tsx`,
`packages/kit/src/{contracts,database-import}.ts`,
`packages/assistant/src/artifacts/{SourceEditor,SourceRenderer,Workspace,Apps.island,ArtifactPanel}.tsx`,
`packages/assistant/src/artifacts/{service,database,admin,api}.ts`,
`packages/assistant/src/artifacts/runtime/storage.ts`.
Öffentliche UI-Verträge: Fibel `/en/ui/layout/workspace`, `DropdownSection`
in `packages/ui/src/actions/Dropdown.tsx`.

## Navigation und Layout

- Das Studio-Dots-Menü bekommt eine **Gruppe „Erweitert“**. Das existierende
  Dropdown unterstützt `sectionLabel`; kein neues verschachteltes Menü nötig.
- Normales „Bearbeiten“ heißt eindeutig **„Mit Assistant bearbeiten“** und
  behält den bisherigen Chat-Workflow.
- Erweitert enthält **„Manuell bearbeiten“**, **„SQL-Konsole“**,
  **„Lokale Daten …“**, **„Geteilte Daten …“**, **„Datenbank verwalten …“**.
- Dieselben Aktionen sind in der gestarteten App erreichbar, damit niemand
  zum Bereinigen lokaler Daten zuerst zur Kachelübersicht zurück muss.
- Echte, SSR-geladene Ansichten: bestehendes `/app/assistant/apps/:id`, neu
  `/app/assistant/apps/:id/edit` und `/app/assistant/apps/:id/database`.
  Auswahl einer Source-Datei bzw. Tabelle kann als validierter Query-Parameter
  reloadbar sein. SQL-Text und Daten gehören nicht in die URL.
- **Ein Assistant-AppWorkspace, eine AssistantSidebar.** Chats, Projekte und
  Studio links bleiben wie bisher. Kit-Seiten nicht mitsamt ihrem AppWorkspace
  einbetten. Tool-Inhalte belegen nur den Hauptbereich.
- Oben kompakt: Icon/Titel, Ansichten-Dropdown „App / Code / SQL“, Aktionen.
  Dateiauswahl und Tabellenauswahl erfolgen innerhalb der Seite über Dropdowns
  und horizontale, scrollbare Tabs. Keine zweite linke Navigationsleiste.
- Primärbereich ohne Doppel-Scrollport; kleine Abstände, gleiche Paper-/Editor-
  Tokens wie Kit. Bei knapper Breite wechselt „Code / Ausführung“ zwischen
  gleichwertigen Ansichten. Zustand bleibt erhalten; keine frei verschachtelbaren
  Pane-Gruppen und kein IDE-Funktionsumfang.

## Editor

- `SourceEditor` und vorhandenen Source-/Konfliktpfad wiederverwenden. SQL-
  Highlighting und Cmd/Ctrl+Enter ergänzen, Cmd/Ctrl+S sowie Undo/Redo erhalten.
- Dateidropdown, Dateiaktionen und stabile Editorsitzungen je Datei; Cursor,
  Undo und Scrollposition gehen beim Wechsel nicht verloren.
- Hinzufügen, Umbenennen und Löschen verwenden die kanonische Source-Struktur.
  Umbenennen relativer statischer Imports muss Parser-basiert geschehen; kein
  globales String-Ersetzen. Falls nötig, Kits geprüfte Logik in Assistant
  übernehmen und auf TS sowie Assistant-Entry anpassen. Keine Kit-Imports.
- Explizites Speichern als Arbeitsstand mit Konfliktprüfung; nachlaufende
  Tastatureingaben während des Requests bleiben erhalten. Kein Publish on save.
- Ausführung des gespeicherten Arbeitsstands explizit starten, neben dem Editor;
  ungespeicherte Änderungen klar kennzeichnen. Keine automatische Ausführung
  durch Öffnen, Tippen, Speichern oder Ansichtenwechsel. Vor dem Start ggf.
  speichern und erst die bestätigte Source-Revision starten.
- Runtime, Logs, Abbrechen und Freigaben wiederverwenden. Lokale Testdaten
  bleiben isoliert wie im vorhandenen Testlauf; geteilte Daten und externe
  Capability-Effekte sind weiterhin real und werden klar benannt.
- Versionsauswahl und Veröffentlichungen bleiben im vorhandenen Modell.
  Skripte können denselben Editor nutzen, mit Ausgabe statt App-Oberfläche.

## SQL-Konsole

- **Nur SELECT**, auch für Admins, über den bestehenden Validator/Service.
  Kein zusätzlicher SQL-Interpreter, kein Proxy mit frei wählbarem Namespace.
- SQL-Eingabe, Ausführen/Abbrechen, Ergebnis-DataTable, Zeilenzahl/Laufzeit,
  Export der tatsächlich geladenen Zeilen; gekürzte Ergebnisse kennzeichnen.
- Tabellen-Dropdown plus „Daten / Schema“, Ergebnisse/Schema wie Kit. Schema
  bedarfsgerecht laden statt bei jedem Öffnen sämtliche Tabellen abzufragen.
- Statusabfrage ist lesend und erstellt keine DB. Ohne Datenbank: Placeholder
  mit explizitem „Datenbank verbinden“. Ohne Instanz-Konfiguration: klare
  Erklärung statt wirkungslosem CTA oder endlosem Spinner.
- Keine Datenbank pro Source-/Publish-Version. Alte App-Versionen verwenden
  dieselben aktuellen Daten. Das muss die Ansicht verständlich erklären.

## Drei Daten-Modals und Rechte

| Funktion | Use-Nutzer | Ressourcen-Admin | Plattform-Admin |
| --- | --- | --- | --- |
| Eigene lokale Dateien/KV ansehen, herunterladen, löschen | Ja | Ja, nur eigene lokale Daten | Keine fremden Browserdaten |
| Manuell bearbeiten, SQL-Konsole | Nein | Ja | Nur über bestehenden administrativen Zugriff |
| Geteilte Dateien/KV direkt verwalten | Nein | Ja | Über bestehenden Admin-Zugriff |
| Ressourcen-DB Status/Export/Reset verwalten | Nein | Ja | Über bestehenden Admin-Zugriff |
| Globale rsql-URL und Secret ändern | Nein | Nein | Ja, nur AI-Administration |

„Admin“ bedeutet bei Ressourcen **Manage-Grant aus der Cloud-Access-Tabelle**,
nicht zwingend Plattformrolle. UI, SSR, API und CLI müssen denselben Service
aufrufen. Versteckte Menüpunkte allein sind keine Zugriffskontrolle.

Normale Runtime-Zugriffe bleiben erhalten: Use-Nutzer dürfen über eine laufende
App geteilte Daten lesen/schreiben. Die neuen Verwaltungs-/Reset-Endpunkte
fordern Admin. Bestehende Runtime-Endpunkte pauschal auf Admin zu verschärfen
würde normale Apps beschädigen. Die Verwaltungsansichten sind keine neue
Daten-Geheimhaltungsgrenze gegenüber Code, der diese Daten selbst verwendet.

- **Lokale Daten:** Files/KV-Auswahl, Einträge, Download, Einzel löschen,
  „Meine lokalen Daten löschen“. Nur aktuelle Origin + Browserprofil +
  Benutzer + Ressource. Keine Versionsverzeichnisse, keine Löschung anderer Apps.
  Bestehende lokale Läufe vor Löschung stoppen und angenommene Writes abwarten.
  Hinweis: andere laufende Tabs können anschließend wieder Daten anlegen;
  kein versprochener globaler Stopp. Fehlendes OPFS und Quota-Fehler verständlich.
- **Geteilte Daten:** paginierte Metadaten statt alle Inhalte vorab laden;
  Dateien/KV gezielt ansehen/herunterladen/löschen, klare Einzel-/Gesamtbestätigung.
  Atomarer Admin-Clear für einen Bereich oder beide, nie Datenbank und Source
  implizit mitlöschen. Aktive Apps können später wieder schreiben.
- **Datenbank verwalten:** Status und Größe/Tabellenzahlen soweit verfügbar,
  SQLite-Backup als Stream, expliziter Reset mit Auswirkung für alle Nutzer.
  Kein rsql-Token und keine globale Verbindung im Ressourcendialog.

## Reset, Lebenszyklus und CLI

- Reset löscht DB-Schema und Daten, nicht Source, Publikationen oder Files/KV.
  Rückkehr zu „noch nicht verbunden“; erst explizites `connect()` erzeugt die
  neue leere Datenbank. App-Initialisierung kann dann ihr Schema neu anlegen.
- Vorher Backup anbieten. Ein Source-Rollback stellt keine Daten wieder her.
- Bestehenden Ressourcen-Lock, Konfigurations-Lock und Cleanup-Queue nutzen.
  Beim Reset alte Zuordnung transaktional abtrennen und Cleanup einplanen.
  Für Neuverbindung eine neue eindeutige Namespace-Generation verwenden:
  der bisher deterministische Name darf nicht wiederverwendet werden, solange
  dessen Cleanup noch aussteht. Auch Wiederholung, Remote-Ausfall und laufende
  Requests müssen sicher sein; UI wartet nicht endlos auf Remote-Löschung.
- Kein breites neues State-Machine-Framework und kein neuer SDK-Reset-Call.
- Remote-Verwaltung vollständig auch per `cld assistant code …`: Status,
  Backup, bestätigter Reset sowie Storage-Inventar/Clear. Bestehende Source-
  und SELECT-Kommandos wiederverwenden; kleine separate Befehle statt Mega-Schema.
- Lokale Browserdaten sind eine notwendige CLI-Grenze: eine headless CLI besitzt
  nicht das OPFS des eingeloggten Browserprofils. Keine vorgetäuschte Remote-
  Purge-Funktion. CLI kann auf die lokale Datenansicht verweisen; echter Zugriff
  auf dieses Browserprofil würde später eine explizite Browser-Brücke benötigen.

## Umsetzung und Abnahme

1. Gemeinsamer Studio-Rahmen, SSR-Ansichten, gruppiertes Aktionen-Menü und Rechte.
2. Mehrdatei-Editor mit Arbeitsstand, Ausführung und Konflikt-/Navigationsschutz.
3. SELECT-Konsole und Tabellen-/Schemaansicht.
4. Lokales Datenmodal mit begrenztem Zugriff auf die eigenen OPFS-Daten.
5. Admin-Verwaltung geteilter Files/KV, Ressource-DB Status/Backup/Reset und CLI.
6. Fibel/Skill/CLI-Doku und gezielte Abnahme: Admin/Use/ohne Zugriff, Reload/
   Direktlinks, schmale Darstellung, langsame Requests, Konflikt beim Speichern,
   Reset bei Remote-Ausfall und parallel laufender Anfrage, sauberes Cleanup.

Gezielte Service- und wenige Browsertests genügen. Kein kompletter Testlauf
aller Cloud-Apps. Die bestehende CLI-Host-Timeout-Untersuchung und die offenen
Rollout-Abnahmen bleiben separate Voraussetzungen für einen Produktionsrollout.

Nicht im ersten Slice: gemeinsam gespeicherte Queries, Datenbank-Import/
Restore, Markdown-Seiten, mehrere App-Entrypoints, neue Agenten-Tools und eine
Migration bestehender Kit-Apps. Diese Punkte werden nicht stillschweigend
als bereits vorhandene Feature-Parität bezeichnet.

## Abnahme der Umsetzung

- Advanced-Menü auf Kacheln und im Runner; eigene SSR-Ansichten für Editor und
  SQL innerhalb der unveränderten Assistant-Navigation. Authentifizierte
  Live-Requests für Studio, Editor und Datenbankansicht: HTTP 200 mit SSR-Inhalt.
- Mehrdatei-Editor mit explizitem Speichern/Starten, TS/JS-Import-Rename,
  Konflikterhalt, Datei-Sitzungen, Testdateien, Modals und exportierten Ergebnissen.
- SELECT-Konsole, drei Daten-Modals und Remote-CLI-Verwaltung. Reset verwendet
  eine bestätigte Verbindungsgeneration; eine veraltete Wiederholung kann
  keine neu verbundene Datenbank löschen. Aufgelöste Namespace-Namen bleiben
  serverseitig; Status liefert nur einen Vergleichswert.
- 27 Integrationstests mit wegwerfbarem Postgres und echtem rsql: 220 Assertions,
  einschließlich SQLite-Backup, wiederholtem Reset, neuer Verbindung und Cleanup.
- 9 fokussierte Tests für Studio, Editor, Rename und Skill: 54 Assertions;
  darin zwei Browserfälle. Zusätzlich zwei gezielte CLI-Tests: 7 Assertions.
- Browser-Abnahme prüft Eingaben während Save, Undo nach Dateiwechsel,
  tatsächlichen Worker-Start, Modal/Dateiausgabe, schmalen Ansichtenwechsel,
  SQL-Ergebnis/CSV und lokale Löschung ohne fremde Nutzerdaten anzutasten.
  Eine Layout-Aufnahme wurde visuell geprüft.
- Assistant-Typecheck, Dependency-Policy, Skill-Generator-Check und Diff-Check
  bestanden. Fibel-App-Doku, CLI-Referenz und gezielt ladbare Skill-Referenzen
  aktualisiert (Skill-Vorlage 22). Harper-Hinweise betreffen überwiegend
  etablierte Fachbegriffe, Einheiten und Überschriften; keine mechanische Korrektur.

Die lokale Cloud hat keinen rsql-Server konfiguriert. Dieser Zustand wurde über
die neue CLI und SSR geprüft; erfolgreiche DB-Operationen wurden ausschließlich
gegen die isolierte Testinstanz ausgeführt. Bestehende Nutzer-Datenbanken wurden
nicht zurückgesetzt. Die bereits zuvor bekannte intermittierende CLI-Host-
Timeout-Untersuchung bleibt außerhalb dieses Epics offen.
