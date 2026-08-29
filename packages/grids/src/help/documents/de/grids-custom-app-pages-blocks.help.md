---
id: grids-custom-app-pages-blocks
title: Seiten und Blöcke in Grids Apps
icon: ti ti-layout-grid
description: Responsive Seiten aus typisierten, ressourcenbasierten Blöcken zusammensetzen.
order: 134
---
Eine Grids App ist eine kleine Zusammenstellung vorhandener Grids-Ressourcen. Ihr Seitenbaum steuert Layout und Navigation. Ihre Blöcke legen fest, welche Ressourcen erscheinen und welche bereits definierten Operationen eine Person starten darf.

## Stabile Definitions-IDs verwenden {icon="id"}

Apps, Seiten, Zeilen, Spalten, Blöcke und Aktionen besitzen stabile IDs. Bezeichnungen dürfen sich ändern, ohne Links oder Zustand zu beschädigen.

- Die App-ID ist eine unveränderliche öffentliche ID aus sechs Zeichen.
- IDs von Seiten, Zeilen, Spalten, Blöcken und Aktionen sind lokale Bezeichner in Kleinschreibung, die innerhalb ihres übergeordneten Elements eindeutig sind.
- Ressourcenreferenzen verwenden kanonische öffentliche Grids-IDs und niemals Anzeigenamen.

Eine Seitenroute lautet `/apps/<id>/<pageId>`. Deklarierte Seitenparameter sind Abfrageparameter, zum Beispiel `/apps/a1b2c3/request?request_id=<record-id>`.

Die App-Identität ist bewusst auf einen Namen und ein unterstütztes Symbol begrenzt. Seiten und Blöcke verwenden die üblichen Schrift-, Abstands-, Farb- und Interaktionsmuster von Cloud. Eigenes CSS und beliebiges Branding gehören nicht zur Definition.

## Seitenkontext deklarieren {icon="brackets"}

Eine Seite deklariert jeden URL-Parameter, bevor ein Block ihn verwenden kann. Diese Version unterstützt nur erforderliche Record-Parameter. Jeder Parameter deklariert eine Tabelle derselben Basis. Seine URL und sein Wert `@params.<name>` sind öffentliche Datensatz-IDs. Der Server prüft vor dem Laden der Seitendaten, ob der referenzierte Datensatz zu dieser Tabelle gehört.

Eine Seite kann einen **Seitendatensatz** aus einem Record-Parameter laden. Füge im visuellen Builder die Parameter-ID und Record-Tabelle unter **Routenparameter** hinzu und anschließend einen Datensatz- oder Gerendertes-HTML-Block. Grids bindet denselben Parameter automatisch, statt ein zweites Steuerelement für den Seitendatensatz anzubieten. Das Laden wird auf Berechtigungen geprüft und schließt im Fehlerfall. Ein ungültiger, fehlender, gelöschter oder unzugänglicher Datensatz zeigt den einheitlichen Nicht-verfügbar-Zustand der Seite, ohne den konkreten Fall offenzulegen.

Eine reine Routenseite kann den deklarierten Record-Parameter stattdessen als Kontext behalten, ohne den Datensatz darzustellen. GQL für Datensätze und feste Formularwerte können dann dieselbe autorisierte übergeordnete ID wiederverwenden. Seiten mit erforderlichen Parametern erscheinen nie in der Navigation und können nicht die Startseite der App sein. Der visuelle Builder deaktiviert deshalb **Record-Parameter hinzufügen** auf der aktuellen Startseite und erklärt, dass zuerst eine andere Seite ohne Parameter zur Startseite werden muss.

Implementierte Blöcke binden kontextbezogene Datensatzwerte über eine typisierte Referenz:

```yaml
source: PARAMS
path: request_id
```

| Quelle | Verfügbar in | Beispielpfad |
| --- | --- | --- |
| `PARAMS` | Aktuelle Seite | `request_id` |
| `RECORD` | Aktueller Seitendatensatz | `id` |
| `ROW` | Zeilenlink oder Zeilenaktion eines Datensatzblocks | `id` |
| `RESULT` | Navigation nach erfolgreichem Formular | `recordId` |

Der Builder zeigt nur Referenzen, die am aktuellen Ort gültig sind. Die YAML-Validierung wendet dieselben Bereichs- und Typregeln an. Referenzen können weder beliebige URL-Werte noch den internen Zustand eines anderen Blocks oder nicht deklarierte Daten lesen.

## Responsive Zeilen und Spalten erstellen {icon="columns"}

Jede Seite enthält Zeilen, jede Zeile Spalten und jede Spalte Blöcke. Eine Spaltenbreite ist eine ganze Zahl von 1 bis 12. Spalten behalten ihre Reihenfolge und werden in voller Breite untereinander angeordnet, wenn der verfügbare Platz zu schmal ist.

Nutze das einfachste Layout, das die Reihenfolge der Aufgabe erhält:

- 12 für eine primäre Aufgabe;
- 8 + 4 für Hauptinhalt und ergänzenden Kontext;
- 6 + 6 für zwei gleichrangige Inhalte;
- mehrere kleine Spalten für kompakte Kennzahlen.

Definiere keine getrennten Desktop- und Mobil-Layouts. Prüfe denselben Entwurf vor der Veröffentlichung bei breiten und schmalen Arbeitsbereichsgrößen.

## Ressourcenbasierte Blöcke konfigurieren {icon="blocks"}

### Markdown

Markdown stellt Überschriften, Listen, Links und sichere Bilder dar. Es führt weder HTML, Skripte oder Stile noch eingebetteten Anwendungscode aus. Der Inline- und der große Editor vervollständigen Platzhalter für `@auth`, `@params`, `@page`, `@app`, `@base` und `@time` der aktuellen Seite. `Hello @auth.name` fügt zum Beispiel den Anzeigenamen der angemeldeten Person auf dem Server ein. Anonyme Authentifizierungswerte werden zu leerem Text. Eingefügte Werte werden vor dem Rendern von Markdown maskiert. Liquid-Bedingungen oder -Schleifen gibt es nicht.

### Datensätze

Datensätze liest entweder eine vorhandene gespeicherte Ansicht oder eine Inline-GQL-Abfrage. Eine gespeicherte Ansicht kann eine ausdrückliche Auswahl von Tabellenfeldern verwenden oder die vorhandene Kartenkonfiguration dieser Ansicht einschließlich ihres Dateicovers wiederverwenden. Karten können schreibgeschützt sein, zu einer Zeilenseite navigieren oder Zeilenaktionen anbieten und werden bei der Veröffentlichung mit der gespeicherten Ansicht festgeschrieben. Inline-GQL zeigt die ausgewählten gewöhnlichen Datensatzspalten einschließlich Aliasnamen. Eine nicht leere Tabellenliste `columnIds` kann ausgewählte Feldspalten für Verhalten verfügbar halten, während nur die aufgeführten Feld-IDs sichtbar sind. Nutze Kennzahlen oder Diagramm für Aggregatergebnisse. Beide Datensatzquellen unterstützen einen Leertext, optionale Zeilennavigation und optionale serverseitige Suche.

`pageSize` legt fest, wie viele Zeilen der Server auf einmal zurückgibt. Lesende Personen bewegen sich durch geschützte Cursor-Seiten. Suche und Seitennavigation laufen auf dem Server und laden nie das vollständige Ergebnis in den Browser. Ein GQL-`limit` begrenzt das vollständige Ergebnis, wenn die verfassende Person bewusst nur die ersten N passenden Zeilen benötigt. Gemeinsame Abfragebudgets werden unabhängig davon durchgesetzt.

Eine Inline-Abfrage erhält automatisch den typisierten Kontext `@auth.id`, `@auth.name`, `@auth.username`, `@auth.email`, `@auth.subjects`, `@params`, `@page`, `@app`, `@base` und `@time`. `@auth.subjects` enthält die UUID der angemeldeten Person und die UUIDs wirksamer Gruppen; für anonyme Personen ist die Liste leer. Werte werden getrennt vom Abfragetext gebunden. Unbekannte Namensräume und nicht deklarierte Seitenparameter verhindern die Veröffentlichung.

Nutze `ROW.id` nur für den Zeilenlink oder die Workflow-Zeilenaktionen dieses Datensatzblocks. Ein Zeilenlink kann stattdessen `{ source: ROW, path: relation, fieldId: ... }` binden, wenn das Feld eine ausgewählte einzelne Relation zur Tabelle des Zielparameters ist. Vor dem Start des Workflows wird eine Zeilenaktion gegen das exakte veröffentlichte Abfrageergebnis geprüft. Konfiguriere bis zu sechs Aktionen mit einer erforderlichen zugänglichen Bezeichnung und einem optionalen Symbol. Tabellen und Karten können Bezeichnung, Symbol oder beides zeigen.

### Referenzierte Datensätze

Referenzierte Datensätze ist nur auf einer Record-Seite verfügbar. Der Block zeigt Zeilen aus einer festgeschriebenen Quelltabelle, deren festgeschriebenes Relationsfeld den aktuellen Seitendatensatz enthält. Wähle im Block die exakten sichtbaren Felder, Tabellen- oder Kartendarstellung, Suche, Seitengröße und optionale Zeilenworkflows. Die Veröffentlichung kompiliert dies in dieselbe begrenzte GQL- und `recordQueries`-Capability wie bei Datensätzen. Die App-Freigabe bleibt die äußere Zugriffsgrenze. Der Block erweitert den Seitendatensatz nicht und gibt keine uneingeschränkte Rückwärtssuche frei.

### Kennzahlen und Diagramm

Kennzahlen und Diagramm lesen entweder eine vorhandene gespeicherte Ansicht oder eine Inline-GQL-Abfrage. Die Laufzeit wendet gemeinsame Abfragebudgets an.

Kennzahlen akzeptiert eine nicht gruppierte Aggregatabfrage und stellt bis zu 12 benannte skalare Ergebnisse dar. Diagramm akzeptiert eine gruppierte Aggregatabfrage und stellt ein Ring-, Balken- oder Liniendiagramm mit mindestens einer Aggregatwertreihe dar. Ein Diagrammblock darf über sein `limit` höchstens 100 Gruppen darstellen.

Die veröffentlichte Capability zeichnet die exakten Tabellen und Felder hinter dem Block auf. Lesende Personen der App benötigen keinen Basiszugriff. Die Laufzeit kann keine Quellen außerhalb dieser unveränderlichen Capability abfragen. Veröffentliche nach einer Änderung der Quelle einer gespeicherten Ansicht erneut.

### Formular

Formular referenziert ein vorhandenes Grids-Formular. Das Formular ist für sichtbare Felder, Validierung, Pflichtfelder, Standardwerte und Datensatzerstellung verantwortlich.

Der Block kann vertrauenswürdige Werte für jedes Eingabefeld bereitstellen. Nutze `LITERAL` für einen validierten festen Wert. Kompatible Relationsfelder können einen deklarierten Record-Wert aus `PARAMS` oder `RECORD.id` des aktuellen Seitendatensatzes verwenden. Ein Principal-Feld kann mit `AUTH.currentUser` die angemeldete Person zuweisen, ohne einen weiteren Picker anzuzeigen. Bereitgestellte Eingaben fehlen im dargestellten Formular, werden erneut vom Server aufgelöst und können im Browser nicht überschrieben werden. Dies unterstützt Abläufe wie „weiteren Artikel zu dieser Liste hinzufügen“, ohne erneut nach derselben Relation zu fragen.

Nach Erfolg kann der Block auf der Seite bleiben oder innerhalb derselben App mit Ersetzen navigieren. Navigationsparameter können deklarierte `PARAMS`-Werte beibehalten oder `RESULT.recordId` des erstellten Formulardatensatzes verwenden.

Eine App darf bis zu 24 Formularblöcke veröffentlichen. Jedes referenzierte Formular darf bis zu 100 Eingaben bereitstellen, von denen die Seite bis zu 30 vorgeben darf.

### Datensatz

Datensatz erfordert einen Seitendatensatz. Der Block stellt die ausdrückliche Liste `fieldIds` dar und kann direkte Bearbeitung über eine ausdrückliche Teilmenge `editableFieldIds` erlauben. Jedes bearbeitbare Feld muss auch angezeigt werden und ein beschreibbares gespeichertes Feld sein. Berechnete und Systemfelder verhindern die Veröffentlichung.

Die Aktion Bearbeiten erscheint nur, wenn die Veröffentlichung dieses beschreibbare Feld enthält und der Block verfügbar ist. Beim Absenden prüft Grids erneut App-Freigabe, unveränderliche Feld-Erlaubnisliste, `availableWhen`, aktiven Feldtyp, Audit-Fragen der Tabelle und aktuelle Datensatzversion. Felder außerhalb der bearbeitbaren Teilmenge des Blocks bleiben schreibgeschützt.

Ein bearbeitbares Dateifeld verwendet denselben auditierten Lebenszyklus für Hinzufügen, atomisches Ersetzen und **Aus Datensatz entfernen** wie der Basis-Arbeitsbereich. Die App-Freigabe bleibt die äußere Grenze; die veröffentlichte Capability für bearbeitbare Felder grenzt sie weiter ein. Das Entfernen löst den aktuellen Anhang. Geschützte Historie oder Artefakte können die exakten Bytes behalten, während ungeschützte Dateien bereinigt werden können.

Eine optionale Erlaubnisliste `documents.templateIds` zeigt vorhandene generierte PDFs, die mit dem aktuellen Datensatz verknüpft sind. Jede Vorlage muss bei der Veröffentlichung zur Tabelle des Seitendatensatzes gehören. Die Laufzeit verwendet die unveränderliche Capability und die geschützte Route zum Herunterladen von Dokumenten. Der Block generiert keine Dokumente und erstellt keine öffentlichen Links. Nutze für die Generierung einen Workflow.

### Gerendertes HTML

Gerendertes HTML erfordert einen Seitendatensatz und referenziert genau ein Feld vom Typ `html_template` aus dessen Tabelle. Der Block stellt den bereits gerenderten Wert dar, ohne benachbarte Datensatzfelder offenzulegen. Wähle die Höhe `compact`, `normal` oder `large`; der Iframe passt seine Größe nicht an den Vorlageninhalt an.

Die Ausgabe läuft in einer Sandbox ohne Skripte, Formulare, Pop-ups, Zugriff auf die übergeordnete Seite oder Zeigerinteraktion. Eine standardmäßig verweigernde Inhaltsrichtlinie blockiert außerdem externe Bilder, Schriftarten, Medien, Frames, Verbindungen und Navigation. Nur Inline-Stile und `data:`-Bilder sind verfügbar. Nutze einen Datensatz-, Formular- oder Aktionsblock für Interaktionen. Eine Änderung des Feldtyps, das Entfernen des Felds oder ein Fehler beim Rendern der Vorlage erzeugt einen lokalen Nicht-verfügbar-Zustand. Die App-Seite fällt niemals auf rohes HTML zurück.

### Kommentare

Kommentare erfordert einen Seitendatensatz und eine angemeldete Person mit Lesezugriff auf die App. Der Block lädt beim Darstellen eine begrenzte erste Seite und ruft ältere Kommentare anschließend mit Keyset-Seitennavigation ab. Der veröffentlichte Kommentarblock und die aktuelle App-Freigabe erlauben das Erstellen von Kommentaren ohne Schreibzugriff auf Basis oder Datensatz. Verfassende Personen können ihre eigenen Kommentare bearbeiten und löschen. Personen mit Verwaltungsrechten für die Basis können alle Kommentare moderieren. Gelöschte Kommentare bleiben als Platzhalter mit Zeitstempel erhalten, damit die Gesprächsreihenfolge verständlich bleibt.

Kommentare übernehmen die Sichtbarkeit des Datensatzes. Sie führen weder eine eigene Zielgruppe noch einen eigenen Berechtigungsspeicher ein.

### Aktionen

Aktionen enthält Schaltflächen, die entweder innerhalb derselben Grids App navigieren oder einen vorhandenen aktivierten Workflow-Launcher für Grids Apps starten. Eine Workflow-Aktion kann JSON-Werte aus `LITERAL`, deklarierte Record-Werte aus `PARAMS` oder `RECORD.id` des aktuellen Seitendatensatzes an kompatible Workflow-Eingaben binden. Feste Launcher verwenden ihre gespeicherten Bindungen und akzeptieren keine Aktionseingaben.

Der Block kann keine beliebigen URLs aufrufen, Datensätze direkt aktualisieren oder einen Workflow ausführen, der nicht in der veröffentlichten Capability-Menge enthalten war.
Das Starten eines Workflows erfolgt asynchron. Die Schaltfläche verfolgt ihre eingegrenzte Ausführung und zeigt bei Erfolg oder Fehler die bereinigte Ergebnismeldung des Workflows. Sie legt weder den allgemeinen Workflow-Verlauf noch rohe Fehler offen. Navigation nach einem Workflow gehört in den Workflow oder einen späteren Übergang des Seitenzustands. Aktionen bindet keine beliebigen Workflow-Ergebnisse.

Die Laufzeit validiert die veröffentlichte App-Freigabe, exakte Seite, Block, Aktion, Launcher, Workflow-Revision, Seitendatensätze und `availableWhen`-Abfrage erneut. Eine Aktion, die in der unveränderlichen Capability-Menge der Veröffentlichung fehlt, wird ausgelassen. Workflow-Aktionen erfordern ein angemeldetes Konto.

### Scanner

Scanner bettet eine vorhandene aktivierte Scanner-Ausführungsoption ein. Angemeldete lesende Personen der App können mit der Kamera scannen oder einen Code manuell eingeben. Öffentliche anonyme Personen sehen stattdessen eine Aufforderung zur Anmeldung. Sitzungswerte werden einmal beim Öffnen des Scanners abgefragt, Werte nach dem Scan für jeden Code.

Die App veröffentlicht den exakten Block, Launcher, die Workflow-Revision und den Hash der Scanner-Konfiguration. Jeder Aufruf und jedes Lesen des Status prüft diesen Snapshot und die App-Freigabe der lesenden Person erneut. Eine Änderung der Ausführungsoption oder des Workflows erfordert eine erneute Veröffentlichung der App. Ergebnisse von Scanner-Ausführungen bleiben auf die Person begrenzt, die sie gestartet hat.

Scannerblöcke unterstützen skalare Sitzungs- und Nach-dem-Scan-Eingaben. Eingaben für Datensätze und Datensatzlisten bleiben im vollständigen Workflow-Scanner verfügbar, werden in einem eingebetteten App-Scanner aber abgelehnt, weil eine lesende Person der App möglicherweise keinen unmittelbaren Basiszugriff auf einen Datensatz-Picker besitzt. Die gescannte Eingabe selbst kann weiterhin über einen generierten Scan-Code oder ein konfiguriertes eindeutiges Feld zu einem Datensatz aufgelöst werden.

## Navigation ausdrücklich definieren {icon="arrow-right"}

Navigation besitzt eine Zielseiten-ID, ein Verlaufsverhalten und eine Zuordnung für jeden Zielparameter:

```yaml
kind: navigate
pageId: request
history: push
params:
  request_id: { source: ROW, path: id }
```

Nutze `push` für normale Bewegung und `replace` nach einem erfolgreichen Erstellungsvorgang. Ein Navigationsziel ist nur gültig, wenn alle erforderlichen Zielparameter mit kompatiblen Typen bereitgestellt werden.

Behalte bei wiederholter Eingabe das übergeordnete Element als Seitenparameter bei:

```text
/apps/<id>/add-article?list_id=<record-id>
```

Das Formular setzt seine Listenrelation fest aus `PARAMS.list_id`. Nach Erfolg navigiert eine Schaltfläche mit demselben Parameter zurück auf dieselbe Seite, eine andere zu den Listendetails. Dafür ist keine appspezifische Batch- oder Assistentenkomponente erforderlich.

## Verfügbarkeit mit GQL durchsetzen {icon="adjustments"}

Eine Seite, ein Block, Formular oder eine Aktion kann eine `availableWhen.query` deklarieren. Der Server stellt denselben impliziten Kontext wie bei Datenabfragen bereit. Die Ressource ist nur verfügbar, wenn die begrenzte Abfrage mindestens eine Zeile zurückgibt.

```yaml
availableWhen:
  query: |
    from table "Certificate requests"
    where record.id = @params.request_id and Status = 'Submitted'
    limit 1
```

Ein leeres Ergebnis, eine ungültige Abfrage, fehlender Kontext, eine Zeitüberschreitung oder ein Abbruch bedeutet nicht verfügbar. Die Laufzeit lässt die Ressource aus, führt ihre Datenquelle nicht aus und prüft die Schutzregel vor jeder Formulareingabe und Aktion erneut. Sichtbarkeit im Browser ist niemals die Durchsetzungsgrenze.

Im visuellen Builder bleibt die optionale Verfügbarkeit eingeklappt, bis du eine Regel hinzufügst. Ihre Zusammenfassung lautet **Immer**, **Eigene Regel** oder **Benötigt Aufmerksamkeit**. Bearbeite kurze Abfragen im Inspektor oder wähle **Großen Editor öffnen** für denselben automatisch gespeicherten Entwurfswert. Beide Editoren verwenden nur den impliziten Kontext der ausgewählten Seite. Die unmittelbare GQL-Konsole bietet den `@…`-Kontext von Grids Apps bewusst nicht an.

## Lokale Zustände gestalten {icon="info-circle"}

Jeder datenbasierte Block besitzt einen eigenen Lade-, Leer- und behebbaren Fehlerzustand. Grids stellt einheitliche Zustände für verweigerten und nicht verfügbaren Zugriff bereit. Sie verraten bewusst nicht, ob eine Ressource oder ein Datensatz existiert.

Passe einen Leertext nur an, wenn er der Person den nächsten Schritt erklärt. Ersetze keinen lokalen Leerzustand durch einen seitenweiten Ladeindikator und lasse unabhängige Blöcke nicht auf eine langsame Quelle warten.

Nur die aktive Seite wird aufgelöst. Innerhalb dieser Anfrage werden identische autorisierte Ressourcenlesevorgänge dedupliziert. Jede Quelle bleibt begrenzt.

## Bewusste Grenzen kennen {icon="barrier-block"}

Die erste Version besitzt keine appweiten Variablen, keinen allgemeinen Ausdrucksgraphen, keine wiederverwendbaren Blockdefinitionen, beliebige externe Abruf- oder Aktionsziele, basisübergreifenden Ressourcen, unmittelbaren Abfragen außerhalb von GQL, von der App verfasstes Inline-HTML, CSS, JavaScript, Liquid-Kontrollfluss oder domänenspezifische Anfrage-, Warenkorb-, Batch- oder Ausleihblöcke. Ein Block für Gerendertes HTML darf nur ein vorhandenes HTML-Vorlagenfeld auswählen. Seine Vorlage und sein CSS bleiben Eigentum dieses Felds und werden dort validiert. Bereinigtes Markdown darf weiterhin gewöhnliche Links und die dokumentierten Platzhalter des Anfragekontexts enthalten.

Setze wiederholte Abläufe aus typisierten Seitenparametern, festen Formularwerten, begrenzten Quellen, Navigation und vorhandenen Workflows zusammen. Wenn sich ein Prozess mit diesen Bausteinen nicht sicher ausdrücken lässt, erweitere die zuständige Grids-Ressource, statt appspezifisches Verhalten in die Seitenlaufzeit aufzunehmen.

Lies vor der Freigabe der App für andere Personen [Veröffentlichen und Berechtigungen](/app/grids/help/grids-publish-custom-app).
