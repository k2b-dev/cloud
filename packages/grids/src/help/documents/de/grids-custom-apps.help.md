---
id: grids-custom-apps
title: Grids Apps
icon: ti ti-app-window
description: Fokussierte Apps aus Formularen, begrenzten Datensätzen und Datensatzdetails veröffentlichen.
order: 137
---
Grids Apps stellen angemeldeten oder öffentlichen Zielgruppen unter `/apps/<id>` eine fokussierte App bereit, ohne den vollständigen Grids-Arbeitsbereich offenzulegen. Jede App gehört zu einer Basis und verwendet ausgewählte Datensätze, Ansichten, Formulare, Dokumente und Aktionen dieser Basis. Definitionen sind portables YAML, das du mit der Cloud CLI validieren, prüfen und veröffentlichen kannst.

Grids Apps kopieren keine Daten. Eine Veröffentlichung speichert eine unveränderliche Definition und einen kompilierten Capability-Snapshot mit den exakten Ressourcen, die sie verwenden darf. Jede Anfrage prüft App-Freigabe, veröffentlichte Capability und serverseitig durchgesetzte Verfügbarkeitsregeln. Lesende Personen der App benötigen keinen Basiszugriff; App-Zugriff gewährt niemals unmittelbaren Zugriff auf Grids oder beliebiges GQL.

## Eine App im Terminal bedienen {icon="terminal-2"}

Mit `cld grids apps runtime read <app-id> --json` und der ID aus der App-URL findest du sichtbare Seiten, Block-IDs, Daten, Formularfelder und verfügbare Aktionen. Basiszugriff ist nicht erforderlich. Eine Detailseite öffnest du mit `--page <page-id> --params '{"request_id":"REC001"}'`. Verwende den Parameternamen und die Record-ID aus der zurückgegebenen Navigation.

Die Befehle unter `apps runtime` lesen begrenzte Datensatzseiten, senden Seiten- oder Seitenleistenformulare, ändern veröffentlichte bearbeitbare Felder, verwalten Kommentare und Anhänge, laden gespeicherte PDFs herunter, starten Aktionen oder Scanner und lesen den zugehörigen Laufstatus. `--help` erklärt die Eingaben. Seitenbezogene Befehle benötigen dieselben Parameter wie die Discovery. Senden, Ändern, Scannen und Aktionen erfordern `--yes`; Formularübermittlungen sind nicht wiederholungssicher. Verwende dieselbe Operations-ID nur für die Wiederholung derselben Aktion. „Queued“ bedeutet angenommen, nicht abgeschlossen.

Es gelten dieselben veröffentlichten App-Berechtigungen wie im Browser. Die Befehle öffnen keine rohe Basis, umgehen keine ausgeblendeten Blöcke und erlauben kein beliebiges GQL.

## Seiten und Blöcke {icon="layout"}


Eine App darf bis zu 12 responsive Seiten enthalten. `startPageId` legt die Seite fest, die unter `/apps/<id>` erscheint. Seiten mit `navigation.visible: true` erscheinen in Array-Reihenfolge in der Seitenleiste des AppWorkspace und können ein Tabler-`icon` besitzen. Wenn die aktuelle Seite keine weitere verfügbare Seite und die App keine verfügbare globale Aktion besitzt, wird die Seitenleiste ausgelassen.

Die optionale Liste `sidebar.actions` auf Wurzelebene ergänzt appweite Launcher, die von allen Seiten unabhängig sind:

- Ein **Formular** öffnet sich in einem großen Dialog und kann öffentlichen lesenden Personen der App zur Verfügung stehen.

Globale Launcher erhalten bewusst keine Seiten-, Routen-, Datensatz- oder ausgewählten Zeilenwerte. Ihre festen Formularwerte verwenden `LITERAL` oder eine kompatible Bindung `AUTH.currentUser`. Ihr `availableWhen`-GQL darf `@auth.*`, `@app.*`, `@base.*` und `@time.*` verwenden. `@page.*` und `@params.*` führen zu einem Validierungsfehler. Der Server prüft die exakte veröffentlichte Formular-Capability und Verfügbarkeit unmittelbar vor dem Absenden erneut.

Eine Spalte darf enthalten:

- **Markdown** für Überschriften, Anweisungen, Links und Platzhalter aus dem Anfragekontext;
- **Formular** zum Erstellen eines Datensatzes mit einem vorhandenen aktiven Grids-Formular;
- **Datensätze** für bis zu 100 Zeilen aus einer gespeicherten Ansicht oder begrenztem GQL; Tabellen können eine ausdrückliche Feldteilmenge des ausgewählten Ergebnisses darstellen;
- **Referenzierte Datensätze** auf einer Record-Seite für Zeilen aus einer festgeschriebenen Tabelle, deren festgeschriebene Relation auf den aktuellen Datensatz zeigt;
- **Kennzahlen** für benannte skalare Aggregate aus einer gespeicherten Ansicht oder begrenztem GQL;
- **Diagramm** für gruppierte Aggregatergebnisse als unterstütztes Diagramm;
- **Datensatz** für eine ausdrückliche Feld-Erlaubnisliste des aktuellen Detaildatensatzes;
- **Gerendertes HTML** für ein vorhandenes HTML-Vorlagenfeld des aktuellen Detaildatensatzes;
- **Kommentare** für die Diskussion einer angemeldeten lesenden Person der App am aktuellen Detaildatensatz;
- **Aktionen** für interne Navigation oder einen exakten veröffentlichten Workflow-Launcher;
- **Scanner** für eine angemeldete Workflow-Oberfläche mit Kamera oder manueller Codeeingabe, die auf einer exakten Scanner-Ausführungsoption basiert.

Detailseiten für Datensätze sind reine Routenseiten. Sie deklarieren einen erforderlichen `record`-Parameter, binden ihn als Seitendatensatz und setzen `navigation.visible: false`. Ein Datensatzblock kann seine Zeilen-ID oder ein ausgewähltes Einzelrelationsfeld mit `rowNavigate` diesem Parameter zuordnen. Grids erstellt dann die URL und autorisiert den Datensatz beim Öffnen der Detailseite.

Eine reine Routenseite kann auch einen Record-Parameter deklarieren, ohne ihn als Seitendatensatz zu laden. Das ist nützlich, wenn begrenztes Datensatz-GQL oder ein Formular übergeordneten Kontext benötigt, zum Beispiel eine Beschreibungsliste, während mehrere zugehörige Artikel eingegeben werden.

Skripte, von der App verfasstes Inline-HTML und CSS sowie beliebige URLs werden nicht unterstützt. Ein Block für Gerendertes HTML kann ein getrennt verwaltetes HTML-Vorlagenfeld in einer nicht interaktiven Sandbox anzeigen. Er kann weder externe Ressourcen abrufen noch auf die umgebende App zugreifen. Datensatzblöcke dürfen nur ausdrücklich angezeigte und erlaubte Felder oder Anhänge bearbeiten. Aktionen setzen interne Navigation und vorhandene validierte Workflow-Launcher zusammen, statt Datensätze direkt zu verändern.

## Eine Listen- und Detail-App erstellen {icon="terminal-2"}

Du benötigst **Verwalten**-Zugriff auf die Basis der App. Beginne mit den öffentlichen IDs aus sechs Zeichen für Basis, gespeicherte Ansicht, Tabelle und die Felder, die du anzeigen möchtest.

```yaml
schemaVersion: 5
kind: grids.custom-app
id: app001
baseId: bas001
name: Request overview
icon: app-window
startPageId: home
sidebar:
  actions:
    - id: create-request
      kind: form
      label: New request
      icon: plus
      tone: success
      formId: frm001
      fixedValues: {}
pages:
  - id: home
    title: My requests
    navigation:
      visible: true
    rows:
      - id: content
        columns:
          - id: main
            span: 12
            blocks:
              - id: intro
                type: markdown
                markdown: "# My requests"
              - id: apply
                type: form
                title: New request
                formId: frm001
                fixedValues: {}
                onSuccessNavigate:
                  kind: navigate
                  pageId: request
                  params:
                    request_id:
                      source: RESULT
                      path: recordId
              - id: requests
                type: records
                searchable: true
                pageSize: 25
                title: Recent requests
                source:
                  kind: view
                  viewId: viw001
                display:
                  kind: table
                  columnIds:
                    - fld001
                rowNavigate:
                  kind: navigate
                  pageId: request
                  history: push
                  params:
                    request_id:
                      source: ROW
                      path: id
  - id: request
    title: Request detail
    navigation:
      visible: false
    parameters:
      request_id:
        type: record
        tableId: tbl001
        required: true
    record:
      tableId: tbl001
      id:
        source: PARAMS
        path: request_id
    rows:
      - id: detail
        columns:
          - id: main
            span: 12
            blocks:
              - id: request-details
                type: record
                title: Request
                fieldIds:
                  - fld001
                editableFieldIds:
                  - fld001
                documents:
                  templateIds:
                    - tpl001
```

Formular, gespeicherte Ansicht und Parameter `request_id` müssen dieselbe Datensatztabelle verwenden. Nach erfolgreichem Absenden ersetzt Grids die aktuelle URL durch die Detailseite des neuen Datensatzes. Das Anklicken einer vorhandenen Zeile öffnet dieselbe Detailseite.

Der Datensatzblock kann außerdem vorhandene PDFs auflisten, die für diesen Datensatz mit einer exakten Vorlagen-ID erzeugt wurden. Die Generierung bleibt Aufgabe eines Workflows. Der Block bietet Downloads nur an, wenn die veröffentlichte App-Capability diese Vorlage enthält und die aktuelle App-Freigabe gültig ist.

`editableFieldIds` darf gewöhnliche beschreibbare Felder und angezeigte Dateifelder enthalten. Gewöhnliche Werte verwenden die versionierte Datensatzaktualisierung. Angemeldete lesende Personen der App verwenden den vorhandenen Anhangsdienst über App-begrenzte Routen für Auflisten, Hochladen, Herunterladen und Löschen. Die App-Freigabe stellt die Datensatz-API der Basis nicht bereit. Grenzen für Dateityp, Anzahl und Größe stammen weiterhin aus dem aktiven Feld und den Grids-Einstellungen.

Ein Formularblock kann Eingabefelder verbergen und mit typisierten Bindungen bereitstellen. `LITERAL`-Werte werden gegen den aktiven Feldtyp validiert. Kompatible Relationseingaben können einen deklarierten Record-Parameter oder den aktuellen Seitendatensatz verwenden. Principal-Eingaben können die aktuell angemeldete Person verwenden. Der Server löst jeden Wert erneut auf und lehnt Versuche des Browsers ab, ihn zu überschreiben:

```yaml
fixedValues:
  tpl001:
    source: PARAMS
    path: parent_id
```

`fixedValues` akzeptiert `LITERAL`, kompatible `PARAMS`, kompatibles `RECORD.id` und `AUTH.currentUser` für Principal-Felder. Appweite Seitenleistenformulare akzeptieren `LITERAL` und `AUTH.currentUser`, aber niemals Seiten- oder Zeilenkontext. Die Erfolgsnavigation akzeptiert deklarierte `PARAMS` und `RESULT.recordId` des abgesendeten Formulardatensatzes. Sie bleibt immer innerhalb derselben Grids App und verwendet Ersetzen-Navigation.

Seiten, Blöcke und Aktionen dürfen eine optionale `availableWhen.query` verwenden. Der Server führt dieses begrenzte GQL mit demselben impliziten Kontext wie die Seite aus. Mindestens eine zurückgegebene Zeile bedeutet verfügbar. Ein leeres Ergebnis, eine ungültige Abfrage, fehlender Kontext, eine Zeitüberschreitung oder ein Abbruch bedeutet nicht verfügbar. Nicht verfügbare Ressourcen werden ausgelassen und können nicht direkt aufgerufen werden.

GQL in Grids Apps erhält automatisch `@auth.id`, `@auth.name`, `@auth.username`, `@auth.email`, `@auth.subjects`, deklarierte `@params.<name>`, `@page.*`, `@app.*`, `@base.*` und `@time.*`. Anonyme Besucher erhalten `null` für skalare `@auth.*`-Werte und `[]` für `@auth.subjects`. Die Subjektliste enthält ausschließlich UUIDs: die aktuelle Person und wirksame direkte oder verschachtelte Gruppen. Nutze sie in einem Mitgliedschaftsprädikat wie `oneof(Participants, @auth.subjects)`. Werte werden getrennt vom Abfragetext gebunden; es gibt keine Eingabezuordnung pro Quelle und keine Hilfsfunktion `param()`.

Markdown-Blöcke verwenden dieselben Kontextnamen als sichere Textplatzhalter. Gib `@` ein oder wähle **Platzhalter hinzufügen**, zum Beispiel `Hello @auth.name`. Grids ersetzt bekannte Platzhalter vor dem Rendern des bereinigten Markdown auf dem Server. Anonyme `@auth.*`-Werte werden zu leerem Text. Markdown-Platzhalter ergänzen keine Liquid-Bedingungen, Schleifen oder ausführbaren Vorlagencode.

Prüfe zuerst den aktuellen Vertrag und validiere und plane anschließend die Datei:

```bash
cld grids apps reference
cld grids apps validate MyBase --source-file requests.yaml
cld grids apps plan MyBase --source-file requests.yaml
```

Führe `cld grids apps create MyBase --name "Request overview"` aus, um einen leeren Startseitenentwurf zu erstellen, der dem visuellen Starter entspricht. Fortgeschrittene Personen können eine vollständige Definition direkt anwenden.

Wende die Definition an. Dadurch wird nur der Entwurf aktualisiert:

```bash
cld grids apps apply MyBase --source-file requests.yaml
```

Die ID der Definition aus sechs Zeichen ist die stabile öffentliche ID und das Routensegment der App. Spätere Anwendungen behalten sie bei; `apps export` enthält dieselbe `id`.

## Visuell erstellen {icon="apps"}

**App-Einstellungen** öffnet einen Dialog mit **Allgemein**, **Zugriff** und **Lebenszyklus**. Name und Symbol gehören zum selben automatisch gespeicherten Entwurf; das Schließen der Einstellungen verwirft sie nicht. Speicherfehler bleiben im Builder sichtbar.

Wähle unter **Aktionen** einen vorhandenen Eintrag, um diese Seitenleistenaktion im Inspektor zu bearbeiten. **Neue Aktion** erstellt eine Formularaktion und wählt sie sofort aus. Beschriftung, Symbol, Darstellung, Formular, feste Werte, Ziel nach dem Absenden, Verfügbarkeit und Entfernen findest du dort, nicht in den App-Einstellungen. Die veröffentlichte Aktion behält ihr konfiguriertes Aussehen.

Personen mit Verwaltungsrechten für die Basis können den **Bearbeitungsmodus** aktivieren und mit **Neue App** unter **Apps** eine App erstellen. Die Spalte Seiten erstellt und wählt Seiten aus. Jede Seite und die aktive App besitzen eine eigene Einstellungsaktion. **Block hinzufügen** unterstützt Markdown, Datensätze, Referenzierte Datensätze, Kennzahlen, Diagramme, Formulare, Datensatzdetails, Kommentare, Aktionen und Scanner. Datensätze, Kennzahlen und Diagramme können eine zugängliche gespeicherte Ansicht oder Inline-GQL verwenden. Referenzierte Datensätze erscheint auf Record-Seiten, wenn eine andere Tabelle eine Relation zur Tabelle dieser Seite besitzt. Scanner erscheint, wenn eine aktivierte Scanner-Ausführungsoption eine bereite Workflow-Revision besitzt.

Der Inspektor hält den häufigen Ablauf kurz. Felder für Seite, Quelle und Block bleiben sichtbar. Verfügbarkeit, Routenparameter, Darstellung, Reihenfolge und Dokumente verwenden aufklappbare Bereiche. Optionale Verfügbarkeit zeigt **Immer**, bis du eine serverseitig durchgesetzte GQL-Regel ergänzt. Inline-GQL und Markdown können jeweils in einem größeren Editor geöffnet werden, ohne einen zweiten Entwurf oder einen getrennten Speicherschritt zu erstellen. Die Autovervollständigung bietet weiterhin nur den auf der ausgewählten Seite gültigen Kontext `@auth`, `@params`, `@page`, `@app`, `@base` und `@time` an.

Routenparameter sind erforderliche Record-IDs mit jeweils einer Parameter-ID und Record-Tabelle. Das Hinzufügen eines Datensatzblocks bindet die Seite an ihren einzelnen kompatiblen Routenparameter, verbirgt die Seite in der Navigation und stellt denselben Datensatz für Datensatz- und Kommentarblöcke bereit. Es gibt keine zweite Einstellung für den Seitendatensatz. Das Umbenennen eines Parameters aktualisiert seine typisierten Formular-, Navigations-, Workflow-, Zeilenaktions- und exakten GQL-Referenzen `@params.<name>`. Seiten-IDs sind bearbeitbar und ihre Navigationsreferenzen werden mit ihnen aktualisiert. Datensatzzeilen können zu kompatiblen Routenseiten verlinken oder mehrere Zeilenworkflows ausführen. Formulare können typisierte serverseitig vertrauenswürdige Werte erhalten und nach der Erstellung navigieren. Datensatzblöcke können beschreibbare Felder und Dokumentvorlagen auswählen.

Wähle bei einem Datensatzblock mit gespeicherter Ansicht eine Auswahl von Tabellenfeldern oder verwende die vorhandene Kartenkonfiguration der Ansicht. Karten behalten die konfigurierten Felder und das Dateicover der Ansicht, können schreibgeschützt sein, zu einer Zeilenseite führen oder dieselben Zeilenworkflows wie eine Tabelle anbieten und werden bei der Veröffentlichung festgeschrieben. Eine GQL-Datensatzquelle zeigt genau die gewöhnlichen Datensatzspalten einschließlich Aliasnamen, die ihre Abfrage zurückgibt, und benötigt deshalb keine zweite Spaltenauswahl. Nutze Kennzahlen oder Diagramm für Aggregatergebnisse.

Referenzierte Datensätze schreibt Quelltabelle, Relationsfeld, angezeigte Felder, Tabellen- oder Kartendarstellung, Sucheinstellung, Seitengröße und Zeilenaktionen fest. Die generierte Abfrage verwendet den Parameter der aktuellen Record-Seite und die vorhandene begrenzte GQL-Capability der Custom App. Verfassende Personen pflegen keine zweite Abfrage. Eine Änderung oder Entfernung der Relation macht den Entwurf ungültig, bis er korrigiert und erneut veröffentlicht wird.

Ein Aktionsblock zeigt eine kompakte Liste. Öffne eine Aktion, um Symbol, Ziel, Verlauf, typisierte Parameterzuordnungen, Workflow-Launcher, Eingabequellen, Bestätigung, Verfügbarkeit und Reihenfolge zu bearbeiten. Workflow-Aktionen listen nur aktive Launcher für Grids Apps auf, deren validierte Workflow-Revision in der aktuellen Basis verfügbar ist.

Ein Datensatzblock besitzt einen getrennten Bereich **Zeilenaktionen** für Tabellen- und Kartendarstellung. Jede Aktion wählt Launcher, Bezeichnung, optionales Symbol, Sichtbarkeit der Bezeichnung, typisierte Eingaben, Bestätigung, Verfügbarkeit und Reihenfolge. `ROW.id` erscheint nur hier und nur für eine kompatible Datensatzeingabe. Die Laufzeit prüft vor dem Ausführen des Workflows, ob die ausgewählte ID noch im exakten veröffentlichten Datensatz-Abfrageergebnis vorhanden ist.

Der Builder speichert jede strukturell vollständige Änderung automatisch. Ein Hinweis erscheint, solange der Entwurf von der aktiven Version abweicht oder Aufmerksamkeit benötigt. **Änderungen veröffentlichen** validiert und veröffentlicht den zuletzt gespeicherten Entwurf. **Aktive Version wiederherstellen** verwirft ausstehende Entwurfsänderungen und kopiert den aktuellen aktiven Snapshot zurück in den Entwurf. Das Symbol für einen externen Link öffnet den aktiven Snapshot. Vorschauen gespeicherter Ansichten und parameterloser GQL-Abfragen werden auf dem Server aufgelöst. Die Arbeitsfläche lässt unveränderte Blöcke eingebunden, während ein benachbarter Block bearbeitet wird. Unter **App-Einstellungen → Lebenszyklus** kann die **Gefahrenzone** den aktiven Snapshot zurückziehen und Entwurf sowie Freigaben behalten oder die App löschen, ohne Basisdaten zu löschen. Beide Aktionen erfordern eine destruktive Bestätigung.

## Zugriff gewähren und veröffentlichen {icon="lock"}

Gewähre dem vorgesehenen Principal Zugriff auf die App. Der veröffentlichte Capability-Snapshot stellt Daten und Operationen bereit. Gewähre der Zielgruppe keinen unmittelbaren Basiszugriff, sofern sie nicht auch den vollständigen Grids-Arbeitsbereich benötigt.

```bash
cld grids access grant app MyBase "Request overview" --group "Request team" --permission read
cld grids access grant app MyBase "Public catalog" --public --permission read
```

Freigaben für Grids Apps unterstützen Personen, Gruppen, alle angemeldeten Konten und die Öffentlichkeit. Sie unterstützen keine Dienstkonten; delegierte Anmeldedaten verwenden ihre Personenidentität. Eine öffentliche Freigabe schließt anonyme Besucher ein. Die Detailseite gibt für eine fehlende, gelöschte, ungültige, nicht verfügbare oder nicht autorisierte Datensatz-ID **Nicht gefunden** zurück. Beliebige Workflow-Aktionen erfordern auch bei einer öffentlichen App ein angemeldetes Konto.

Veröffentliche den validierten Entwurf:

```bash
cld grids apps publish MyBase "Request overview" --yes
```

Das Anwenden eines weiteren Entwurfs ändert die aktive App erst bei der nächsten Veröffentlichung.

Wiederherstellen ersetzt ausstehende Entwurfsänderungen durch die aktive Definition. Veröffentlichung aufheben entfernt nur den aktiven Snapshot und behält den Entwurf. Löschen entfernt die App und ihre Route. Diese Befehle erfordern eine ausdrückliche Bestätigung:

```bash
cld grids apps restore MyBase "Request overview" --yes
cld grids apps unpublish MyBase "Request overview" --yes
cld grids apps delete MyBase "Request overview" --yes
```

## Veröffentlichung vorhersehbar halten {icon="versions"}

`validate` prüft die strikte Definition, Referenzen auf impliziten Kontext, Verfügbarkeitsabfragen und jede referenzierte Basis, Tabelle, Ansicht, jedes Formular, Feld, jede Vorlage und jeden Workflow-Launcher. Außerdem wird die Tabellenkompatibilität für Zeilennavigation, Formularergebnisse und feste Relationswerte geprüft. Unbekannte Eigenschaften werden abgelehnt. `plan` meldet `create`, `update`, `noop` oder `invalid`, ohne zu speichern. `apply` schreibt den Entwurf. `publish` ersetzt die veröffentlichte Definition und den Capability-Snapshot atomar durch den aktuellen gültigen Entwurf.

```bash
cld grids apps list MyBase
cld grids apps get MyBase "Request overview"
cld grids apps export MyBase "Request overview" --out requests.yaml
cld grids apps export MyBase "Request overview" --published --out requests-live.yaml
```

:::note Nur die aktive Seite wird aufgelöst
Beim Öffnen einer Seite werden nur ihre Blöcke und ihr optionaler Seitendatensatz geladen. Verborgene Detailseiten werden nicht vorgeladen. So bleiben große Apps vorhersehbar, ohne aktuelle Zugriffsprüfungen abzuschwächen.
:::
